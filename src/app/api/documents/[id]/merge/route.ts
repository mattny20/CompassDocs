import { NextResponse } from "next/server";
import {
  getDocument,
  updateDocument,
  deleteDocument,
  createChangeRequest,
  changeRequestAckReason,
  AckReasonRequiredError,
} from "@/lib/db";
import { ackDecisionRequired, ACK_POLICY_ERROR } from "@/lib/ack-decision";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { apiGuard } from "@/lib/api-auth";
import { audit, auditAckDecision, actorFrom, ipFrom } from "@/lib/audit";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { notifyCrSubmitted } from "@/lib/notifications";
import { requestOrigin } from "@/lib/oauth";
import { canPublishDirectly, spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Merge a draft branch back into its source document. The branch's title,
// content, summary, and tags become the source's next version. Approval rules
// mirror a normal edit: on a published source, editors in strict mode submit a
// change request (the branch stays open until it's approved); approvers and
// open-mode edits apply immediately and the branch is moved to the Trash.
//
// Body: { note?, ack_policy?, ack_reason?, base_updated_at? }. A merge into
// a confirmed, published document whose text differs from the confirmed
// version is a decision like a save (A6): without ack_policy it is answered
// 428 with the numbers the editor's question shows; 'keep' or 'reset' needs
// an ack_reason of 10+ characters (400 otherwise). base_updated_at is the
// source's updated_at the branch was created or last compared against; a
// source that changed since is answered 409 in the same shape as PUT.

const MERGE_CONFLICT_ERROR =
  "The live document changed since this branch was created. Review it before merging.";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor", "document.merge");
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

  let body: any = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    // Body is optional.
  }
  const note = String(body?.note ?? "").trim();
  const versionNote = note || "Merged draft branch";

  // Optimistic-concurrency guard, as PUT has it: the client sends the
  // source's updated_at it last saw. A source that changed since (someone
  // saved the live document while the branch was open) is refused with 409
  // instead of the branch silently discarding their edit. Clients that send
  // nothing keep the historical behaviour.
  if (typeof body?.base_updated_at === "string" && body.base_updated_at) {
    const base = new Date(body.base_updated_at).getTime();
    const current = new Date(source.updated_at).getTime();
    if (Number.isFinite(base) && Number.isFinite(current) && current > base) {
      return NextResponse.json(
        {
          conflict: true,
          error: MERGE_CONFLICT_ERROR,
          current_updated_at: source.updated_at,
          current_author: source.author,
        },
        { status: 409 }
      );
    }
  }

  // The decision about the readers (A6): only 'keep' or 'reset' is one; the
  // literal 'auto' is refused like any other unknown value, before any write.
  const ackPolicyRaw = body?.ack_policy;
  if (ackPolicyRaw != null && ackPolicyRaw !== "keep" && ackPolicyRaw !== "reset") {
    return NextResponse.json({ error: ACK_POLICY_ERROR }, { status: 400 });
  }
  const ackReason = changeRequestAckReason(body?.ack_reason);

  const canPublish = await canPublishDirectly(user, source.space_id);
  if (source.status === "published" && !canPublish) {
    // The submitter's recommendation travels with the request; the approver
    // decides at approval.
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
      ack_policy: ackPolicyRaw,
      ack_reason: ackReason,
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
    void notifyCrSubmitted({
      spaceId: source.space_id,
      title: branch.title,
      actorId: user.id,
      actorName: user.name || user.username,
      origin: requestOrigin(req),
    });
    return NextResponse.json({ pending: true, changeRequestId: crId, docId: source.id });
  }

  // Pre-flight (A6): a merge that changes the text of a confirmed, published
  // document without a decision is a question, not a silent reset. The
  // helper answers 428 (undecided) or 400 (a bad policy, a short reason)
  // before anything is written, and lets a merge that changes nothing
  // substantive through as 'auto' whatever the body says.
  const pre = await ackDecisionRequired(
    source,
    { title: branch.title, content: branch.content, status: source.status },
    { ack_policy: ackPolicyRaw ?? undefined, ack_reason: ackReason }
  );
  if (pre.refusal) return NextResponse.json(pre.refusal.body, { status: pre.refusal.status });

  let updated: Awaited<ReturnType<typeof updateDocument>>;
  try {
    updated = await updateDocument(source.id, {
      title: branch.title,
      content: branch.content,
      summary: branch.summary,
      tags: branch.tags,
      type: branch.type,
      author: user.name || user.username,
      versionNote,
      ackPolicy: pre.decision.ackPolicy,
      ackReason: pre.decision.ackReason,
      ackSource: "merge",
      ackActor: { id: user.id, name: user.name || user.username },
      ackKeepReasonRequired: (await getComplianceSettings()).ack_defaults.keep_reason_required,
      ackOrigin: requestOrigin(req),
    });
  } catch (e) {
    if (e instanceof AckReasonRequiredError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
  await deleteDocument(branch.id);
  // A branch whose text already matches its source has nothing to merge: the
  // source comes back unchanged (no version, no reset) and the branch still
  // moves to the Trash. The branch's own lifecycle (merged, then trashed) is
  // recorded either way, with `changed: false` saying the source was not
  // touched; nobody is notified and no decision is echoed (A2, as PUT does
  // for a no-op save). The decision taken, when one was, rides on the row as
  // {ack_policy, confirmations_reset} (A6).
  const unchanged = updated?.ack_outcome?.changed === false;
  await audit({
    actor: actorFrom(user),
    action: "document.branch_merge",
    targetType: "document",
    targetId: source.id,
    targetLabel: branch.title,
    details: {
      branchId: branch.id,
      changed: !unchanged,
      ack_policy: updated?.ack_outcome?.policy ?? pre.decision.ackPolicy,
      confirmations_reset: updated?.ack_outcome?.confirmations_reset ?? 0,
    },
    ip: ipFrom(req),
  });
  if (unchanged) {
    return NextResponse.json({ doc: updated, ack_outcome: updated?.ack_outcome });
  }
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
  // The confirmation decision a merge of a confirmed, published document
  // took is echoed to the audit log like a PUT's (C1).
  await auditAckDecision(source, updated, { actor: actorFrom(user), ip: ipFrom(req) });
  return NextResponse.json({ doc: updated, ack_outcome: updated?.ack_outcome });
}
