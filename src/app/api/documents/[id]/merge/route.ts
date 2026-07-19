import { NextResponse } from "next/server";
import {
  getDocument,
  updateDocument,
  deleteDocument,
  createChangeRequest,
  getApprovalMode,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { requestOrigin } from "@/lib/oauth";
import { roleAtLeast } from "@/lib/types";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Merge a draft branch back into its source document. The branch's title,
// content, summary, and tags become the source's next version. Approval rules
// mirror a normal edit: on a published source, editors in strict mode submit a
// change request (the branch stays open until it's approved); approvers and
// open-mode edits apply immediately and the branch is moved to the Trash.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const branch = await getDocument(Number(id));
  if (!branch) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!scopeAllows(await spaceScopeFor(user), branch.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!branch.branch_of) {
    return NextResponse.json({ error: "This document is not a draft branch." }, { status: 400 });
  }
  const source = await getDocument(branch.branch_of);
  if (!source) {
    return NextResponse.json(
      { error: "The original document no longer exists." },
      { status: 409 }
    );
  }
  if (!(await canEditSpace(user, source.space_id))) {
    return NextResponse.json(
      { error: "You don't have edit access to this space." },
      { status: 403 }
    );
  }

  let note = "";
  try {
    const body = await req.json();
    note = String(body?.note ?? "").trim();
  } catch {
    // Body is optional.
  }
  const versionNote = note || "Merged draft branch";

  const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";
  if (source.status === "published" && !canPublish) {
    const crId = await createChangeRequest({
      document_id: source.id,
      kind: "edit",
      title: branch.title,
      content: branch.content,
      summary: branch.summary,
      tags: branch.tags,
      type: branch.type,
      target_status: "published",
      note: versionNote,
      created_by: user.id,
    });
    await audit({
      actor: actorFrom(user),
      action: "change_request.submit",
      targetType: "document",
      targetId: source.id,
      targetLabel: branch.title,
      details: { kind: "merge", branchId: branch.id },
      ip: ipFrom(req),
    });
    return NextResponse.json({ pending: true, changeRequestId: crId, docId: source.id });
  }

  const updated = await updateDocument(source.id, {
    title: branch.title,
    content: branch.content,
    summary: branch.summary,
    tags: branch.tags,
    type: branch.type,
    author: user.name || user.username,
    versionNote,
  });
  await deleteDocument(branch.id);
  await audit({
    actor: actorFrom(user),
    action: "document.branch_merge",
    targetType: "document",
    targetId: source.id,
    targetLabel: branch.title,
    details: { branchId: branch.id },
    ip: ipFrom(req),
  });
  if (updated && updated.status === "published") {
    void notifySpaceSubscribers({
      spaceId: updated.space_id,
      spaceName: updated.space_name,
      docId: updated.id,
      title: updated.title,
      kind: "updated",
      actorUserId: user.id,
      actorName: user.name || user.username,
      origin: requestOrigin(req),
    });
  }
  return NextResponse.json({ doc: updated });
}
