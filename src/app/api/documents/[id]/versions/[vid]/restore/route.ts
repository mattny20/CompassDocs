import { NextResponse } from "next/server";
import {
  getDocument,
  getVersion,
  updateDocument,
  createChangeRequest,
  changeRequestAckReason,
  AckReasonRequiredError,
} from "@/lib/db";
import { ackDecisionRequired, auditedAckPolicy, ACK_POLICY_ERROR } from "@/lib/ack-decision";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { apiGuard } from "@/lib/api-auth";
import { audit, auditAckDecision, actorFrom, ipFrom } from "@/lib/audit";
import { notifyCrSubmitted } from "@/lib/notifications";
import { requestOrigin } from "@/lib/oauth";
import { canPublishDirectly, spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Restore a previous version: the selected snapshot's title + content become a
// NEW version on top of the history (nothing is rewritten). Approval rules
// mirror a normal edit — on a published doc, editors in strict mode submit a
// change request instead of applying directly.
//
// Body: { label?, note?, ack_policy?, ack_reason? }. `note`, when given, is
// the version note (the dialog's change note, as a merge's is); otherwise
// the note reads "Restored version N from YYYY-MM-DD". Restoring older text
// over a confirmed, published document whose confirmed version differs is a
// decision like a save (A6): without ack_policy the call is answered 428
// with the numbers the editor's question shows; a 'reset' needs an
// ack_reason of 10+ characters and a 'keep' follows Program settings'
// "Require a reason for editorial fixes too" (400 otherwise), as PUT does.
// Restoring the confirmed version itself asks nothing.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> }
) {
  const gate = await apiGuard("editor", "document.version_restore");
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

  let body: any = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    // Body is optional.
  }
  const label = String(body?.label ?? "").trim();
  const note =
    String(body?.note ?? "").trim() ||
    `Restored version${label ? ` ${label}` : ""} from ${version.created_at.slice(0, 10)}`;

  // The decision about the readers (A6): only 'keep' or 'reset' is one; the
  // literal 'auto' is refused like any other unknown value, before any write.
  const ackPolicyRaw = body?.ack_policy;
  if (ackPolicyRaw != null && ackPolicyRaw !== "keep" && ackPolicyRaw !== "reset") {
    return NextResponse.json({ error: ACK_POLICY_ERROR }, { status: 400 });
  }
  const ackReason = changeRequestAckReason(body?.ack_reason);

  const canPublish = await canPublishDirectly(user, doc.space_id);
  if (doc.status === "published" && !canPublish) {
    // The submitter's recommendation travels with the request; the approver
    // decides at approval.
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
      ack_policy: ackPolicyRaw,
      ack_reason: ackReason,
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
    void notifyCrSubmitted({
      spaceId: doc.space_id,
      title: version.title,
      actorId: user.id,
      actorName: user.name || user.username,
      origin: requestOrigin(req),
    });
    return NextResponse.json({ pending: true, changeRequestId: crId, docId: doc.id });
  }

  // Pre-flight (A6): restoring text that differs from the confirmed version
  // over a confirmed, published document without a decision is a question,
  // not a silent reset. The helper answers 428 (undecided) or 400 (a bad
  // policy, a short reason) before anything is written, and lets a restore
  // of the confirmed version itself through as 'auto' whatever the body says.
  // The keep side's reason rule is the workspace's, read once here for the
  // pre-flight and for updateDocument's own check.
  const keepReasonRequired = (await getComplianceSettings()).ack_defaults.keep_reason_required;
  const pre = await ackDecisionRequired(
    doc,
    { title: version.title, content: version.content, status: doc.status },
    { ack_policy: ackPolicyRaw ?? undefined, ack_reason: ackReason },
    { keepReasonRequired }
  );
  if (pre.refusal) return NextResponse.json(pre.refusal.body, { status: pre.refusal.status });

  let updated: Awaited<ReturnType<typeof updateDocument>>;
  try {
    updated = await updateDocument(doc.id, {
      title: version.title,
      content: version.content,
      author: user.name || user.username,
      versionNote: note,
      restoredFrom: version.id,
      ackPolicy: pre.decision.ackPolicy,
      ackReason: pre.decision.ackReason,
      ackSource: "restore",
      ackActor: { id: user.id, name: user.name || user.username },
      ackKeepReasonRequired: keepReasonRequired,
      ackOrigin: requestOrigin(req),
    });
  } catch (e) {
    if (e instanceof AckReasonRequiredError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
  // The decision taken, when one was, rides on the row as {ack_policy,
  // confirmations_reset} (A6) beside the version restored, in the
  // scheduler's vocabulary: ack_policy is null when nothing was decided.
  await audit({
    actor: actorFrom(user),
    action: "document.restore_version",
    targetType: "document",
    targetId: doc.id,
    targetLabel: updated?.title ?? version.title,
    details: {
      versionId: version.id,
      ack_policy: auditedAckPolicy(updated?.ack_outcome),
      confirmations_reset: updated?.ack_outcome?.confirmations_reset ?? 0,
    },
    ip: ipFrom(req),
  });
  // Restoring an older text over a confirmed, published document takes a
  // confirmation decision; echo it to the audit log like a PUT's (C1).
  await auditAckDecision(doc, updated, { actor: actorFrom(user), ip: ipFrom(req) });
  return NextResponse.json({ doc: updated, ack_outcome: updated?.ack_outcome });
}
