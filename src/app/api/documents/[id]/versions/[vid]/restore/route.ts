import { NextResponse } from "next/server";
import {
  getDocument,
  getVersion,
  updateDocument,
  createChangeRequest,
  getApprovalMode,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { roleAtLeast } from "@/lib/types";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Restore a previous version: the selected snapshot's title + content become a
// NEW version on top of the history (nothing is rewritten). Approval rules
// mirror a normal edit — on a published doc, editors in strict mode submit a
// change request instead of applying directly.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> }
) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id, vid } = await params;
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

  const version = await getVersion(doc.id, Number(vid));
  if (!version) return NextResponse.json({ error: "Version not found." }, { status: 404 });
  if (version.title === doc.title && version.content === doc.content) {
    return NextResponse.json(
      { error: "That version matches the current document — nothing to restore." },
      { status: 400 }
    );
  }

  let label = "";
  try {
    const body = await req.json();
    label = String(body?.label ?? "").trim();
  } catch {
    // Body is optional.
  }
  const note = `Restored version${label ? ` ${label}` : ""} from ${version.created_at.slice(0, 10)}`;

  const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";
  if (doc.status === "published" && !canPublish) {
    const crId = await createChangeRequest({
      document_id: doc.id,
      kind: "edit",
      title: version.title,
      content: version.content,
      summary: doc.summary,
      tags: doc.tags,
      type: doc.type,
      target_status: "published",
      note,
      created_by: user.id,
    });
    await audit({
      actor: actorFrom(user),
      action: "change_request.submit",
      targetType: "document",
      targetId: doc.id,
      targetLabel: version.title,
      details: { kind: "restore", versionId: version.id },
      ip: ipFrom(req),
    });
    return NextResponse.json({ pending: true, changeRequestId: crId, docId: doc.id });
  }

  const updated = await updateDocument(doc.id, {
    title: version.title,
    content: version.content,
    author: user.name || user.username,
    versionNote: note,
    restoredFrom: version.id,
  });
  await audit({
    actor: actorFrom(user),
    action: "document.restore_version",
    targetType: "document",
    targetId: doc.id,
    targetLabel: updated?.title ?? version.title,
    details: { versionId: version.id },
    ip: ipFrom(req),
  });
  return NextResponse.json({ doc: updated });
}
