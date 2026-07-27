import { NextResponse } from "next/server";
import { v1Auth, v1Error } from "@/lib/v1-auth";
import { v1Doc } from "@/lib/v1-serialize";
import {
  getDocument,
  updateDocument,
  deleteDocument,
  createChangeRequest,
  getApprovalMode,
} from "@/lib/db";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { roleAtLeast, type DocType, type Role } from "@/lib/types";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { notifyCrSubmitted } from "@/lib/notifications";
import { requestOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const DOC_TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];

async function loadFor(user: { id: number; role: Role }, idRaw: string, needEdit: boolean) {
  const doc = await getDocument(Number(idRaw));
  if (!doc) return v1Error(404, "Document not found.");
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return v1Error(404, "Document not found.");
  }
  if (doc.status === "draft" && !roleAtLeast(user.role, "editor")) {
    return v1Error(404, "Document not found.");
  }
  if (needEdit && !(await canEditSpace(user, doc.space_id))) {
    return v1Error(403, "You don't have edit rights in that space.");
  }
  return doc;
}

/** GET /api/v1/documents/:id — full document, content included. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await v1Auth(req, "read");
  if (user instanceof NextResponse) return user;
  const { id } = await ctx.params;
  const doc = await loadFor(user, id, false);
  if (doc instanceof NextResponse) return doc;
  return NextResponse.json({ document: v1Doc(doc, true) });
}

/**
 * PATCH /api/v1/documents/:id — partial update (title, content, summary,
 * tags, type, status). Touching a published document without publish rights
 * queues a change request and returns 202.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await v1Auth(req, "write");
  if (user instanceof NextResponse) return user;
  if (!roleAtLeast(user.role, "editor")) {
    return v1Error(403, "Editing documents needs the editor role.");
  }
  const { id } = await ctx.params;
  const doc = await loadFor(user, id, true);
  if (doc instanceof NextResponse) return doc;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return v1Error(400, "Body must be JSON.");
  }

  const next = {
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : doc.title,
    content: typeof body.content === "string" ? body.content : doc.content,
    summary: typeof body.summary === "string" ? body.summary.slice(0, 500) : doc.summary,
    tags: Array.isArray(body.tags)
      ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
      : doc.tags,
    type: DOC_TYPES.includes(body.type as DocType) ? (body.type as DocType) : doc.type,
    status:
      body.status === "draft" || body.status === "published"
        ? (body.status as "draft" | "published")
        : doc.status,
  };

  const affectsLive = doc.status === "published" || next.status === "published";
  const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";

  if (affectsLive && !canPublish) {
    const crId = await createChangeRequest({
      document_id: doc.id,
      kind: doc.status === "draft" ? "publish" : "edit",
      title: next.title,
      content: next.content,
      summary: next.summary,
      tags: next.tags,
      type: next.type,
      target_status: "published",
      note: String(body.note ?? "").trim() || "Submitted via API",
      created_by: user.id,
    });
    await audit({
      actor: actorFrom(user),
      action: "change_request.submit",
      targetType: "document",
      targetId: doc.id,
      targetLabel: next.title,
      details: { via: "api_v1" },
      ip: ipFrom(req),
    });
    void notifyCrSubmitted({
      spaceId: doc.space_id,
      title: next.title,
      actorId: user.id,
      actorName: user.name || user.username,
      origin: requestOrigin(req),
    });
    return NextResponse.json(
      { pending: true, change_request_id: crId, note: "Queued for approval." },
      { status: 202 }
    );
  }

  const updated = await updateDocument(doc.id, {
    ...next,
    author: user.name || user.username,
    versionNote: String(body.note ?? "").trim() || "Updated via API",
  });
  if (!updated) return v1Error(404, "Document not found.");

  await audit({
    actor: actorFrom(user),
    action: "document.update",
    targetType: "document",
    targetId: updated.id,
    targetLabel: updated.title,
    details: { via: "api_v1" },
    ip: ipFrom(req),
  });
  if (updated.status === "published") {
    void notifySpaceSubscribers({
      spaceId: updated.space_id,
      spaceName: updated.space_name,
      docId: updated.id,
      title: updated.title,
      kind: doc.status === "draft" ? "published" : "updated",
      actorUserId: user.id,
      actorName: user.name || user.username,
      origin: requestOrigin(req),
    });
  }
  return NextResponse.json({ document: v1Doc(updated, true) });
}

/** DELETE /api/v1/documents/:id — move to Trash (restorable in the app). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await v1Auth(req, "write");
  if (user instanceof NextResponse) return user;
  if (!roleAtLeast(user.role, "editor")) {
    return v1Error(403, "Deleting documents needs the editor role.");
  }
  const { id } = await ctx.params;
  const doc = await loadFor(user, id, true);
  if (doc instanceof NextResponse) return doc;

  await deleteDocument(doc.id);
  await audit({
    actor: actorFrom(user),
    action: "document.trash",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    details: { via: "api_v1" },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, trashed: doc.id });
}
