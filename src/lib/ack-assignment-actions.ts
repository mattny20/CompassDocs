import "server-only";
import {
  exemptAssignments,
  unexemptAssignments,
  extendAssignments,
  undoExtension,
  snoozeAssignments,
  unsnoozeAssignments,
  reaskableAssignments,
  claimReconfirmation,
  getUserById,
} from "./db";
import type { AckActor, AssignmentChange } from "./db";
import { audit, auditAck } from "./audit";
import type { AuditActor } from "./audit";
import { SELF_EXEMPTION_ERROR } from "./ack-assignments";
import type { AssignmentAction, AssignmentRequest } from "./ack-assignments";

// The one dispatcher behind the two assignment routes (D2, 1.13.0). Each
// route does its own guards and parsing, then hands a validated request
// here with the document it is bound to (the twin) or none (the admin
// route); every lever in lib/db carries that bound into its WHERE, so the
// twin can never reach another document's rows and the answer lists what
// was skipped. One audit row per row changed, with the person, the reason
// and the dates, so the compliance record explains every gap and every
// moved deadline; a bulk extend adds one summary row. 'reask' is D4's
// per-person re-ask: the rows are grouped by policy and each group goes
// through claimReconfirmation's userIds branch, which moves those people's
// cycle marker, writes the 'reset' ledger row with scope 'users' and queues
// their 'updated' notice, leaving the document marker and everyone else's
// currency alone.

export interface AssignmentContext {
  /** The policy the twin route is bound to; null for the admin route (rows of any policy). */
  doc: { id: number; title: string } | null;
  /** Who is acting, as the rows record it (exempt_by, snoozed_by, due_history.by_id / by_name). */
  actor: AckActor;
  /** The same person, as the audit rows record them, with the request's address. */
  audit: { actor: AuditActor; ip: string | null };
  /** The request's origin, kept on the re-ask notice for its links. */
  origin: string;
}

export interface AssignmentAnswer {
  ok: true;
  action: AssignmentAction;
  /** The assignment ids the action changed. */
  changed: number[];
  /** The ids it did not: unknown, another document than the route's, removed, exempt, or already in that state. */
  skipped: number[];
  /** snooze: when reminders resume (ISO), for the toast and the row's tooltip. */
  until?: string | null;
}

export type AssignmentOutcome =
  | { status: 200; body: AssignmentAnswer }
  | { status: 400; body: { error: string } }
  /** reask: nobody was asked because everyone who could have been was asked again within the hour (the per-person brake). */
  | { status: 429; body: { error: string; skipped: number[] } };

const docOf = (row: AssignmentChange) => ({ id: row.document_id, title: row.title });

/** Whole minutes since an instant, at least one: what "asked again N minutes ago" reads. */
export function minutesSince(iso: string | null): number {
  if (!iso) return 1;
  return Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
}

/**
 * The 429 of a per-person re-ask held by the hour (D4 fix round): "Ana Ruiz
 * was asked again 12 minutes ago." for one person, "These people were asked
 * again 12 minutes ago." for more. The reconfirm route and the assignments
 * routes answer the same sentence.
 */
export async function askedAgainError(userIds: number[], lastAskedAt: string | null): Promise<string> {
  const minutes = minutesSince(lastAskedAt);
  const ago = `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  if (userIds.length === 1) {
    const u = await getUserById(userIds[0]);
    return `${u?.name || u?.username || "This person"} was asked again ${ago}.`;
  }
  return `These people were asked again ${ago}.`;
}

export async function runAssignmentAction(req: AssignmentRequest, ctx: AssignmentContext): Promise<AssignmentOutcome> {
  const docId = ctx.doc?.id ?? null;
  const base = { actor: ctx.audit.actor, ip: ctx.audit.ip, source: "manual" as const };
  const answer = (changed: number[], skipped: number[], extra: Partial<AssignmentAnswer> = {}): AssignmentOutcome => ({
    status: 200,
    body: { ok: true, action: req.action, changed, skipped, ...extra },
  });

  if (req.action === "exempt") {
    const r = await exemptAssignments(docId, req.ids, ctx.actor, { reason: req.reason, until: req.until });
    if (r.self.length) return { status: 400, body: { error: SELF_EXEMPTION_ERROR } };
    for (const row of r.changed) {
      await auditAck("ack.exempted", docOf(row), {
        ...base,
        reason: req.reason,
        details: { assignment_id: row.id, user_id: row.user_id, until: req.until },
      });
    }
    return answer(r.changed.map((c) => c.id), r.skipped);
  }

  if (req.action === "unexempt") {
    const r = await unexemptAssignments(docId, req.ids);
    for (const row of r.changed) {
      await auditAck("ack.exemption_revoked", docOf(row), {
        ...base,
        details: { assignment_id: row.id, user_id: row.user_id, due_at: row.to_at },
      });
    }
    return answer(r.changed.map((c) => c.id), r.skipped);
  }

  if (req.action === "extend") {
    const r = await extendAssignments(docId, req.ids, req.days, req.reason, ctx.actor);
    for (const row of r.changed) {
      await auditAck("ack.due_extended", docOf(row), {
        ...base,
        reason: req.reason,
        details: { assignment_id: row.id, user_id: row.user_id, from: row.from_at, to: row.to_at, days: req.days },
      });
    }
    if (req.ids.length > 1) {
      // The summary the audit log reads at a glance; the per-row entries above are the record.
      await audit({
        actor: ctx.audit.actor,
        ip: ctx.audit.ip,
        action: "ack.bulk_extended",
        targetType: ctx.doc ? "document" : "compliance",
        targetId: ctx.doc?.id ?? null,
        targetLabel: ctx.doc?.title ?? "All policies",
        details: { doc_id: ctx.doc?.id ?? null, n: r.changed.length, days: req.days, reason: req.reason, skipped: r.skipped.length },
      });
    }
    return answer(r.changed.map((c) => c.id), r.skipped);
  }

  if (req.action === "undo_extend") {
    const r = await undoExtension(docId, req.ids);
    for (const row of r.changed) {
      await auditAck("ack.due_extension_undone", docOf(row), {
        ...base,
        details: { assignment_id: row.id, user_id: row.user_id, from: row.from_at, to: row.to_at },
      });
    }
    return answer(r.changed.map((c) => c.id), r.skipped);
  }

  if (req.action === "snooze") {
    const r = await snoozeAssignments(docId, req.ids, req.days, ctx.actor);
    for (const row of r.changed) {
      await auditAck("ack.snoozed", docOf(row), {
        ...base,
        details: { assignment_id: row.id, user_id: row.user_id, until: row.snoozed_until, days: req.days },
      });
    }
    return answer(r.changed.map((c) => c.id), r.skipped, { until: r.changed[0]?.snoozed_until ?? null });
  }

  if (req.action === "unsnooze") {
    const r = await unsnoozeAssignments(docId, req.ids);
    for (const row of r.changed) {
      await auditAck("ack.unsnoozed", docOf(row), {
        ...base,
        details: { assignment_id: row.id, user_id: row.user_id },
      });
    }
    return answer(r.changed.map((c) => c.id), r.skipped);
  }

  // reask: open rows on live policies, grouped by policy; each group is one
  // per-person claim (D4). A group the claim refuses (the policy stopped
  // taking confirmations between the read and the claim) is reported as
  // skipped, not failed. A person asked again within the hour is held by
  // the claim's brake and reported as skipped too; when that is the only
  // reason nobody was asked, the answer is 429 with the sentence the
  // reconfirm route gives, so the roster says why rather than "nothing
  // changed".
  const rows = await reaskableAssignments(docId, req.ids);
  const groups = new Map<number, AssignmentChange[]>();
  for (const row of rows) groups.set(row.document_id, [...(groups.get(row.document_id) ?? []), row]);
  const changed: number[] = [];
  const held: number[] = [];
  let lastAskedAt: string | null = null;
  for (const [documentId, group] of groups) {
    const userIds = group.map((g) => g.user_id);
    const claim = await claimReconfirmation(null, documentId, {
      source: "manual",
      reason: req.reason,
      actor: ctx.actor,
      origin: ctx.origin,
      userIds,
    });
    const cooled = new Set(claim.cooldown ?? []);
    held.push(...group.filter((g) => cooled.has(g.user_id)).map((g) => g.user_id));
    if (!claim.claimed) {
      if (claim.last_asked_at && (lastAskedAt === null || claim.last_asked_at > lastAskedAt)) lastAskedAt = claim.last_asked_at;
      continue;
    }
    // The claim says whose cycle it restarted; a row that closed between
    // the read above and the claim is reported as skipped.
    const reopened = new Set(claim.user_ids);
    changed.push(...group.filter((g) => reopened.has(g.user_id)).map((g) => g.id));
    await auditAck("ack.reconfirmation_requested", { id: documentId, title: group[0].title }, {
      ...base,
      version_id: claim.version_id,
      version: claim.rev,
      reason: req.reason,
      details: {
        scope: "users",
        user_ids: claim.user_ids,
        reset: claim.confirmations_reset,
        eligible: claim.eligible,
        queued: claim.user_ids.length,
        decision_id: claim.decision_id,
        outbox_id: claim.outbox_id,
      },
    });
  }
  if (changed.length === 0 && held.length > 0) {
    return { status: 429, body: { error: await askedAgainError(held, lastAskedAt), skipped: req.ids } };
  }
  return answer(changed, req.ids.filter((id) => !changed.includes(id)));
}
