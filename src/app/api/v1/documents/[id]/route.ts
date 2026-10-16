import { NextResponse } from "next/server";
import { v1Auth, v1Error, v1Requires, v1Holds, type V1User } from "@/lib/v1-auth";
import { v1Doc } from "@/lib/v1-serialize";
import {
  getDocument,
  updateDocument,
  deleteDocument,
  createChangeRequest,
  getApprovalMode,
  ackSummary,
  AckReasonRequiredError,
} from "@/lib/db";
import { ackDecisionRequired, ACK_POLICY_ERROR } from "@/lib/ack-decision";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { type DocType, type DocumentWithSpace, type AckOutcomeInfo } from "@/lib/types";
import { audit, auditAckDecision, actorFrom, ipFrom } from "@/lib/audit";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { notifyCrSubmitted } from "@/lib/notifications";
import { requestOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const DOC_TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];

async function loadFor(user: V1User, idRaw: string, needEdit: boolean) {
  const doc = await getDocument(Number(idRaw));
  if (!doc) return v1Error(404, "Document not found.");
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return v1Error(404, "Document not found.");
  }
  // 404 rather than 403 on drafts, deliberately: someone without draft access
  // shouldn't learn that a draft exists at this id.
  if (doc.status === "draft" && !(await v1Holds(user, "document.read_draft", doc.space_id))) {
    return v1Error(404, "Document not found.");
  }
  if (needEdit && !(await canEditSpace(user, doc.space_id))) {
    return v1Error(403, "You don't have edit rights in that space.");
  }
  return doc;
}

/**
 * The v1 wire shape plus what an integration needs to know before it edits
 * a policy (H2, 1.11.0): whether readers must confirm, the document's edit
 * default, and the standing ("42 of 50 people have confirmed v12") that the
 * 428 below would otherwise be the first to show. v1Doc stays slim on
 * purpose; the fields are added here, on the one endpoint that returns a
 * single document in full, and the counts are facts whether or not the
 * requirement is on.
 */
async function v1DocWithAck(doc: DocumentWithSpace) {
  const summary = await ackSummary(doc.id);
  return {
    ...v1Doc(doc, true),
    ack_required: doc.ack_required === 1,
    ack_edit_default: doc.ack_edit_default,
    ack: {
      confirmations: summary.current,
      eligible: summary.eligible,
      version: summary.rev !== null ? `v${summary.rev}` : null,
    },
  };
}

/** What PATCH echoes about readers' confirmations (the PUT contract, without the ledger id). */
function v1AckOutcome(outcome: AckOutcomeInfo | undefined) {
  if (!outcome) return undefined;
  const { changed, substantive, reset, confirmations_reset, policy, source } = outcome;
  return { changed, substantive, reset, confirmations_reset, policy, source };
}

/** GET /api/v1/documents/:id — full document, content included. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await v1Auth(req, "read");
  if (user instanceof NextResponse) return user;
  const { id } = await ctx.params;
  const doc = await loadFor(user, id, false);
  if (doc instanceof NextResponse) return doc;
  return NextResponse.json({ document: await v1DocWithAck(doc) });
}

/**
 * PATCH /api/v1/documents/:id — partial update (title, content, summary,
 * tags, type, status). Touching a published document without publish rights
 * queues a change request and returns 202.
 *
 * A change to the text or title of a published document that requires read
 * confirmation (or a PATCH that publishes such a draft whose text drifted
 * from the confirmed version) must say what readers should see (H2,
 * 1.11.0): `ack_policy` "keep" (editorial fix) or "reset" (material change)
 * with `ack_reason` (up to 500 characters; a reset needs at least 10, a keep
 * follows Program settings' "Require a reason for editorial fixes too").
 * Without the policy the call is answered 428 with the standing and the
 * measured change, so the integration can ask a person instead of guessing;
 * a short reason is 400. A metadata-only PATCH, a draft that stays a draft
 * and a document that does not require confirmation never see the 428; the
 * one thing refused whatever the change is a bad `ack_policy` value (400),
 * as the app's PUT refuses it.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await v1Auth(req, "write");
  if (user instanceof NextResponse) return user;
  const { id } = await ctx.params;
  const doc = await loadFor(user, id, true);
  if (doc instanceof NextResponse) return doc;
  const mayEdit = await v1Requires(user, "document.update", {
    spaceId: doc.space_id,
    message: "You don't have permission to edit documents.",
  });
  if (mayEdit) return mayEdit;

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
  const canPublish =
    (await v1Holds(user, "document.publish", doc.space_id)) ||
    (await getApprovalMode()) === "open";

  if (affectsLive && !canPublish) {
    // The caller's ack_policy travels with the request as the submitter's
    // recommendation (A6); the approver decides at approval. Only 'keep' or
    // 'reset' is one: a bad value is refused here as the direct path refuses
    // it, before anything is queued.
    if (body.ack_policy != null && body.ack_policy !== "keep" && body.ack_policy !== "reset") {
      return v1Error(400, ACK_POLICY_ERROR);
    }
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
      ack_policy: body.ack_policy,
      ack_reason: body.ack_reason,
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

  // The pre-flight every write path that cannot ask shares (lib/ack-decision):
  // 428 or 400 in the same words and with the same numbers as merge, restore
  // and the connector; 'auto' when nothing substantive changes, so the
  // document's own edit default applies exactly as before. The keep side's
  // reason rule is the workspace's, read once for the pre-flight and for
  // updateDocument's own check.
  const keepReasonRequired = (await getComplianceSettings()).ack_defaults.keep_reason_required;
  const { refusal, decision } = await ackDecisionRequired(doc, next, body, { keepReasonRequired });
  if (refusal) return NextResponse.json(refusal.body, { status: refusal.status });

  let updated: Awaited<ReturnType<typeof updateDocument>>;
  try {
    updated = await updateDocument(doc.id, {
      ...next,
      author: user.name || user.username,
      // The reason is what readers see as the change note when no note came.
      versionNote: String(body.note ?? "").trim() || decision.ackReason || "Updated via API",
      ackPolicy: decision.ackPolicy,
      ackReason: decision.ackReason,
      ackKeepReasonRequired: keepReasonRequired,
      ackSource: "api",
      ackActor: { id: user.id, name: user.name || user.username },
      ackOrigin: requestOrigin(req),
    });
  } catch (e) {
    // The pre-flight already checked the reason; this is the race where the
    // document changed between the two reads.
    if (e instanceof AckReasonRequiredError) return v1Error(400, e.message);
    throw e;
  }
  if (!updated) return v1Error(404, "Document not found.");

  // A PATCH that changed nothing is answered with the unchanged document and
  // nothing else happens: no audit row claiming an edit that did not happen,
  // no subscriber notice (A2, as the app's PUT does). Every field this
  // endpoint accepts goes through updateDocument, so a metadata-only change
  // (tags, summary, type, status) is `changed: true` and audited below.
  if (updated.ack_outcome?.changed === false) {
    return NextResponse.json({
      document: await v1DocWithAck(updated),
      ack_outcome: v1AckOutcome(updated.ack_outcome),
    });
  }

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
  // The confirmation decision an API edit of a confirmed, published document
  // took is echoed to the audit log like a PUT's (C1).
  await auditAckDecision(doc, updated, { actor: actorFrom(user), ip: ipFrom(req) });
  return NextResponse.json({
    document: await v1DocWithAck(updated),
    ack_outcome: v1AckOutcome(updated.ack_outcome),
  });
}

/** DELETE /api/v1/documents/:id — move to Trash (restorable in the app). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await v1Auth(req, "write");
  if (user instanceof NextResponse) return user;
  const { id } = await ctx.params;
  const doc = await loadFor(user, id, true);
  if (doc instanceof NextResponse) return doc;
  // Trashing a draft and retiring a published document are separate rights,
  // as they are everywhere else in the app.
  const mayDelete = await v1Requires(
    user,
    doc.status === "published" ? "document.delete_published" : "document.delete_draft",
    { spaceId: doc.space_id, message: "You don't have permission to delete that document." }
  );
  if (mayDelete) return mayDelete;

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
