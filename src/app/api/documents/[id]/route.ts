import { NextResponse } from "next/server";
import {
  getDocument,
  getSpaceById,
  updateDocument,
  deleteDocument,
  createChangeRequest,
  } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { notifyWebhooks } from "@/lib/webhooks";
import { notifyCrSubmitted } from "@/lib/notifications";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { requestOrigin } from "@/lib/oauth";
import { userHolds, canPublishDirectly, canSeeDrafts, spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import type { DocType, DocStatus, SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];
const STATUSES: DocStatus[] = ["draft", "published"];

function normalizeTags(input: unknown): string[] | undefined {
  if (input === undefined) return undefined;
  if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
  if (typeof input === "string")
    return input
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer", "document.read");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ doc });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor", "document.update");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const existing = await getDocument(Number(id));
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const scope = await spaceScopeFor(user);
  if (!scopeAllows(scope, existing.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!(await canEditSpace(user, existing.space_id))) {
    return NextResponse.json(
      { error: "You don't have edit access to this space." },
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // Optional move to another space — the target must exist, be visible to the
  // editor (private spaces they aren't granted look nonexistent), and be one
  // they hold edit rights on.
  let targetSpaceId = existing.space_id;
  if (body?.space_id !== undefined && body.space_id !== null) {
    const sid = Number(body.space_id);
    if (!Number.isInteger(sid) || !(await getSpaceById(sid)) || !scopeAllows(scope, sid)) {
      return NextResponse.json({ error: "That space isn't available." }, { status: 400 });
    }
    if (sid !== existing.space_id && !(await canEditSpace(user, sid))) {
      return NextResponse.json(
        { error: "You don't have edit access to the target space." },
        { status: 403 }
      );
    }
    targetSpaceId = sid;
  }
  const moving = targetSpaceId !== existing.space_id;

  // Optimistic-concurrency guard: the editor sends the updated_at it loaded.
  // If the document changed underneath (someone else saved first), refuse with
  // 409 instead of silently last-write-winning their work away. Older clients
  // that don't send the token keep the historical behavior.
  if (typeof body?.base_updated_at === "string" && body.base_updated_at) {
    const base = new Date(body.base_updated_at).getTime();
    const current = new Date(existing.updated_at).getTime();
    if (Number.isFinite(base) && Number.isFinite(current) && current > base) {
      return NextResponse.json(
        {
          conflict: true,
          error: `This document was updated by ${existing.author} while you were editing. Review the latest version before saving again.`,
          current_updated_at: existing.updated_at,
          current_author: existing.author,
        },
        { status: 409 }
      );
    }
  }

  // Resolve the proposed next state, falling back to the current values.
  const proposed = {
    title: typeof body?.title === "string" && body.title.trim() ? body.title.trim() : existing.title,
    content: typeof body?.content === "string" ? body.content : existing.content,
    summary: typeof body?.summary === "string" ? body.summary.trim() : existing.summary,
    type: (TYPES.includes(body?.type) ? body.type : existing.type) as DocType,
    status: (STATUSES.includes(body?.status) ? body.status : existing.status) as DocStatus,
    tags: normalizeTags(body?.tags) ?? existing.tags,
  };

  // A change "affects live content" if the doc is already published, if this
  // edit would publish it, or if the draft is armed with a scheduled publish —
  // its content WILL go live unreviewed when the schedule fires, so the same
  // approval rule applies. Those are the changes that require approval.
  const affectsLive =
    existing.status === "published" ||
    proposed.status === "published" ||
    (existing.status === "draft" && existing.publish_at != null);
  const canPublish = await canPublishDirectly(user, existing.space_id);

  // Scheduled publish / auto-unpublish. Validated and authorized BEFORE any
  // write, so a bad date or missing right rejects the request while the
  // document is still untouched. Firing a schedule bypasses the review queue
  // by design, so setting one requires publish rights; clearing is always
  // allowed for anyone who can edit.
  const schedulePatch: { publishAt?: string | null; archiveAt?: string | null } = {};
  for (const [key, field] of [
    ["publish_at", "publishAt"],
    ["archive_at", "archiveAt"],
  ] as const) {
    if (body?.[key] === undefined) continue;
    if (body[key] === null || body[key] === "") {
      schedulePatch[field] = null;
      continue;
    }
    const when = new Date(String(body[key]));
    if (Number.isNaN(when.getTime())) {
      return NextResponse.json({ error: `Invalid ${key.replace("_", " ")} date.` }, { status: 400 });
    }
    if (!canPublish) {
      return NextResponse.json(
        { error: "Scheduling a publish or unpublish needs publish rights." },
        { status: 403 }
      );
    }
    schedulePatch[field] = when.toISOString();
  }

  if (affectsLive && !canPublish) {
    // Editor in strict mode: queue a change request; leave the live doc untouched.
    const kind = existing.status === "draft" ? "publish" : "edit";
    const crId = await createChangeRequest({
      document_id: existing.id,
      kind,
      title: proposed.title,
      content: proposed.content,
      summary: proposed.summary,
      tags: proposed.tags,
      type: proposed.type,
      target_status: "published",
      note: String(body?.versionNote ?? "").trim(),
      created_by: user.id,
      space_id: moving ? targetSpaceId : null,
    });
    await audit({
      actor: actorFrom(user),
      action: "change_request.submit",
      targetType: "document",
      targetId: existing.id,
      targetLabel: proposed.title,
      details: { kind },
      ip: ipFrom(req),
    });
    void notifyCrSubmitted({
      spaceId: existing.space_id,
      title: proposed.title,
      actorId: user.id,
      actorName: user.name || user.username,
      origin: requestOrigin(req),
    });
    void notifyWebhooks("change_request.submitted", {
      title: proposed.title,
      kind,
      actor: user.name || user.username,
      url: `${requestOrigin(req)}/review`,
      spaceId: existing.space_id,
      spaceName: existing.space_name,
    });
    return NextResponse.json({ pending: true, changeRequestId: crId, docId: existing.id });
  }

  // Otherwise apply directly (draft edit, or a privileged/open-mode change).
  const doc = await updateDocument(existing.id, {
    ...proposed,
    space_id: targetSpaceId,
    category_id:
      body?.category_id === null || Number.isInteger(body?.category_id)
        ? body.category_id
        : undefined,
    author: user.name || user.username,
    versionNote: String(body?.versionNote ?? "").trim() || "Edited",
  });

  // Apply the (pre-validated) schedule changes.
  if (Object.keys(schedulePatch).length > 0) {
    const { setDocSchedule } = await import("@/lib/doc-schedule");
    await setDocSchedule(existing.id, schedulePatch);
  }

  // Nested pages: parent changes are organizational metadata and apply
  // directly (like categories), gated on the workspace toggle.
  let parentWarning: string | undefined;
  if (body?.parent_id !== undefined && (body.parent_id === null || Number.isInteger(body.parent_id))) {
    const { getAppSettings } = await import("@/lib/settings-store");
    if ((await getAppSettings()).nested_pages_enabled) {
      const { setParent } = await import("@/lib/doc-tree");
      parentWarning = await setParent(existing.id, body.parent_id === null ? null : Number(body.parent_id));
    }
  }

  const published = existing.status !== "published" && proposed.status === "published";
  if (published) {
    void notifyWebhooks("document.published", {
      title: proposed.title,
      actor: user.name || user.username,
      url: `${requestOrigin(req)}/doc/${existing.id}`,
      spaceId: doc?.space_id ?? existing.space_id,
      spaceName: doc?.space_name ?? existing.space_name,
    });
  }
  if (doc && doc.status === "published") {
    void notifySpaceSubscribers({
      spaceId: doc.space_id,
      spaceName: doc.space_name,
      docId: doc.id,
      title: doc.title,
      kind: published ? "published" : "updated",
      actorUserId: user.id,
      actorName: user.name || user.username,
      origin: requestOrigin(req),
    });
  }
  await audit({
    actor: actorFrom(user),
    action: published ? "document.publish" : "document.update",
    targetType: "document",
    targetId: existing.id,
    targetLabel: proposed.title,
    ip: ipFrom(req),
  });
  return NextResponse.json({ doc, parentWarning });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor", "document.delete_draft");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!(await canEditSpace(user, doc.space_id))) {
    return NextResponse.json(
      { error: "You don't have edit access to this space." },
      { status: 403 }
    );
  }

  // The guard above admitted this request on `document.delete_draft`. Taking
  // down something already live is the stronger right, so it is asked for
  // separately — and NOT via the publish helper, which treats open approval
  // mode as consent. Open mode means "no review step for publishing", not
  // "anyone may delete live content".
  if (
    doc.status === "published" &&
    !(await userHolds(user, "document.delete_published", {
      spaceId: doc.space_id,
      legacyMin: "approver",
    }))
  ) {
    return NextResponse.json(
      { error: "You don't have permission to delete a published document." },
      { status: 403 }
    );
  }

  await deleteDocument(doc.id);
  await audit({
    actor: actorFrom(user),
    action: "document.delete",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
