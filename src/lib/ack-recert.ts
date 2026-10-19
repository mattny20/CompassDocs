// Periodic re-confirmation (G1, 1.12.0): the pure half. The interval
// options, the rule for the first next date, the validation the ack-settings
// route runs on a PATCH, and the sentences the shield popover, the AckCard,
// the portal and the sweep's notice show. No database, no React, no
// server-only import: the Settings tab's card (a client component), the route
// and lib/db all read it.
//
// The next date is stored on the document (documents.ack_next_recert_at),
// never derived: when an interval is set it becomes marker + N months, or
// now + 14 days when that is already past (so switching a cycle on for a
// policy last asked two years ago schedules a first cycle people can see
// coming instead of firing at the next tick); every reset moves it to
// now + N months in SQL (resetAcknowledgements, claimReconfirmationOn and
// the sweep's claim all carry the same CASE); a kept edit leaves it alone.

/** One choice of "Re-confirm every": the workspace default and the Select on the Settings tab offer exactly these. */
export interface RecertOption {
  months: number | null;
  label: string;
}

export const RECERT_OPTIONS: readonly RecertOption[] = [
  { months: null, label: "Never" },
  { months: 6, label: "6 months" },
  { months: 12, label: "12 months" },
  { months: 24, label: "24 months" },
];

/** The per-document range the ack-settings route accepts (the API may set any whole number of months in it). */
export const RECERT_MONTHS_MIN = 1;
export const RECERT_MONTHS_MAX = 60;

/** How far out the first cycle lands when the marker is already older than the interval. */
export const RECERT_GRACE_DAYS = 14;

/** The ledger row's reason for a cycle (ack_decisions.reason, source 'recurrence'). */
export const RECERT_LEDGER_REASON = "Annual re-confirmation";

/** The three columns, as a Document row or a ComplianceDocRow carries them. */
export interface RecertFields {
  ack_recert_months: number | null;
  /** ISO timestamp, or null when there is no cycle. */
  ack_next_recert_at: string | null;
  /** 'YYYY-MM-DD', or null for a policy switched on before 1.12.0 that nobody dated since. */
  ack_effective_at: string | null;
}

/** True for a value the workspace default (Program settings) may hold: null, 6, 12 or 24. */
export function isRecertDefault(v: unknown): v is number | null {
  return v === null || RECERT_OPTIONS.some((o) => o.months === v);
}

/** True for a value a single policy may hold: null or a whole number of months in range. */
export function isRecertMonths(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isInteger(v) && v >= RECERT_MONTHS_MIN && v <= RECERT_MONTHS_MAX);
}

/**
 * `d` plus `months` calendar months, the way Postgres's make_interval adds
 * them: the day of month is kept, clamped to the last day of the target
 * month (31 Jan + 1 month = 28 or 29 Feb), the time of day unchanged.
 */
export function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
  );
}

/**
 * When the first cycle of a newly set interval falls: marker + N months, or
 * now + RECERT_GRACE_DAYS when that is already past. The marker is the
 * document's ack_revision_at (the moment everyone was last asked).
 */
export function nextRecertDate(marker: Date, months: number, now: Date = new Date()): Date {
  const next = addMonths(marker, months);
  return next.getTime() > now.getTime() ? next : new Date(now.getTime() + RECERT_GRACE_DAYS * 86_400_000);
}

// --- Validation (PATCH /api/documents/[id]/ack-settings) ------------------------

export interface RecertPatch {
  recert_months?: number | null;
  /** ISO timestamp (a date-only input is midnight UTC of that day), or null to clear. */
  next_recert_at?: string | null;
  /** 'YYYY-MM-DD', or null to clear. */
  effective_at?: string | null;
}

export type RecertPatchResult = { ok: true; patch: RecertPatch } | { ok: false; error: string };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A 'YYYY-MM-DD' or an ISO timestamp as the route receives it; null for anything else. */
function parseDateInput(v: unknown): { at: Date; dateOnly: boolean } | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = DATE_ONLY.exec(s);
  if (m) {
    const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    // Reject 2026-02-31: Date.UTC rolls it into March.
    if (at.getUTCMonth() !== Number(m[2]) - 1 || at.getUTCDate() !== Number(m[3])) return null;
    return { at, dateOnly: true };
  }
  const at = new Date(s);
  return Number.isNaN(at.getTime()) ? null : { at, dateOnly: false };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Validate the three re-confirmation fields of a PATCH body. Only the keys
 * present are checked and returned, so the route's FIELDS table can hand
 * this the whole body: `recert_months` is null or a whole number of months
 * from 1 to 60; `next_recert_at` is a date not in the past (today counts:
 * the cycle fires at the next hourly tick) or null; `effective_at` is a
 * date or null. The first problem is named; nothing else about the body is
 * judged here.
 */
export function validateRecertPatch(body: unknown, now: Date = new Date()): RecertPatchResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send a JSON object of settings." };
  }
  const b = body as Record<string, unknown>;
  const patch: RecertPatch = {};
  if ("recert_months" in b) {
    const v = b.recert_months;
    if (!isRecertMonths(v)) {
      return { ok: false, error: `Re-confirm every ${RECERT_MONTHS_MIN} to ${RECERT_MONTHS_MAX} months, or never.` };
    }
    patch.recert_months = v;
  }
  if ("next_recert_at" in b) {
    const v = b.next_recert_at;
    if (v === null || v === "") {
      patch.next_recert_at = null;
    } else {
      const d = parseDateInput(v);
      if (!d) return { ok: false, error: "Enter the next re-confirmation as a date." };
      const floor = d.dateOnly ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) : now.getTime() - 60_000;
      if (d.at.getTime() < floor) return { ok: false, error: "The next re-confirmation date cannot be in the past." };
      patch.next_recert_at = d.at.toISOString();
    }
  }
  if ("effective_at" in b) {
    const v = b.effective_at;
    if (v === null || v === "") {
      patch.effective_at = null;
    } else {
      const d = parseDateInput(v);
      if (!d) return { ok: false, error: "Enter the effective date as a date." };
      patch.effective_at = ymd(d.at);
    }
  }
  return { ok: true, patch };
}

// --- Copy -------------------------------------------------------------------------

/** "yearly", "every 6 months", "every 2 years": the cadence as the sentences below say it. */
export function recertCadence(months: number): string {
  if (months === 12) return "yearly";
  if (months % 12 === 0) return `every ${months / 12} years`;
  if (months === 1) return "every month";
  return `every ${months} months`;
}

/** The option label for a Select ("Never", "12 months"), also for a value outside RECERT_OPTIONS. */
export function recertOptionLabel(months: number | null): string {
  const o = RECERT_OPTIONS.find((x) => x.months === months);
  if (o) return o.label;
  return months === 1 ? "1 month" : `${months} months`;
}

/**
 * The shield popover's status line (A5's slot): "Re-confirm yearly · next
 * 1 Jan 2027"; null when the policy has no cycle, so the popover shows
 * nothing rather than "Never". `fmt` formats an ISO date the workspace's
 * way (useFormatDate().date on the client, the server's formatDate helper).
 */
export function recertStatusLine(doc: RecertFields, fmt: (iso: string) => string): string | null {
  if (doc.ack_recert_months == null) return null;
  const next = doc.ack_next_recert_at ? ` · next ${fmt(doc.ack_next_recert_at)}` : "";
  return `Re-confirm ${recertCadence(doc.ack_recert_months)}${next}`;
}

/**
 * The AckCard's meta line: "Effective 1 Jan 2026 · re-confirm yearly",
 * either half alone when the other is missing, null when both are.
 */
export function recertMetaLine(doc: RecertFields, fmt: (iso: string) => string): string | null {
  const parts: string[] = [];
  if (doc.ack_effective_at) parts.push(`Effective ${fmt(doc.ack_effective_at)}`);
  if (doc.ack_recert_months != null) parts.push(`re-confirm ${recertCadence(doc.ack_recert_months)}`);
  return parts.length ? parts.join(" · ") : null;
}

/** The portal row's text: "Next re-confirmation 1 Jan 2027"; null without a cycle. */
export function recertPortalLine(doc: RecertFields, fmt: (iso: string) => string): string | null {
  if (doc.ack_recert_months == null || !doc.ack_next_recert_at) return null;
  return `Next re-confirmation ${fmt(doc.ack_next_recert_at)}`;
}

/** True when the policy's next cycle falls within `days` of `now` (the KPI tile "Re-confirmation due in 30 days" counts these). */
export function recertDueWithin(doc: RecertFields, days: number, now: Date = new Date()): boolean {
  if (doc.ack_recert_months == null || !doc.ack_next_recert_at) return false;
  const at = new Date(doc.ack_next_recert_at).getTime();
  return at <= now.getTime() + days * 86_400_000;
}

/**
 * The sentence people see when a cycle fires (the outbox row's reason, so
 * noticeCopy shows it as the body of the 'updated' notice from source
 * 'recurrence' and the email carries it as the reason). The glossary's
 * words: "re-confirmation", "confirm".
 */
export function recertNoticeSentence(months: number, title: string): string {
  const n = months === 1 ? "1 month" : `${months} months`;
  return `Annual re-confirmation: it has been ${n} since you confirmed "${title}". Please read it again and confirm.`;
}
