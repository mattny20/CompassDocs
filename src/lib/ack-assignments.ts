// Exemptions, extensions, snooze and the per-person re-ask (D2 and D4,
// 1.13.0): the vocabulary, the limits, the copy and the request parsing the
// two action routes share (POST /api/admin/compliance/assignments and its
// space-scoped twin POST /api/documents/[id]/acknowledgements/actions).
//
// Pure: no database and no server-only import, so the roster (wave 2) can
// take the copy and the limits from here without pulling the server in,
// and the test pins every rule the routes answer 400 with.

export const ASSIGNMENT_ACTIONS = ["exempt", "unexempt", "extend", "undo_extend", "snooze", "unsnooze", "reask"] as const;
export type AssignmentAction = (typeof ASSIGNMENT_ACTIONS)[number];
export const isAssignmentAction = (v: unknown): v is AssignmentAction =>
  typeof v === "string" && (ASSIGNMENT_ACTIONS as readonly string[]).includes(v);

/** One request moves at most this many rows (the roster's bulk bar selects a page at a time). */
export const ASSIGNMENT_IDS_MAX = 200;

/** The exemption reason is required and kept to this length (policy_assignments.exempt_reason). */
export const EXEMPT_REASON_MAX = 300;

/** Extend: the dialog's initial value and its bounds (days). */
export const EXTEND_DAYS_DEFAULT = 7;
export const EXTEND_DAYS_MAX = 365;
/** The optional extension reason, cut as every other compliance reason is (ACK_REASON_MAX). */
export const EXTEND_REASON_MAX = 500;

/** Snooze: the row action's duration when none is sent, and the cap. */
export const SNOOZE_DAYS_DEFAULT = 7;
export const SNOOZE_DAYS_MAX = 30;

/** A per-person re-ask needs a reason of this length, as the whole-audience re-ask does (ACK_REASON_MIN; the test pins the equality). */
export const REASK_REASON_MIN = 10;
export const REASK_REASON_MAX = 500;

/** The 400 a manager gets for their own row (the server refuses, whoever asks). */
export const SELF_EXEMPTION_ERROR = "Ask another compliance manager to record your exemption.";

/**
 * The snooze invariant, as the roster's help text and the docs print it.
 * The needs-attention queue (F1) adds its own sentence when it ships.
 */
export const SNOOZE_INVARIANT =
  "Snoozing only pauses automatic reminders until the date. It never changes the person's status, the numbers, the record or an export.";

export interface AssignmentRequest {
  action: AssignmentAction;
  /** Positive integers, deduped, 1..ASSIGNMENT_IDS_MAX. */
  ids: number[];
  /** extend and snooze: whole days within the action's bounds (the default when absent). */
  days: number;
  /** exempt and reask: required; extend: optional; trimmed and bounded. */
  reason: string;
  /** exempt: YYYY-MM-DD after today, or null for a standing exemption. */
  until: string | null;
}

export type ParsedAssignmentRequest = { ok: true; req: AssignmentRequest } | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD that is a real calendar date. */
function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A whole number of days within [1, max]; the default when absent; null when not a usable number. */
function daysOf(v: unknown, fallback: number, max: number): number | null {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

/**
 * Validate a request body. Every rule the routes refuse with is here, so
 * the two routes answer the same sentences and the test can pin them
 * without a session: the action, the id list and its cap, the days bounds
 * of extend (1..365) and snooze (1..30), the exemption reason (required,
 * at most 300 characters) and its optional date (after today), and the
 * re-ask reason (at least 10 characters). `now` is injectable for the test.
 */
export function parseAssignmentRequest(body: unknown, now: Date = new Date()): ParsedAssignmentRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send a JSON object." };
  }
  const b = body as Record<string, unknown>;
  if (!isAssignmentAction(b.action)) return { ok: false, error: "Unknown action." };
  const action = b.action;

  const raw = b.assignment_ids;
  if (!Array.isArray(raw)) {
    return { ok: false, error: `Send assignment_ids: 1 to ${ASSIGNMENT_IDS_MAX} ids.` };
  }
  const ids: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      return { ok: false, error: "assignment_ids must be positive integers." };
    }
    if (!ids.includes(v)) ids.push(v);
  }
  if (ids.length < 1 || ids.length > ASSIGNMENT_IDS_MAX) {
    return { ok: false, error: `Send assignment_ids: 1 to ${ASSIGNMENT_IDS_MAX} ids.` };
  }

  const reasonRaw = typeof b.reason === "string" ? b.reason.trim() : "";
  const req: AssignmentRequest = { action, ids, days: 0, reason: "", until: null };

  if (action === "exempt") {
    if (!reasonRaw) return { ok: false, error: "Enter a reason for the exemption." };
    if (reasonRaw.length > EXEMPT_REASON_MAX) {
      return { ok: false, error: `Keep the reason under ${EXEMPT_REASON_MAX} characters.` };
    }
    req.reason = reasonRaw;
    const until = b.until;
    if (until !== undefined && until !== null && until !== "") {
      if (typeof until !== "string" || !isCalendarDate(until) || until <= now.toISOString().slice(0, 10)) {
        return { ok: false, error: "Pick a date after today." };
      }
      req.until = until;
    }
  } else if (action === "extend") {
    const days = daysOf(b.days, EXTEND_DAYS_DEFAULT, EXTEND_DAYS_MAX);
    if (days === null) return { ok: false, error: `Extend by 1 to ${EXTEND_DAYS_MAX} days.` };
    req.days = days;
    req.reason = reasonRaw.slice(0, EXTEND_REASON_MAX);
  } else if (action === "snooze") {
    const days = daysOf(b.days, SNOOZE_DAYS_DEFAULT, SNOOZE_DAYS_MAX);
    if (days === null) return { ok: false, error: `Snooze for 1 to ${SNOOZE_DAYS_MAX} days.` };
    req.days = days;
  } else if (action === "reask") {
    const reason = reasonRaw.slice(0, REASK_REASON_MAX);
    if (reason.length < REASK_REASON_MIN) {
      return { ok: false, error: `A reason of at least ${REASK_REASON_MIN} characters is required.` };
    }
    req.reason = reason;
  }
  return { ok: true, req };
}

/**
 * The roster's Exemption cell, plain text, never a tooltip inside the table:
 * "On leave until 1 Dec · Priya Shah · 3 Oct" (the reason, the expiry when
 * there is one, who recorded it, when). `fmt` is the viewer's date format.
 */
export function exemptionText(
  row: { exempt_reason: string; exempt_until: string | null; exempt_by_name: string; exempt_at: string | null },
  fmt: (iso: string) => string
): string {
  const parts = [row.exempt_until ? `${row.exempt_reason} until ${fmt(row.exempt_until)}` : row.exempt_reason];
  if (row.exempt_by_name) parts.push(row.exempt_by_name);
  if (row.exempt_at) parts.push(fmt(row.exempt_at));
  return parts.filter(Boolean).join(" · ");
}

/** "Snoozed until 22 Oct", with " by Priya" when the caller resolved the name. */
export function snoozeText(row: { snoozed_until: string | null }, fmt: (iso: string) => string, byName?: string): string {
  if (!row.snoozed_until) return "";
  return `Snoozed until ${fmt(row.snoozed_until)}${byName ? ` by ${byName}` : ""}`;
}
