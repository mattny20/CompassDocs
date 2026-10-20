import "server-only";
import {
  pool,
  getDocument,
  getPolicySettings,
  updatePolicySettings,
  getPolicySet,
  updatePolicySet,
  PolicySetError,
  claimReconfirmation,
  stampAckReminded,
  insertAckOutbox,
  compliancePendingUsers,
  ackSummary,
  canSeeSpace,
  getUserById,
} from "./db";
import type { AckActor, PolicySettingsNumbersPatch } from "./db";
import { enqueueReminder, movePolicyDeadlines, workspaceDueDefaults } from "./compliance";
import { runAssignmentAction, minutesSince } from "./ack-assignment-actions";
import type { AssignmentOutcome } from "./ack-assignment-actions";
import { audit, auditAck } from "./audit";
import type { AuditActor } from "./audit";
import { DUE_RANGES, isDueNumber, parseYmd } from "./ack-due";
import type { DueRule } from "./ack-due";
import {
  ASSIGNMENT_IDS_MAX,
  EXEMPT_REASON_MAX,
  EXTEND_DAYS_DEFAULT,
  EXTEND_DAYS_MAX,
  EXTEND_REASON_MAX,
  REASK_REASON_MIN,
  REASK_REASON_MAX,
} from "./ack-assignments";
import type { Document } from "./types";

// Bulk actions across policies and people (F5, 1.14.0): the request parsing
// and the composition behind POST /api/admin/compliance/bulk. Nothing here
// is a new write: every action composes the writes the programme already
// has (the portal's reminder enqueue, the deadline mover and the
// ack-settings validators, the policy_settings columns the Settings tab
// edits, the A7 re-ask claim per policy, the sets agent's membership
// update, the assignments dispatcher for the people levers) and every
// notice is an outbox row the minute tick delivers, so a request never
// awaits a mailer or a webhook: thirty policies or two hundred people are
// one round trip and a few inserts. The route answers in the shape of
// /api/documents/bulk ({ done, queued, skipped: [{ id, title, reason }] })
// with one summary audit row per call beside the per-policy and per-row
// rows the underlying writes emit.

export const BULK_ACTIONS = [
  "remind",
  "set_deadline",
  "set_owner",
  "set_reminders",
  "reask",
  "add_to_set",
  "remind_people",
  "reask_people",
  "exempt_people",
  "extend_people",
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export const isBulkAction = (v: unknown): v is BulkAction =>
  typeof v === "string" && (BULK_ACTIONS as readonly string[]).includes(v);

/** The actions over `doc_ids` (the Policies bar) and over `user_ids` / `assignment_ids` (the People bar and the record page). */
export const POLICY_BULK_ACTIONS: readonly BulkAction[] = ["remind", "set_deadline", "set_owner", "set_reminders", "reask", "add_to_set"];
export const PEOPLE_BULK_ACTIONS: readonly BulkAction[] = ["remind_people", "reask_people", "exempt_people", "extend_people"];

/** One request names at most this many policies, people or rows: the same cap as the assignments routes (the bars select a page at a time). */
export const BULK_IDS_MAX = ASSIGNMENT_IDS_MAX;

/** A policy or a person reminded inside this window is skipped (the portal's per-policy hour, applied per row for people). */
export const BULK_REMIND_WINDOW_MS = 60 * 60 * 1000;

/** The four reminder numbers a bulk "Set reminders…" writes (policy_settings' columns). */
export const BULK_CADENCE_KEYS = ["remind_before_days", "remind_every_days", "escalate_after_days", "nudge_every_days"] as const;
export type BulkCadenceKey = (typeof BULK_CADENCE_KEYS)[number];

// The 400 sentences, each exported so the test pins it and the client can
// validate inline with the same words.
export const BULK_UNKNOWN_ACTION = "Unknown bulk action.";
export const BULK_DOC_IDS = `Send doc_ids: 1 to ${BULK_IDS_MAX} policy ids.`;
export const BULK_PEOPLE_IDS = `Send user_ids or assignment_ids: 1 to ${BULK_IDS_MAX} ids.`;
export const BULK_IDS_INTEGERS = "Ids must be positive integers.";
export const BULK_REASON_SHORT = `A reason of at least ${REASK_REASON_MIN} characters is required.`;
export const BULK_EXEMPT_REASON = "Enter a reason for the exemption.";
export const BULK_EXEMPT_REASON_LONG = `Keep the reason under ${EXEMPT_REASON_MAX} characters.`;
export const BULK_EXEMPT_DOCS = "Send doc_ids: the policies to exempt from.";
export const BULK_DAYS = `Extend by 1 to ${EXTEND_DAYS_MAX} days.`;
export const BULK_UNTIL = "Pick a date after today.";
export const BULK_OWNER = "'owner_id' must be a user id, or null for nobody.";
export const BULK_OWNER_NOT_FOUND = "Owner not found.";
export const BULK_OWNER_DISABLED = "The owner must be an active account.";
export const BULK_SET_ID = "Send set_id: the set to add the policies to.";
export const BULK_SET_NOT_FOUND = "Set not found.";
export const BULK_SET_DEACTIVATED = "This set is deactivated. Reactivate it first.";
export const BULK_DEADLINE = `Send due_days (1 to ${DUE_RANGES.due_days.max}) or due_at (YYYY-MM-DD), or both null to inherit.`;
export const BULK_DEADLINE_PAST = "The deadline cannot be in the past.";
export const BULK_REMINDERS = `Send at least one of ${BULK_CADENCE_KEYS.join(", ")}.`;
export const BULK_MOVE_EXISTING = "'move_existing' must be true or false.";

export interface BulkParams {
  /** extend_people: whole days, 1..365 (7 when absent). */
  days: number;
  /** reask / reask_people: at least ten characters; exempt_people: required; extend_people: optional. Trimmed and bounded. */
  reason: string;
  /** exempt_people: YYYY-MM-DD after today, or null for a standing exemption. */
  until: string | null;
  /** set_owner: the account, or null for nobody (the cascade's fallback). */
  owner_id: number | null;
  /** add_to_set. */
  set_id: number;
  /** set_deadline: the policy's own rule (both null = inherit; one of the two set). */
  due: DueRule;
  /** set_deadline: recompute every open row's deadline from the rule (a fixed date always moves them). */
  move_existing: boolean;
  /** set_reminders: the keys present are written (null = inherit); absent keys are untouched. */
  cadence: Pick<PolicySettingsNumbersPatch, BulkCadenceKey>;
}

export interface BulkRequest {
  action: BulkAction;
  /** The policies (the policy actions; exempt_people's chosen policies). */
  doc_ids: number[];
  /** The people (the people actions). */
  user_ids: number[];
  /** The single-assignment form of a people action: these rows rather than every row of the named people. */
  assignment_ids: number[];
  params: BulkParams;
}

export type ParsedBulkRequest = { ok: true; req: BulkRequest } | { ok: false; error: string };

/** One policy, person or row the call did not touch, and why (the documents bulk route's shape). */
export interface BulkSkipped {
  id: number;
  title: string;
  reason: string;
}

/** What a policy held before a reversible bulk write, keyed by policy, so the client's Undo re-sends it exactly. */
export interface BulkPrevious {
  id: number;
  due_days?: number | null;
  due_at?: string | null;
  owner_id?: number | null;
  remind_before_days?: number | null;
  remind_every_days?: number | null;
  escalate_after_days?: number | null;
  nudge_every_days?: number | null;
}

export interface BulkAnswer {
  ok: true;
  action: BulkAction;
  /** Policies changed (the policy actions) or rows changed (the people actions). */
  done: number;
  /** People a notice was queued for (remind, reask, remind_people, reask_people); 0 for the silent actions. */
  queued: number;
  skipped: BulkSkipped[];
  /** set_deadline, set_owner, set_reminders: each changed policy's previous values (the Undo). */
  previous?: BulkPrevious[];
  /** The people actions through the assignments dispatcher: the assignment ids changed (Undo is the inverse call on /assignments). */
  changed?: number[];
  /** The people actions: distinct accounts among the rows changed (the toast's "{n} people"). */
  people?: number;
  /** reask: confirmations reset across the policies. */
  reset?: number;
}

export type BulkOutcome =
  | { status: 200; body: BulkAnswer }
  | { status: 400 | 404 | 409; body: { error: string } }
  | { status: 429; body: { error: string; skipped: number[] } };

export interface BulkContext {
  /** Who is acting, as the rows and the outbox record them. */
  actor: AckActor;
  /** The same person, as the audit rows record them, with the request's address. */
  audit: { actor: AuditActor; ip: string | null };
  /** The request's origin, kept on every outbox row for its links. */
  origin: string;
}

// --- Parsing --------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A list of positive safe integers, deduped in order; null when the value is not such a list ([] when absent). */
function idList(raw: unknown): number[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** YYYY-MM-DD that is a real calendar date. */
function isCalendarDate(s: string): boolean {
  return DATE_RE.test(s) && parseYmd(s) !== null;
}

const todayYmd = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Validate a request body: the action, the id lists and their cap, then
 * the action's own parameters, naming the first problem. The people actions
 * take `user_ids` (every open row of those people, exempt_people on the
 * chosen `doc_ids`) or `assignment_ids` (those rows only: the record page's
 * one person, the roster's selection); the policy actions take `doc_ids`.
 * `now` is injectable for the test.
 */
export function parseBulkRequest(body: unknown, now: Date = new Date()): ParsedBulkRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send a JSON object." };
  const b = body as Record<string, unknown>;
  if (!isBulkAction(b.action)) return { ok: false, error: BULK_UNKNOWN_ACTION };
  const action = b.action;
  const p = (b.params && typeof b.params === "object" && !Array.isArray(b.params) ? b.params : {}) as Record<string, unknown>;

  const docIds = idList(b.doc_ids);
  const userIds = idList(b.user_ids);
  const assignmentIds = idList(b.assignment_ids);
  if (docIds === null || userIds === null || assignmentIds === null) return { ok: false, error: BULK_IDS_INTEGERS };
  if (docIds.length > BULK_IDS_MAX) return { ok: false, error: BULK_DOC_IDS };
  if (userIds.length > BULK_IDS_MAX || assignmentIds.length > BULK_IDS_MAX) return { ok: false, error: BULK_PEOPLE_IDS };

  const people = PEOPLE_BULK_ACTIONS.includes(action);
  if (!people && docIds.length < 1) return { ok: false, error: BULK_DOC_IDS };
  if (people && userIds.length < 1 && assignmentIds.length < 1) return { ok: false, error: BULK_PEOPLE_IDS };

  const reasonRaw = typeof p.reason === "string" ? p.reason.trim() : "";
  const req: BulkRequest = {
    action,
    doc_ids: docIds,
    user_ids: userIds,
    assignment_ids: assignmentIds,
    params: {
      days: 0,
      reason: "",
      until: null,
      owner_id: null,
      set_id: 0,
      due: { due_days: null, due_at: null },
      move_existing: false,
      cadence: {},
    },
  };

  if (action === "reask" || action === "reask_people") {
    const reason = reasonRaw.slice(0, REASK_REASON_MAX);
    if (reason.length < REASK_REASON_MIN) return { ok: false, error: BULK_REASON_SHORT };
    req.params.reason = reason;
  } else if (action === "exempt_people") {
    if (!reasonRaw) return { ok: false, error: BULK_EXEMPT_REASON };
    if (reasonRaw.length > EXEMPT_REASON_MAX) return { ok: false, error: BULK_EXEMPT_REASON_LONG };
    req.params.reason = reasonRaw;
    if (assignmentIds.length === 0 && docIds.length === 0) return { ok: false, error: BULK_EXEMPT_DOCS };
    const until = p.until;
    if (until !== undefined && until !== null && until !== "") {
      if (typeof until !== "string" || !isCalendarDate(until) || until <= todayYmd(now)) return { ok: false, error: BULK_UNTIL };
      req.params.until = until;
    }
  } else if (action === "extend_people") {
    const raw = p.days;
    const days = raw === undefined || raw === null || raw === "" ? EXTEND_DAYS_DEFAULT : typeof raw === "string" ? Number(raw) : raw;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > EXTEND_DAYS_MAX) return { ok: false, error: BULK_DAYS };
    req.params.days = days;
    req.params.reason = reasonRaw.slice(0, EXTEND_REASON_MAX);
  } else if (action === "set_owner") {
    const owner = p.owner_id;
    if (!(owner === null || (typeof owner === "number" && Number.isSafeInteger(owner) && owner > 0))) return { ok: false, error: BULK_OWNER };
    req.params.owner_id = owner as number | null;
  } else if (action === "add_to_set") {
    const setId = p.set_id;
    if (typeof setId !== "number" || !Number.isSafeInteger(setId) || setId <= 0) return { ok: false, error: BULK_SET_ID };
    req.params.set_id = setId;
  } else if (action === "set_deadline") {
    const hasDays = Object.prototype.hasOwnProperty.call(p, "due_days");
    const hasAt = Object.prototype.hasOwnProperty.call(p, "due_at");
    if (!hasDays && !hasAt) return { ok: false, error: BULK_DEADLINE };
    const days = hasDays ? p.due_days : null;
    const at = hasAt ? p.due_at : null;
    if (!(days === null || isDueNumber("due_days", days))) return { ok: false, error: BULK_DEADLINE };
    let ymd: string | null = null;
    if (at !== null && at !== "") {
      if (typeof at !== "string" || !isCalendarDate(at.trim().slice(0, 10))) return { ok: false, error: BULK_DEADLINE };
      ymd = at.trim().slice(0, 10);
      if (ymd < todayYmd(now)) return { ok: false, error: BULK_DEADLINE_PAST };
    }
    // One rule, not two: a fixed date and a number of days cannot both apply.
    if (days !== null && ymd !== null) return { ok: false, error: BULK_DEADLINE };
    req.params.due = { due_days: (days as number | null) ?? null, due_at: ymd };
    if (p.move_existing !== undefined) {
      if (typeof p.move_existing !== "boolean") return { ok: false, error: BULK_MOVE_EXISTING };
      req.params.move_existing = p.move_existing;
    }
  } else if (action === "set_reminders") {
    const cadence: Pick<PolicySettingsNumbersPatch, BulkCadenceKey> = {};
    for (const key of BULK_CADENCE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(p, key)) continue;
      const v = p[key];
      if (v === null) cadence[key] = null;
      else if (isDueNumber(key, v)) cadence[key] = v;
      else {
        const r = DUE_RANGES[key];
        return { ok: false, error: `'${key}' must be a whole number from ${r.min} to ${r.max}, or null to inherit.` };
      }
    }
    if (Object.keys(cadence).length === 0) return { ok: false, error: BULK_REMINDERS };
    req.params.cadence = cadence;
  }
  return { ok: true, req };
}

// --- Reads ---------------------------------------------------------------------

/** One assignment row of a live policy, as the people actions pick them. */
export interface BulkRow {
  id: number;
  document_id: number;
  user_id: number;
  title: string;
  user_name: string;
  due_at: string | null;
  reminded_at: string | null;
  exempt: boolean;
  /** A confirmation stands against the current ask (the document marker or the row's own cycle, whichever is later). */
  confirmed: boolean;
  /** Past the due date and the policy's grace (the space's, else the workspace's, else none). */
  overdue: boolean;
}

/**
 * The assignment rows the people actions start from: rows (not removed) of
 * active accounts on live policies (published, required, not retired, not
 * a branch), bounded by the people, the policies and the row ids named.
 * Exempt and confirmed rows are returned with their flags so each action
 * picks the rows it applies to. The levers in lib/db re-check everything
 * (the document bound, the row's state) inside their own WHERE.
 */
export async function bulkRows(opts: {
  userIds?: number[] | null;
  docIds?: number[] | null;
  assignmentIds?: number[] | null;
  /** The workspace's overdue_grace_days (the space's layer wins); 0 when unset. */
  grace: number;
}): Promise<BulkRow[]> {
  const r = await pool().query<BulkRow>(
    `SELECT pa.id, pa.document_id, pa.user_id, d.title, COALESCE(NULLIF(u.name, ''), u.username) AS user_name,
            pa.due_at, pa.reminded_at, (pa.exempt_at IS NOT NULL) AS exempt,
            EXISTS (
              SELECT 1 FROM acknowledgements a
              WHERE a.document_id = d.id AND a.user_id = pa.user_id
                AND a.acknowledged_at >= GREATEST(d.ack_revision_at, pa.cycle_started_at)
            ) AS confirmed,
            (pa.due_at IS NOT NULL
              AND pa.due_at + make_interval(days => COALESCE((s.policy_defaults->>'overdue_grace_days')::int, $4::int, 0)) < now()) AS overdue
       FROM policy_assignments pa
       JOIN documents d ON d.id = pa.document_id
       JOIN spaces s ON s.id = d.space_id
       JOIN users u ON u.id = pa.user_id
      WHERE pa.removed_at IS NULL AND u.status = 'active'
        AND d.ack_required = 1 AND d.status = 'published' AND d.deleted_at IS NULL
        AND d.branch_of IS NULL AND d.ack_retired_at IS NULL
        AND ($1::int[] IS NULL OR pa.user_id = ANY($1::int[]))
        AND ($2::int[] IS NULL OR pa.document_id = ANY($2::int[]))
        AND ($3::int[] IS NULL OR pa.id = ANY($3::int[]))
      ORDER BY pa.user_id, lower(d.title), pa.document_id`,
    [opts.userIds?.length ? opts.userIds : null, opts.docIds?.length ? opts.docIds : null, opts.assignmentIds?.length ? opts.assignmentIds : null, opts.grace]
  );
  return r.rows;
}

/** The named accounts' display names and status, for the skipped list. */
async function peopleNamed(ids: number[]): Promise<Map<number, { name: string; status: string }>> {
  const out = new Map<number, { name: string; status: string }>();
  if (ids.length === 0) return out;
  const r = await pool().query<{ id: number; name: string; status: string }>(
    `SELECT id, COALESCE(NULLIF(name, ''), username) AS name, status FROM users WHERE id = ANY($1::int[])`,
    [ids]
  );
  for (const row of r.rows) out.set(row.id, { name: row.name, status: row.status });
  return out;
}

/** One policy among the selected people's rows (GET /api/admin/compliance/bulk?user_ids=…: the "Exempt from…" picker). */
export interface BulkPeoplePolicy {
  id: number;
  title: string;
  /** People among those named with a row that is not exempt. */
  people: number;
  /** Of them, people without a current confirmation. */
  open: number;
  /** Of them, people whose confirmation stands. */
  confirmed: number;
}

/** The live policies the named people owe (exempt rows left out), by title: what "Exempt from…" and the record page list. */
export async function bulkPeoplePolicies(userIds: number[]): Promise<BulkPeoplePolicy[]> {
  const grace = (await workspaceDueDefaults()).overdue_grace_days ?? 0;
  const rows = await bulkRows({ userIds, grace });
  const byDoc = new Map<number, BulkPeoplePolicy>();
  for (const r of rows) {
    if (r.exempt) continue;
    const p = byDoc.get(r.document_id) ?? { id: r.document_id, title: r.title, people: 0, open: 0, confirmed: 0 };
    p.people++;
    if (r.confirmed) p.confirmed++;
    else p.open++;
    byDoc.set(r.document_id, p);
  }
  return [...byDoc.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);
}

// --- The composition -----------------------------------------------------------

const withinWindow = (iso: string | null | undefined, now = Date.now()) =>
  Boolean(iso) && now - new Date(iso!).getTime() < BULK_REMIND_WINDOW_MS;

const minutesAgo = (iso: string | null) => {
  const n = minutesSince(iso);
  return `${n} ${n === 1 ? "minute" : "minutes"} ago`;
};

/** Why a document is not a live policy, or null when it is one. */
function notLive(doc: Document | undefined): string | null {
  if (!doc) return "not found";
  if (doc.ack_retired_at) return "retired";
  if (doc.branch_of) return "a draft branch";
  if (doc.status !== "published") return "paused (unpublished)";
  if (doc.ack_required !== 1) return "doesn't ask for a read confirmation";
  return null;
}

/** One summary row per call (the audit log's glance); the per-policy and per-row rows are the record. */
async function summary(ctx: BulkContext, action: string, details: Record<string, unknown>): Promise<void> {
  await audit({
    actor: ctx.audit.actor,
    ip: ctx.audit.ip,
    action,
    targetType: "compliance",
    targetId: null,
    targetLabel: "All policies",
    details,
  });
}

type Live = Document & { title: string };

/** The live policies among the ids, in the order given, with the rest reported. */
async function livePolicies(ids: number[], skipped: BulkSkipped[]): Promise<Live[]> {
  const out: Live[] = [];
  for (const id of ids) {
    const doc = await getDocument(id);
    const why = notLive(doc);
    if (why || !doc) {
      skipped.push({ id, title: doc?.title ?? `#${id}`, reason: why ?? "not found" });
      continue;
    }
    out.push(doc);
  }
  return out;
}

export async function runBulkAction(req: BulkRequest, ctx: BulkContext): Promise<BulkOutcome> {
  const skipped: BulkSkipped[] = [];
  const base = { actor: ctx.audit.actor, ip: ctx.audit.ip, source: "manual" as const };
  const ok = (body: Omit<BulkAnswer, "ok" | "action" | "skipped">): BulkOutcome => ({
    status: 200,
    body: { ok: true, action: req.action, skipped, ...body },
  });

  // ── The policy actions ─────────────────────────────────────────────────────

  if (req.action === "remind") {
    // The portal's Remind per policy: the one-hour claim (enqueueReminder
    // stamps and tests it in one UPDATE), the 'reminder' outbox row for
    // everyone still pending, then the rows stamped for the cadence. A
    // policy inside the hour, or with nobody pending, is skipped and says so.
    let done = 0;
    let queued = 0;
    const docIds: number[] = [];
    for (const doc of await livePolicies(req.doc_ids, skipped)) {
      if (withinWindow(doc.ack_last_reminded_at)) {
        skipped.push({ id: doc.id, title: doc.title, reason: `reminded ${minutesAgo(doc.ack_last_reminded_at ?? null)}` });
        continue;
      }
      const pending = await compliancePendingUsers(doc.id);
      if (pending.length === 0) {
        skipped.push({ id: doc.id, title: doc.title, reason: "nobody pending" });
        continue;
      }
      const r = await enqueueReminder(doc, ctx.actor, ctx.origin);
      if (!r.claimed) {
        skipped.push({ id: doc.id, title: doc.title, reason: `reminded ${minutesAgo(doc.ack_last_reminded_at ?? null)}` });
        continue;
      }
      await stampAckReminded(doc.id).catch((e) => console.error("[ack] could not stamp the bulk reminder on the assignments:", e));
      done++;
      queued += r.queued;
      docIds.push(doc.id);
    }
    await summary(ctx, "ack.bulk_remind", { policies: done, queued, skipped: skipped.length, doc_ids: docIds, skipped_ids: skipped.map((s) => s.id) });
    return ok({ done, queued });
  }

  if (req.action === "set_deadline") {
    // The Settings tab's Deadline card, per policy: the rule written through
    // the same setter, the open rows moved when asked (or always for a fixed
    // date, a promise to the audience), ack.due_set per policy as the
    // ack-settings route writes it, and the previous rule on the answer for
    // the Undo (the page holds the stored rule too, but the answer is the
    // truth of what each policy held at the moment of the write).
    const { due, move_existing } = req.params;
    const previous: BulkPrevious[] = [];
    let done = 0;
    let movedAll = 0;
    for (const doc of await livePolicies(req.doc_ids, skipped)) {
      const before = await getPolicySettings(doc.id);
      const fromRule: DueRule = { due_days: before?.due_days ?? null, due_at: before?.due_at ?? null };
      const after = await updatePolicySettings(doc.id, { due_days: due.due_days, due_at: due.due_at });
      const toRule: DueRule = { due_days: after?.due_days ?? null, due_at: after?.due_at ?? null };
      const ruleChanged = fromRule.due_days !== toRule.due_days || fromRule.due_at !== toRule.due_at;
      const fixedChanged = toRule.due_at !== null && toRule.due_at !== fromRule.due_at;
      const shouldMove = move_existing || fixedChanged;
      if (!ruleChanged && !shouldMove) {
        skipped.push({ id: doc.id, title: doc.title, reason: "already set" });
        continue;
      }
      let moved = 0;
      if (shouldMove) moved = (await movePolicyDeadlines(doc, toRule, { fromRule, actor: ctx.actor, ip: ctx.audit.ip })).moved;
      movedAll += moved;
      await auditAck("ack.due_set", doc, {
        ...base,
        details: { due_days: toRule.due_days, due_at: toRule.due_at, from_rule: fromRule, moved_existing: shouldMove, moved, via: "bulk" },
      });
      previous.push({ id: doc.id, due_days: fromRule.due_days, due_at: fromRule.due_at });
      done++;
    }
    await summary(ctx, "ack.bulk_due_set", {
      policies: done,
      due_days: due.due_days,
      due_at: due.due_at,
      move_existing,
      moved: movedAll,
      skipped: skipped.length,
      doc_ids: previous.map((p) => p.id),
    });
    return ok({ done, queued: 0, previous });
  }

  if (req.action === "set_owner") {
    // The Reminders card's owner, per policy: judged as the ack-settings
    // route judges it (an existing, active account that can see the
    // policy's space, else the escalation would name someone who cannot
    // open it), written through the same setter and audited per policy as
    // the policy layer of the defaults cascade.
    const ownerId = req.params.owner_id;
    if (ownerId !== null) {
      const owner = await getUserById(ownerId);
      if (!owner) return { status: 400, body: { error: BULK_OWNER_NOT_FOUND } };
      if (owner.status !== "active") return { status: 400, body: { error: BULK_OWNER_DISABLED } };
    }
    const previous: BulkPrevious[] = [];
    let done = 0;
    for (const doc of await livePolicies(req.doc_ids, skipped)) {
      if (ownerId !== null && !(await canSeeSpace(ownerId, doc.space_id))) {
        skipped.push({ id: doc.id, title: doc.title, reason: "the owner can't see this policy's space" });
        continue;
      }
      const before = await getPolicySettings(doc.id);
      const from = before?.owner_user_id ?? null;
      if (from === ownerId) {
        skipped.push({ id: doc.id, title: doc.title, reason: "already the owner" });
        continue;
      }
      const after = await updatePolicySettings(doc.id, { owner_user_id: ownerId });
      await auditAck("ack.defaults_set", doc, {
        ...base,
        details: { scope: "policy", space_id: doc.space_id, key: "owner_user_id", from, to: after?.owner_user_id ?? null, via: "bulk" },
      });
      previous.push({ id: doc.id, owner_id: from });
      done++;
    }
    await summary(ctx, "ack.bulk_owner_set", { policies: done, owner_id: ownerId, skipped: skipped.length, doc_ids: previous.map((p) => p.id) });
    return ok({ done, queued: 0, previous });
  }

  if (req.action === "set_reminders") {
    // The Reminders card's four numbers, per policy, through the same
    // setter and the same per-key audit row; a policy already holding every
    // number sent is skipped. The previous numbers ride on the answer.
    const cadence = req.params.cadence;
    const keys = BULK_CADENCE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(cadence, k));
    const previous: BulkPrevious[] = [];
    let done = 0;
    for (const doc of await livePolicies(req.doc_ids, skipped)) {
      const before = await getPolicySettings(doc.id);
      const changedKeys = keys.filter((k) => (before?.[k] ?? null) !== (cadence[k] ?? null));
      if (changedKeys.length === 0) {
        skipped.push({ id: doc.id, title: doc.title, reason: "already set" });
        continue;
      }
      const after = await updatePolicySettings(doc.id, cadence);
      for (const key of changedKeys) {
        await auditAck("ack.defaults_set", doc, {
          ...base,
          details: { scope: "policy", space_id: doc.space_id, key, from: before?.[key] ?? null, to: after?.[key] ?? null, via: "bulk" },
        });
      }
      const prev: BulkPrevious = { id: doc.id };
      for (const key of keys) prev[key] = before?.[key] ?? null;
      previous.push(prev);
      done++;
    }
    await summary(ctx, "ack.bulk_reminders_set", { policies: done, keys, cadence, skipped: skipped.length, doc_ids: previous.map((p) => p.id) });
    return ok({ done, queued: 0, previous });
  }

  if (req.action === "reask") {
    // A7's atomic reset per policy: the marker moves, the 'reset' ledger row
    // and the immediate 'updated' notice are written in the claim's own
    // transaction, and the one-hour guard (shared with Remind) refuses a
    // policy asked or reminded within the hour, which is reported as skipped
    // with the minutes. A policy nobody has confirmed has nothing to reset
    // (the row control is disabled there) and is skipped too.
    let done = 0;
    let queued = 0;
    let reset = 0;
    const docIds: number[] = [];
    for (const doc of await livePolicies(req.doc_ids, skipped)) {
      const standing = await ackSummary(doc.id);
      if (standing.current === 0) {
        skipped.push({ id: doc.id, title: doc.title, reason: "nobody has confirmed this version yet" });
        continue;
      }
      const claim = await claimReconfirmation(null, doc.id, { source: "manual", reason: req.params.reason, actor: ctx.actor, origin: ctx.origin });
      if (!claim.claimed) {
        skipped.push({
          id: doc.id,
          title: doc.title,
          reason: claim.last_asked_at ? `asked again ${minutesAgo(claim.last_asked_at)}` : "doesn't ask for a read confirmation",
        });
        continue;
      }
      await auditAck("ack.reconfirmation_requested", doc, {
        ...base,
        version_id: claim.version_id,
        version: claim.rev,
        reason: req.params.reason,
        details: {
          scope: claim.scope,
          reset: claim.confirmations_reset,
          eligible: claim.eligible,
          queued: claim.eligible,
          user_ids: null,
          skipped: null,
          cooldown: null,
          decision_id: claim.decision_id,
          outbox_id: claim.outbox_id,
          via: "bulk",
        },
      });
      done++;
      queued += claim.eligible;
      reset += claim.confirmations_reset;
      docIds.push(doc.id);
    }
    await summary(ctx, "ack.bulk_reasked", { scope: "all", policies: done, reset, queued, reason: req.params.reason, skipped: skipped.length, doc_ids: docIds });
    return ok({ done, queued, reset });
  }

  if (req.action === "add_to_set") {
    // The sets agent's membership update: the set's list replaced with the
    // members it has plus the policies added, in that order (PATCH doc_ids
    // replaces the whole list). Nothing is assigned here: a set reaches
    // people through the Sets page's Assign, and the audiences of the
    // policies added stay as they were.
    const set = await getPolicySet(req.params.set_id);
    if (!set) return { status: 404, body: { error: BULK_SET_NOT_FOUND } };
    if (set.active !== 1) return { status: 409, body: { error: BULK_SET_DEACTIVATED } };
    const members = new Set(set.docs.map((d) => d.id));
    const adds: number[] = [];
    for (const id of req.doc_ids) {
      if (members.has(id)) {
        skipped.push({ id, title: set.docs.find((d) => d.id === id)?.title ?? `#${id}`, reason: "already in the set" });
        continue;
      }
      const doc = await getDocument(id);
      // A member must be a published, unretired, non-branch document (the
      // sets agent's rule); the requirement need not be on yet.
      if (!doc || doc.status !== "published" || doc.ack_retired_at || doc.branch_of) {
        skipped.push({ id, title: doc?.title ?? `#${id}`, reason: notLive(doc) ?? "not a published policy" });
        continue;
      }
      adds.push(id);
    }
    if (adds.length > 0) {
      try {
        const r = await updatePolicySet(set.id, { doc_ids: [...set.docs.map((d) => d.id), ...adds] });
        await audit({
          actor: ctx.audit.actor,
          ip: ctx.audit.ip,
          action: "ack.set_updated",
          targetType: "policy_set",
          targetId: set.id,
          targetLabel: set.name,
          details: { set: set.name, set_id: set.id, changed: ["doc_ids"], policies: r?.after.docs.length ?? members.size + adds.length, added: adds, via: "bulk" },
        });
      } catch (e) {
        if (e instanceof PolicySetError) return { status: e.status, body: { error: e.message } };
        throw e;
      }
    }
    await summary(ctx, "ack.bulk_added_to_set", { set: set.name, set_id: set.id, policies: adds.length, doc_ids: adds, skipped: skipped.length });
    return ok({ done: adds.length, queued: 0 });
  }

  // ── The people actions ─────────────────────────────────────────────────────

  const grace = (await workspaceDueDefaults()).overdue_grace_days ?? 0;
  const byRows = req.assignment_ids.length > 0;
  const rows = await bulkRows({
    userIds: byRows ? null : req.user_ids,
    docIds: req.action === "exempt_people" && !byRows ? req.doc_ids : null,
    assignmentIds: byRows ? req.assignment_ids : null,
    grace,
  });
  const named = byRows ? new Map<number, { name: string; status: string }>() : await peopleNamed(req.user_ids);
  const nameOf = (userId: number) => rows.find((r) => r.user_id === userId)?.user_name ?? named.get(userId)?.name ?? `#${userId}`;
  /** The people the request named: the list, or the owners of the rows named. */
  const requested = byRows ? [...new Set(rows.map((r) => r.user_id))] : req.user_ids;
  /** Report every requested person the rows reached do not cover, with the reason the caller decides. */
  const reportPeople = (reached: Set<number>, why: (userId: number) => string) => {
    for (const userId of requested) {
      if (reached.has(userId)) continue;
      const account = named.get(userId);
      if (!byRows && !account) skipped.push({ id: userId, title: `#${userId}`, reason: "not found" });
      else if (!byRows && account && account.status !== "active") skipped.push({ id: userId, title: account.name, reason: "account disabled" });
      else skipped.push({ id: userId, title: nameOf(userId), reason: why(userId) });
    }
    if (byRows) {
      const seen = new Set(rows.map((r) => r.id));
      for (const id of req.assignment_ids) if (!seen.has(id)) skipped.push({ id, title: `#${id}`, reason: "not an open row of a live policy" });
    }
  };

  if (req.action === "remind_people") {
    // "Remind about everything outstanding": one 'due' outbox row per policy
    // naming the people reminded, with each person's due date and overdue
    // flag in the payload, exactly as the sweep queues its own; the drain
    // then bundles a person named on more than DUE_BUNDLE_OVER rows of a
    // batch into one notice listing their policies and words the rest per
    // row. The rows are stamped so the automatic cadence counts from here.
    // A row reminded inside the hour is skipped (the per-policy hour,
    // applied per row); a person with nothing outstanding is reported.
    const open = rows.filter((r) => !r.exempt && !r.confirmed);
    const fresh = open.filter((r) => !withinWindow(r.reminded_at));
    const byDoc = new Map<number, BulkRow[]>();
    for (const r of fresh) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), r]);
    const outboxIds: number[] = [];
    for (const [docId, group] of byDoc) {
      const userIds = group.map((g) => g.user_id);
      const outboxId = await insertAckOutbox(null, {
        document_id: docId,
        mode: "due",
        source: "manual",
        actor: ctx.actor,
        user_ids: userIds,
        origin: ctx.origin,
        delay_minutes: 0,
        payload: { rows: group.map((g) => ({ user_id: g.user_id, due_at: g.due_at, overdue: g.overdue })) },
      });
      outboxIds.push(outboxId);
      await stampAckReminded(docId, userIds).catch((e) => console.error("[ack] could not stamp the bulk reminder on the assignments:", e));
    }
    const reached = new Set(fresh.map((r) => r.user_id));
    reportPeople(reached, (userId) => {
      const held = open.filter((r) => r.user_id === userId);
      if (held.length === 0) return "nothing outstanding";
      const newest = held.map((r) => r.reminded_at).filter((x): x is string => Boolean(x)).sort().pop() ?? null;
      return `reminded ${minutesAgo(newest)}`;
    });
    await summary(ctx, "ack.bulk_people_reminded", {
      people: reached.size,
      rows: fresh.length,
      policies: byDoc.size,
      outbox_ids: outboxIds,
      user_ids: [...reached],
      skipped: skipped.length,
    });
    return ok({ done: fresh.length, queued: reached.size });
  }

  // The three levers through the assignments dispatcher (D2, D4): the rows
  // each applies to, the dispatcher's own per-row audit rows and brakes,
  // and the changed assignment ids on the answer so the toast's Undo is the
  // inverse call on /assignments, as the roster's is.
  const pass = (outcome: AssignmentOutcome, extra: { reached: Set<number>; why: (userId: number) => string }): BulkOutcome => {
    if (outcome.status !== 200) return outcome;
    const changed = outcome.body.changed;
    const changedRows = rows.filter((r) => changed.includes(r.id));
    const people = new Set(changedRows.map((r) => r.user_id));
    reportPeople(people, (userId) => (extra.reached.has(userId) ? "skipped (exempt, removed or already in that state)" : extra.why(userId)));
    return ok({ done: changed.length, queued: 0, changed, people: people.size });
  };
  const dispatch = (req2: { action: "reask" | "exempt" | "extend"; ids: number[]; days: number; reason: string; until: string | null }) =>
    runAssignmentAction(req2, { doc: null, actor: ctx.actor, audit: ctx.audit, origin: ctx.origin });

  if (req.action === "reask_people") {
    // The rows with a confirmation to lapse; the dispatcher groups them by
    // policy and runs the per-person claim (the ledger row, the notice, the
    // per-person hour brake) for each.
    const targets = rows.filter((r) => !r.exempt && r.confirmed);
    const reached = new Set(targets.map((r) => r.user_id));
    const why = () => "nothing to re-confirm";
    if (targets.length === 0) {
      reportPeople(new Set(), why);
      await summary(ctx, "ack.bulk_reasked", { scope: "users", people: 0, rows: 0, reason: req.params.reason, skipped: skipped.length });
      return ok({ done: 0, queued: 0, changed: [] });
    }
    const outcome = await dispatch({ action: "reask", ids: targets.map((r) => r.id), days: 0, reason: req.params.reason, until: null });
    const out = pass(outcome, { reached, why });
    if (out.status !== 200) return out;
    const people = new Set(rows.filter((r) => out.body.changed!.includes(r.id)).map((r) => r.user_id));
    await summary(ctx, "ack.bulk_reasked", {
      scope: "users",
      people: people.size,
      rows: out.body.done,
      reason: req.params.reason,
      user_ids: [...people],
      skipped: skipped.length,
    });
    // The people re-asked are the people notified.
    return { status: 200, body: { ...out.body, queued: people.size } };
  }

  if (req.action === "exempt_people") {
    const targets = rows.filter((r) => !r.exempt);
    const reached = new Set(targets.map((r) => r.user_id));
    const why = (userId: number) => (rows.some((r) => r.user_id === userId) ? "already exempt" : "no open row on the chosen policies");
    if (targets.length === 0) {
      reportPeople(new Set(), why);
      await summary(ctx, "ack.bulk_exempted", { people: 0, rows: 0, reason: req.params.reason, until: req.params.until, skipped: skipped.length });
      return ok({ done: 0, queued: 0, changed: [] });
    }
    const outcome = await dispatch({ action: "exempt", ids: targets.map((r) => r.id), days: 0, reason: req.params.reason, until: req.params.until });
    const out = pass(outcome, { reached, why });
    if (out.status !== 200) return out;
    const people = new Set(rows.filter((r) => out.body.changed!.includes(r.id)).map((r) => r.user_id));
    await summary(ctx, "ack.bulk_exempted", {
      people: people.size,
      rows: out.body.done,
      policies: new Set(rows.filter((r) => out.body.changed!.includes(r.id)).map((r) => r.document_id)).size,
      reason: req.params.reason,
      until: req.params.until,
      user_ids: [...people],
      skipped: skipped.length,
    });
    return out;
  }

  // extend_people: the open, unconfirmed rows of the people, each pushed out
  // by the days (escalation and snooze cleared, due_history kept). The
  // dispatcher writes ack.due_extended per row and, for more than one row,
  // the ack.bulk_extended summary itself; this call writes that summary
  // only when the dispatcher did not, so a call is one summary row.
  const targets = rows.filter((r) => !r.exempt && !r.confirmed);
  const reached = new Set(targets.map((r) => r.user_id));
  const why = () => "nothing outstanding";
  const { days, reason } = req.params;
  if (targets.length === 0) {
    reportPeople(new Set(), why);
    await summary(ctx, "ack.bulk_extended", { doc_id: null, n: 0, people: 0, days, reason, skipped: skipped.length });
    return ok({ done: 0, queued: 0, changed: [] });
  }
  const outcome = await dispatch({ action: "extend", ids: targets.map((r) => r.id), days, reason, until: null });
  const out = pass(outcome, { reached, why });
  if (out.status !== 200) return out;
  if (targets.length <= 1) {
    await summary(ctx, "ack.bulk_extended", { doc_id: null, n: out.body.done, people: reached.size, days, reason, skipped: skipped.length });
  }
  return out;
}
