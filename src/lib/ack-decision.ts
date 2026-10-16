// The decision a caller that cannot ask a person must make before it changes
// the text of a confirmed policy (1.11.0: A6 for merge, restore and the
// review queue; H2 for the v1 API and the MCP connector).
//
// One helper, so every write path refuses in the same words and with the
// same numbers: a substantive change to a published, confirmed document
// (or one the call publishes) without ack_policy is answered 428 with what
// the editor's question would have shown; a policy without a usable reason
// is answered 400; a change that is not substantive, or a document that
// does not require confirmation, is never asked the question whatever the
// body says. The one thing refused before any of that is a value of
// ack_policy that is neither 'keep' nor 'reset' (the literal 'auto'
// included): 400 on every path, metadata-only or not, exactly as PUT
// refuses it. updateDocument re-derives "substantive" inside its own
// transaction and stays the source of truth; this helper is the pre-flight
// that turns an undecided call into a question instead of a silent reset.

import { ackSummary, getVersion, ACK_REASON_MIN } from "@/lib/db";
import { changeSummary, suggestReconfirm } from "@/lib/diff";

export const ACK_DECISION_ERROR =
  'This document requires read confirmation. Pass ack_policy "keep" (editorial fix) or "reset" (material change), with ack_reason.';
export const ACK_REASON_ERROR = "ack_reason is required when the text of a confirmed policy changes.";
export const ACK_POLICY_ERROR = 'ack_policy must be "keep" or "reset".';

export type AckDecisionBody = { ack_policy?: unknown; ack_reason?: unknown };

/** What an undecided or badly decided call is answered with. */
export type AckDecisionRefusal = {
  status: 428 | 400;
  body: {
    error: string;
    decision_required?: true;
    confirmations?: number;
    eligible?: number;
    /** "v12", or null when the confirmed version has no number. */
    baseline?: string | null;
    change?: { pct: number; wordsChanged: number; blocksChanged: number; headingsChanged: number; numbersChanged: number };
    suggested?: "keep" | "reset";
  };
};

/** The decision a caller passes on to updateDocument once the helper lets it through. */
export type AckDecision = { ackPolicy: "keep" | "reset"; ackReason: string } | { ackPolicy: "auto"; ackReason: "" };

export interface AckDecisionDoc {
  id: number;
  status: string;
  ack_required: number;
  ack_version_id: number | null;
  title: string;
  content: string;
}

/** What the keep side's reason rule follows: Program settings' "Require a reason for editorial fixes too". */
export interface AckDecisionOptions {
  /**
   * False excuses a 'keep' from the length rule (the workspace does not ask
   * for a reason on editorial fixes); a 'reset' always needs ACK_REASON_MIN
   * characters. Default true, the stricter reading. Every caller passes
   * getComplianceSettings().ack_defaults.keep_reason_required, so the five
   * write paths and the three dialogs agree with PUT.
   */
  keepReasonRequired?: boolean;
}

/**
 * Pre-flight for a write that cannot ask. Returns the refusal to send, or
 * null when the call may proceed; `decision` then carries what to pass to
 * updateDocument ('auto' when nothing substantive changes, so the existing
 * rules apply unchanged).
 */
export async function ackDecisionRequired(
  doc: AckDecisionDoc,
  next: { title: string; content: string; status: string },
  body: AckDecisionBody,
  opts: AckDecisionOptions = {}
): Promise<{ refusal: AckDecisionRefusal | null; decision: AckDecision }> {
  const auto: AckDecision = { ackPolicy: "auto", ackReason: "" };
  // A bad value is refused before the substantive gate, so every path
  // answers 'auto' or garbage the same way PUT does, metadata-only or not.
  const policy = body.ack_policy;
  if (policy !== undefined && policy !== null && policy !== "keep" && policy !== "reset") {
    return { decision: auto, refusal: { status: 400, body: { error: ACK_POLICY_ERROR } } };
  }
  if (doc.ack_required !== 1 || next.status !== "published") return { refusal: null, decision: auto };

  const publishing = doc.status !== "published";
  const versionWorthy = next.content !== doc.content || next.title !== doc.title;
  if (!versionWorthy && !publishing) return { refusal: null, decision: auto };

  const baseline = doc.ack_version_id ? await getVersion(doc.id, doc.ack_version_id) : undefined;
  const base = baseline ?? { title: doc.title, content: doc.content };
  const drifts = next.content !== base.content || next.title !== base.title;
  if (!drifts) return { refusal: null, decision: auto };

  const reason = typeof body.ack_reason === "string" ? body.ack_reason.trim().slice(0, 500) : "";
  if (policy === undefined || policy === null) {
    const summary = await ackSummary(doc.id);
    const change = changeSummary(base.content, next.content, { oldTitle: base.title, newTitle: next.title });
    return {
      decision: auto,
      refusal: {
        status: 428,
        body: {
          error: ACK_DECISION_ERROR,
          decision_required: true,
          confirmations: summary.current,
          eligible: summary.eligible,
          baseline: summary.rev !== null ? `v${summary.rev}` : null,
          change: {
            pct: change.pct,
            wordsChanged: change.wordsChanged,
            blocksChanged: change.blocksChanged,
            headingsChanged: change.headingsChanged,
            numbersChanged: change.numbersChanged,
          },
          suggested: suggestReconfirm(change).policy,
        },
      },
    };
  }
  // A reset always needs its reason; a keep follows Program settings'
  // "Require a reason for editorial fixes too" (true unless told otherwise).
  const needsReason = policy === "reset" || opts.keepReasonRequired !== false;
  if (needsReason && reason.length < ACK_REASON_MIN) {
    return { decision: auto, refusal: { status: 400, body: { error: ACK_REASON_ERROR } } };
  }
  return { refusal: null, decision: { ackPolicy: policy, ackReason: reason } };
}

/**
 * The same rule, for a recommendation a change request stored (A6): true
 * when the stored policy and reason could be applied as they stand, so the
 * review route can treat an unusable recommendation as none (428 with the
 * numbers) rather than answer 400 to an approver who sent no reason.
 */
export function ackReasonUsable(
  policy: "keep" | "reset",
  reason: string,
  opts: AckDecisionOptions = {}
): boolean {
  const needsReason = policy === "reset" || opts.keepReasonRequired !== false;
  return !needsReason || reason.trim().length >= ACK_REASON_MIN;
}

/**
 * The `ack_policy` an audit row carries beside `confirmations_reset`, in
 * the scheduler's vocabulary (doc-schedule): 'keep' or 'reset' for what was
 * applied when a decision was taken, null when nothing was decided (a
 * metadata-only change, a draft, a document that asks nobody). Merge,
 * restore and the review route write their rows through this so the three
 * details read the same as `document.scheduled_publish`.
 */
export function auditedAckPolicy(
  outcome: { reset: boolean; decision_id?: number | null } | undefined
): "keep" | "reset" | null {
  if (!outcome || outcome.decision_id == null) return null;
  return outcome.reset ? "reset" : "keep";
}
