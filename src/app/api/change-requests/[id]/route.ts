import { NextResponse } from "next/server";
import {
  approveChangeRequest,
  rejectChangeRequest,
  getChangeRequest,
  getDocument,
  changeRequestAckPolicy,
  changeRequestAckReason,
  AckReasonRequiredError,
} from "@/lib/db";
import { ackDecisionRequired, ACK_POLICY_ERROR, ACK_REASON_ERROR } from "@/lib/ack-decision";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { audit, actorFrom, ipFrom, auditAckDecision } from "@/lib/audit";
import { notifyWebhooks } from "@/lib/webhooks";
import { notify, ackOutcomeSentence, crResolvedBody } from "@/lib/notifications";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { requestOrigin } from "@/lib/oauth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/change-requests/[id] takes { action, note, ack_policy?,
 * ack_reason? }. On approve, ack_policy ('keep' | 'reset') is the reviewer's
 * own decision for a request that changes the text of a confirmed, published
 * document (A6); without it the submitter's recommendation on the request
 * applies, and when the request carries none either the call is answered 428
 * with the same body the editor's question shows, so the review UI opens it.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("approver", "change_request.decide");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = body?.action;
  const note = String(body?.note ?? "").trim();
  // Snapshot the title/space before the decision mutates the row.
  const cr = await getChangeRequest(Number(id));
  const crDoc = cr ? await getDocument(cr.document_id) : undefined;

  // An approver may only decide change requests for spaces within their scope —
  // otherwise a non-admin approver could enumerate CR ids and publish/reject
  // into a private space they can't see. Also validate the move-on-approve
  // target space (cr.space_id), when the CR relocates the doc.
  if (!cr || !crDoc) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const scope = await spaceScopeFor(user);
  if (!scopeAllows(scope, crDoc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const targetSpace = (cr as { space_id?: number | null }).space_id;
  if (targetSpace != null && targetSpace !== crDoc.space_id && !scopeAllows(scope, targetSpace)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (action === "approve") {
    // The reviewer's decision about the readers (A6). Only 'keep' or
    // 'reset' is a decision; the literal 'auto' is refused like any other
    // unknown value. The pre-flight runs the shared helper against the live
    // document and the request's proposed title and text: a substantive
    // change to a confirmed, published document with no decision from the
    // reviewer and no recommendation on the request is answered 428 with
    // the numbers the question shows; the submitter's stored 'keep' or
    // 'reset' stands in for the body when the reviewer sent none, with the
    // reviewer's reason over the submitter's. A short reason is refused the
    // way the helper refuses it, except that a keep follows the workspace's
    // "Require a reason for editorial fixes too" (E4), which the helper
    // does not read. approveChangeRequest re-derives "substantive" on the
    // locked row and checks the reviewer's reason again before any write.
    const raw = body?.ack_policy;
    if (raw != null && raw !== "keep" && raw !== "reset") {
      return NextResponse.json({ error: ACK_POLICY_ERROR }, { status: 400 });
    }
    const reviewerPolicy: "keep" | "reset" | undefined = raw ?? undefined;
    const reviewerReason = changeRequestAckReason(body?.ack_reason);
    const keepReasonRequired = (await getComplianceSettings()).ack_defaults.keep_reason_required;
    const stored = changeRequestAckPolicy(cr.ack_policy);
    const decisionBody: { ack_policy?: "keep" | "reset"; ack_reason?: string } =
      reviewerPolicy !== undefined
        ? { ack_policy: reviewerPolicy, ack_reason: reviewerReason }
        : stored !== "auto"
          ? { ack_policy: stored, ack_reason: reviewerReason || changeRequestAckReason(cr.ack_reason) }
          : {};
    const pre = await ackDecisionRequired(
      crDoc,
      { title: cr.title, content: cr.content, status: cr.target_status },
      decisionBody
    );
    if (pre.refusal) {
      const keepExcused =
        pre.refusal.status === 400 &&
        pre.refusal.body.error === ACK_REASON_ERROR &&
        decisionBody.ack_policy === "keep" &&
        !keepReasonRequired;
      if (!keepExcused) return NextResponse.json(pre.refusal.body, { status: pre.refusal.status });
    }

    // The origin rides on the notice a reset queues (1.10.1), so its links
    // are absolute on a workspace without custom_domain.
    let ok: Awaited<ReturnType<typeof approveChangeRequest>>;
    try {
      ok = await approveChangeRequest(Number(id), user.id, user.name || user.username, note, {
        origin: requestOrigin(req),
        ackPolicy: reviewerPolicy,
        ackReason: reviewerReason,
        ackKeepReasonRequired: keepReasonRequired,
      });
    } catch (e) {
      if (e instanceof AckReasonRequiredError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }
    if (!ok) return NextResponse.json({ error: "Already reviewed or not found." }, { status: 409 });
    await audit({
      actor: actorFrom(user),
      action: "change_request.approve",
      targetType: "change_request",
      targetId: id,
      details: {
        ack_policy: ok.ack_outcome.policy,
        confirmations_reset: ok.ack_outcome.confirmations_reset,
        submitted_policy: stored,
      },
      ip: ipFrom(req),
    });
    void notifyWebhooks("change_request.approved", {
      title: cr?.title || `change request #${id}`,
      actor: user.name || user.username,
      note,
      url: `${requestOrigin(req)}/review`,
      spaceId: crDoc?.space_id,
      spaceName: crDoc?.space_name,
    });
    // The author hears their change was approved, and what it did to the
    // confirmations when a decision was taken (A6).
    void notify([cr.created_by], {
      kind: "cr_resolved",
      title: `${user.name || user.username} approved "${cr.title}"`,
      body: crResolvedBody(note, ackOutcomeSentence(ok.ack_outcome)),
      link: `/doc/${cr.document_id}`,
      actorName: user.name || user.username,
      origin: requestOrigin(req),
    });
    // Subscribers hear about the change landing (the doc may have moved
    // spaces as part of the approval — notify its current space).
    const after = cr ? await getDocument(cr.document_id) : undefined;
    // The confirmation decision the approval took on a confirmed, published
    // document is echoed to the audit log like a PUT's (C1): crDoc is the row
    // before the approval, ok.ack_outcome names the ledger row.
    await auditAckDecision(crDoc, after && { ...after, ack_outcome: ok.ack_outcome }, {
      actor: actorFrom(user),
      ip: ipFrom(req),
    });
    if (after && after.status === "published") {
      void notifySpaceSubscribers({
        spaceId: after.space_id,
        spaceName: after.space_name,
        docId: after.id,
        title: after.title,
        kind: cr!.kind === "publish" ? "published" : "updated",
        actorUserId: cr!.created_by,
        actorName: cr!.author_name,
        origin: requestOrigin(req),
      });
    }
    return NextResponse.json({ ok: true, result: "approved", ack_outcome: ok.ack_outcome });
  }
  if (action === "reject") {
    const ok = await rejectChangeRequest(Number(id), user.id, note);
    if (!ok) return NextResponse.json({ error: "Already reviewed or not found." }, { status: 409 });
    await audit({
      actor: actorFrom(user),
      action: "change_request.reject",
      targetType: "change_request",
      targetId: id,
      ip: ipFrom(req),
    });
    void notifyWebhooks("change_request.rejected", {
      title: cr?.title || `change request #${id}`,
      actor: user.name || user.username,
      note,
      url: `${requestOrigin(req)}/review`,
      spaceId: crDoc?.space_id,
      spaceName: crDoc?.space_name,
    });
    void notify([cr.created_by], {
      kind: "cr_resolved",
      title: `${user.name || user.username} declined "${cr.title}"`,
      body: note || undefined,
      link: `/doc/${cr.document_id}`,
      actorName: user.name || user.username,
      origin: requestOrigin(req),
    });
    return NextResponse.json({ ok: true, result: "rejected" });
  }
  return NextResponse.json({ error: "action must be 'approve' or 'reject'." }, { status: 400 });
}
