import { NextResponse } from "next/server";
import { getDocument, getSpaceById, updateDocument } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { notifyWebhooks } from "@/lib/webhooks";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { requestOrigin } from "@/lib/oauth";
import { canPublishDirectly, spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import type { DocType, DocStatus, SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];
const STATUSES: DocStatus[] = ["draft", "published"];
const ACTIONS = new Set(["move", "status", "type", "add_tag", "remove_tag"]);
const MAX_IDS = 200;

// Bulk metadata operations from the space table view: move, set status/type,
// add/remove a tag. Applies the same per-document rules as single-doc edits —
// space scope, edit rights, and the approval workflow (a change that affects
// live content needs publish rights; ineligible docs are skipped, not forced).
export async function POST(req: Request) {
  const gate = await apiGuard("editor", "document.update");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const action = String(body?.action || "");
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: "Unknown bulk action." }, { status: 400 });
  }
  const ids: number[] = Array.isArray(body?.ids)
    ? [...new Set<number>(body.ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))]
    : [];
  if (ids.length === 0) return NextResponse.json({ error: "No documents selected." }, { status: 400 });
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ error: `At most ${MAX_IDS} documents per operation.` }, { status: 400 });
  }

  // Validate the action's parameter once, up front.
  const scope = await spaceScopeFor(user);
  let targetSpaceId: number | undefined;
  let newStatus: DocStatus | undefined;
  let newType: DocType | undefined;
  let tag: string | undefined;
  if (action === "move") {
    targetSpaceId = Number(body?.space_id);
    if (
      !Number.isInteger(targetSpaceId) ||
      !(await getSpaceById(targetSpaceId)) ||
      !scopeAllows(scope, targetSpaceId)
    ) {
      return NextResponse.json({ error: "That space isn't available." }, { status: 400 });
    }
    if (!(await canEditSpace(user, targetSpaceId))) {
      return NextResponse.json(
        { error: "You don't have edit access to the target space." },
        { status: 403 }
      );
    }
  } else if (action === "status") {
    if (!STATUSES.includes(body?.status)) {
      return NextResponse.json({ error: "Status must be draft or published." }, { status: 400 });
    }
    newStatus = body.status;
  } else if (action === "type") {
    if (!TYPES.includes(body?.type)) {
      return NextResponse.json({ error: "Unknown document type." }, { status: 400 });
    }
    newType = body.type;
  } else {
    tag = String(body?.tag || "").trim();
    if (!tag || tag.length > 40 || tag.includes(",")) {
      return NextResponse.json({ error: "A single tag (no commas, max 40 chars) is required." }, { status: 400 });
    }
  }

  const actorName = user.name || user.username;

  let updated = 0;
  const skipped: { id: number; title: string; reason: string }[] = [];

  for (const id of ids) {
    const doc = await getDocument(id);
    // Invisible docs (missing, trashed, or in a space outside the caller's
    // scope) are reported as not found — same as the single-doc route.
    if (!doc || !scopeAllows(scope, doc.space_id)) {
      skipped.push({ id, title: `#${id}`, reason: "not found" });
      continue;
    }
    if (doc.branch_of) {
      skipped.push({ id, title: doc.title, reason: "draft branches can't be bulk-edited" });
      continue;
    }
    if (!(await canEditSpace(user, doc.space_id))) {
      skipped.push({ id, title: doc.title, reason: "no edit access" });
      continue;
    }

    // The approval rule from single-doc edits: touching live content (already
    // published, or publishing now) needs publish rights. Bulk never queues
    // change requests — it skips instead, so nothing happens invisibly.
    const wouldBeLive =
      action === "status" ? doc.status === "published" || newStatus === "published"
      : doc.status === "published";
    if (wouldBeLive && !(await canPublishDirectly(user, doc.space_id))) {
      skipped.push({ id, title: doc.title, reason: "needs publish rights" });
      continue;
    }

    let tags = doc.tags;
    if (action === "add_tag" && tag) {
      if (doc.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
        skipped.push({ id, title: doc.title, reason: "already tagged" });
        continue;
      }
      tags = [...doc.tags, tag];
    }
    if (action === "remove_tag" && tag) {
      const next = doc.tags.filter((t) => t.toLowerCase() !== tag!.toLowerCase());
      if (next.length === doc.tags.length) {
        skipped.push({ id, title: doc.title, reason: "not tagged" });
        continue;
      }
      tags = next;
    }
    if (action === "status" && doc.status === newStatus) {
      skipped.push({ id, title: doc.title, reason: "already " + newStatus });
      continue;
    }
    if (action === "move" && doc.space_id === targetSpaceId) {
      skipped.push({ id, title: doc.title, reason: "already there" });
      continue;
    }

    // Pass ONLY the fields this action changes — never a content snapshot,
    // so a concurrent editor save can't be clobbered by our stale read.
    const updatedDoc = await updateDocument(doc.id, {
      type: action === "type" ? newType : undefined,
      status: action === "status" ? newStatus : undefined,
      tags: action === "add_tag" || action === "remove_tag" ? tags : undefined,
      space_id: action === "move" ? targetSpaceId : undefined,
      author: actorName,
      versionNote: "Bulk edit",
    });
    updated++;

    // A bulk publish is still a publish: fire the same notifications as the
    // single-document route so channels and subscribers hear about it.
    if (action === "status" && newStatus === "published" && doc.status === "draft" && updatedDoc) {
      void notifyWebhooks("document.published", {
        title: updatedDoc.title,
        actor: actorName,
        url: `${requestOrigin(req)}/doc/${updatedDoc.id}`,
        spaceId: updatedDoc.space_id,
        spaceName: updatedDoc.space_name,
      });
      void notifySpaceSubscribers({
        spaceId: updatedDoc.space_id,
        spaceName: updatedDoc.space_name,
        docId: updatedDoc.id,
        title: updatedDoc.title,
        kind: "published",
        actorUserId: user.id,
        actorName,
        origin: requestOrigin(req),
      });
    }
  }

  await audit({
    actor: actorFrom(user),
    action: "document.bulk_" + action,
    targetType: "document",
    details: {
      requested: ids.length,
      updated,
      skipped: skipped.length,
      ...(targetSpaceId ? { space_id: targetSpaceId } : {}),
      ...(newStatus ? { status: newStatus } : {}),
      ...(newType ? { type: newType } : {}),
      ...(tag ? { tag } : {}),
    },
    ip: ipFrom(req),
  });

  return NextResponse.json({ updated, skipped: skipped.slice(0, 50) });
}
