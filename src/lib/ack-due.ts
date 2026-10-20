// Deadlines (E1, 1.13.0): the pure half. The built-in numbers, the
// policy -> space -> workspace -> built-in cascade and where each value came
// from, the rule that turns a policy's deadline into a person's due date, the
// overdue test, the validation the Program settings and space routes run,
// and the sentences the cards, chips, emails and portal rows show. No
// database, no React, no server-only import: the settings panel (a client
// component), the routes, lib/compliance and lib/db all read it.
//
// Two grace concepts are named apart on purpose: new_joiner_days is what a
// new account gets from the day it joins; overdue_grace_days is the time
// after a due date before a row counts as overdue (default 0: the moment the
// due date passes). The re-confirmation interval is not part of the cascade
// (documents.ack_recert_months, lib/ack-recert).
//
// A fixed date ("by 29 Oct 2026") is a calendar day, and a person's due_at
// is an instant: the day ends at midnight in the workspace's time zone
// (settings.timezone), so the Due chip, the roster and the email, which all
// format instants in that zone, name the day the manager chose.

/** The numbers every policy inherits when nothing above it says otherwise. */
export const BUILT_IN = {
  /** Days a person has to confirm, from the day they are assigned. */
  due_days: 14,
  /** Days a new account has for the policies it is enrolled in on arrival. */
  new_joiner_days: 14,
  /** Days after the due date before a person counts as overdue. */
  overdue_grace_days: 0,
  /** Days before the due date the first automatic reminder goes out. */
  remind_before_days: 3,
  /** Days between automatic reminders while a confirmation is due or overdue. */
  remind_every_days: 7,
  /** Days past the due date (and the grace) before the policy is escalated. */
  escalate_after_days: 7,
  /** Days between reminders for a policy with no due date; 0 = never. */
  nudge_every_days: 0,
};

export type DueNumberKey = keyof typeof BUILT_IN;

/** The seven numbers, in the order the Program settings card shows them. */
export const DUE_NUMBER_KEYS: readonly DueNumberKey[] = [
  "due_days",
  "new_joiner_days",
  "overdue_grace_days",
  "remind_before_days",
  "remind_every_days",
  "escalate_after_days",
  "nudge_every_days",
];

/** The effective values of one policy: the seven numbers and its owner (null = nobody named). */
export type PolicyDefaults = typeof BUILT_IN & { owner_user_id: number | null };
export type PolicyDefaultsKey = keyof PolicyDefaults;

/** Where a resolved value came from. */
export type DefaultsOrigin = "policy" | "space" | "workspace" | "built-in";

/**
 * One layer of the cascade as stored: policy_settings' columns, a space's
 * policy_defaults JSON, or the workspace's ack_defaults. A key absent or
 * null is not set at that layer and the lookup moves down.
 */
export type PolicyDefaultsLayer = { [K in PolicyDefaultsKey]?: number | null };

export interface ResolvedDefaults {
  values: PolicyDefaults;
  origin: Record<PolicyDefaultsKey, DefaultsOrigin>;
}

/** What each number may hold, as the brief contracts them. */
export const DUE_RANGES: Record<DueNumberKey, { min: number; max: number }> = {
  due_days: { min: 1, max: 365 },
  new_joiner_days: { min: 1, max: 365 },
  overdue_grace_days: { min: 0, max: 90 },
  remind_before_days: { min: 1, max: 365 },
  remind_every_days: { min: 1, max: 365 },
  escalate_after_days: { min: 1, max: 365 },
  nudge_every_days: { min: 0, max: 365 },
};

/**
 * The seven fields as the Program settings card and the space settings
 * disclosure (wave 2) label them: one source for both. The help is shown
 * once a value is set; while a field is blank the help reads "Built-in: 14".
 */
export const DUE_FIELDS: readonly { key: DueNumberKey; label: string; help: string }[] = [
  { key: "due_days", label: "Days to confirm", help: "Counted from the day a person is assigned the policy." },
  {
    key: "new_joiner_days",
    label: "Days for new joiners",
    help: "Counted from the day a new account is enrolled in the policies it must confirm.",
  },
  {
    key: "overdue_grace_days",
    label: "Grace days after the due date",
    help: "A person counts as overdue only once these days have passed. 0 means as soon as the due date passes.",
  },
  {
    key: "remind_before_days",
    label: "First reminder, days before the due date",
    help: "The first automatic reminder goes out this many days ahead of the due date.",
  },
  {
    key: "remind_every_days",
    label: "Days between reminders",
    help: "While a confirmation is due or overdue, automatic reminders repeat at this interval.",
  },
  {
    key: "escalate_after_days",
    label: "Days overdue before escalation",
    help: "Once a person is this far past the due date and its grace, the policy's owner and their group leads are told.",
  },
  {
    key: "nudge_every_days",
    label: "Days between nudges, no due date",
    help: "For a policy with no due date. 0 means people are never nudged.",
  },
];

export const DUE_HISTORY_MAX = 10;

/**
 * One entry of policy_assignments.due_history (the last DUE_HISTORY_MAX are
 * kept). `kind` says who wrote it: 'extend' for a manager's extension
 * (undoExtension pops only those), 'moved' for a rule change moving every
 * open row ("Also move existing deadlines"), which is undone by re-applying
 * the previous rule, never as an extension. The dates are as Postgres's
 * JSON serialiser renders a timestamptz (microseconds, +00:00); parse with
 * new Date().
 */
export interface DueHistoryEntry {
  kind: "extend" | "moved";
  from: string | null;
  to: string | null;
  /** The user id that moved it; null for a rule change nobody signed (a sweep). */
  by: number | null;
  at: string;
  reason: string;
}

// --- Validation ----------------------------------------------------------------

/** True when `v` is a whole number of days within the key's range. */
export function isDueNumber(key: DueNumberKey, v: unknown): v is number {
  const r = DUE_RANGES[key];
  return typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max;
}

function isUserId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * A layer as read back from storage: known keys with valid values only, so
 * a hand edit (a string, 0 days, a negative owner) reads as unset at that
 * layer rather than breaking the cascade. Null values are dropped.
 */
export function sanitizeLayer(raw: unknown): PolicyDefaultsLayer {
  const out: PolicyDefaultsLayer = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const key of DUE_NUMBER_KEYS) if (isDueNumber(key, r[key])) out[key] = r[key] as number;
  if (isUserId(r.owner_user_id)) out.owner_user_id = r.owner_user_id;
  return out;
}

export type PolicyDefaultsPatchResult = { ok: true; patch: PolicyDefaultsLayer } | { ok: false; error: string };

/** The error line for one number: `"due_days" must be a whole number from 1 to 365 days, or null for the built-in (14).` */
export function dueNumberError(key: DueNumberKey, prefix = ""): string {
  const r = DUE_RANGES[key];
  return `"${prefix}${key}" must be a whole number from ${r.min} to ${r.max} days, or null for the built-in (${BUILT_IN[key]}).`;
}

/**
 * Validate a patch of defaults as a route receives it (PATCH
 * /api/admin/spaces/[id] `policy_defaults`, and the seven numbers of
 * PUT /api/admin/compliance/settings `ack_defaults`): every key present is
 * null (clear: inherit from the next layer) or a whole number of days in
 * its range; `owner_user_id` is null or a user id, and only accepted when
 * `owner` is on (the workspace layer has no owner); an unknown key is
 * refused rather than ignored. The first problem is named. Pure.
 */
export function parsePolicyDefaultsPatch(raw: unknown, opts: { owner?: boolean; prefix?: string } = {}): PolicyDefaultsPatchResult {
  const prefix = opts.prefix ?? "";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const name = prefix ? prefix.replace(/\.$/, "") : "policy_defaults";
    return { ok: false, error: `"${name}" must be an object.` };
  }
  const patch: PolicyDefaultsLayer = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if ((DUE_NUMBER_KEYS as readonly string[]).includes(key)) {
      const k = key as DueNumberKey;
      if (value !== null && !isDueNumber(k, value)) return { ok: false, error: dueNumberError(k, prefix) };
      patch[k] = value as number | null;
    } else if (key === "owner_user_id" && opts.owner) {
      if (value !== null && !isUserId(value)) {
        return { ok: false, error: `"${prefix}owner_user_id" must be a user id, or null for nobody.` };
      }
      patch.owner_user_id = value as number | null;
    } else {
      return { ok: false, error: `Unknown setting "${prefix}${key}".` };
    }
  }
  return { ok: true, patch };
}

/** `base` with `patch` applied: a null in the patch removes the key (inherit), a number sets it. */
export function mergeLayer(base: PolicyDefaultsLayer, patch: PolicyDefaultsLayer): PolicyDefaultsLayer {
  const out: PolicyDefaultsLayer = { ...base };
  for (const [key, value] of Object.entries(patch) as [PolicyDefaultsKey, number | null | undefined][]) {
    if (value === undefined) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** The keys whose stored value differs between two layers, with both values (null = unset), for the audit rows. */
export function diffLayers(
  before: PolicyDefaultsLayer,
  after: PolicyDefaultsLayer
): { key: PolicyDefaultsKey; from: number | null; to: number | null }[] {
  const keys: PolicyDefaultsKey[] = [...DUE_NUMBER_KEYS, "owner_user_id"];
  const out: { key: PolicyDefaultsKey; from: number | null; to: number | null }[] = [];
  for (const key of keys) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (from !== to) out.push({ key, from, to });
  }
  return out;
}

// --- The cascade -----------------------------------------------------------------

/**
 * Resolve one policy's effective values: for each of the seven numbers the
 * policy's own value, else the space's, else the workspace's, else the
 * built-in; the owner from the policy, else the space, else nobody (origin
 * 'built-in'). Each layer is read as stored (sanitized here), so a junk
 * value is skipped, not applied. The database-backed caller is
 * resolvePolicyDefaults in lib/compliance.
 */
export function resolveDefaults(layers: {
  policy?: PolicyDefaultsLayer | null;
  space?: PolicyDefaultsLayer | null;
  workspace?: PolicyDefaultsLayer | null;
}): ResolvedDefaults {
  const policy = sanitizeLayer(layers.policy);
  const space = sanitizeLayer(layers.space);
  const workspace = sanitizeLayer(layers.workspace);
  const values = { ...BUILT_IN, owner_user_id: null } as PolicyDefaults;
  const origin = {} as Record<PolicyDefaultsKey, DefaultsOrigin>;
  for (const key of DUE_NUMBER_KEYS) {
    if (policy[key] != null) {
      values[key] = policy[key]!;
      origin[key] = "policy";
    } else if (space[key] != null) {
      values[key] = space[key]!;
      origin[key] = "space";
    } else if (workspace[key] != null) {
      values[key] = workspace[key]!;
      origin[key] = "workspace";
    } else {
      values[key] = BUILT_IN[key];
      origin[key] = "built-in";
    }
  }
  if (policy.owner_user_id != null) {
    values.owner_user_id = policy.owner_user_id;
    origin.owner_user_id = "policy";
  } else if (space.owner_user_id != null) {
    values.owner_user_id = space.owner_user_id;
    origin.owner_user_id = "space";
  } else {
    values.owner_user_id = null;
    origin.owner_user_id = "built-in";
  }
  return { values, origin };
}

// --- Due dates -------------------------------------------------------------------

const DAY = 86_400_000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})/;

/** 'YYYY-MM-DD' (or an ISO string starting with one) as [year, month, day], or null for anything else or an impossible day. */
export function parseYmd(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null;
  const m = YMD.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return [y, mo, d];
}

/** The offset of `timeZone` at `at`, in milliseconds east of UTC (an unknown zone reads as UTC). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
  } catch {
    return 0;
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The last instant of a calendar day in a time zone: 23:59:59.999 of
 * 'YYYY-MM-DD' in `timeZone` (the workspace's settings.timezone; 'UTC' when
 * unknown). This is what a fixed deadline becomes on a person's row, so a
 * row due "by 29 Oct" is not overdue until 29 Oct has ended where the
 * workspace is, and every surface that formats the instant in that zone
 * names 29 Oct. Null for a value that is not a day.
 */
export function endOfDayIn(ymd: string | null | undefined, timeZone = "UTC"): Date | null {
  const p = parseYmd(ymd);
  if (!p) return null;
  const naive = Date.UTC(p[0], p[1] - 1, p[2], 23, 59, 59, 999);
  if (!timeZone || timeZone === "UTC") return new Date(naive);
  // The offset at the guessed instant, re-checked once at the result so a
  // day that ends across a DST switch lands on the right side of it.
  let t = naive - zoneOffsetMs(new Date(naive), timeZone);
  const again = zoneOffsetMs(new Date(t), timeZone);
  if (naive - again !== t) t = naive - again;
  return new Date(t);
}

/**
 * A person's due date for a policy: the fixed date (its last instant in the
 * workspace zone) while that is still in the future, else `from` plus
 * due_days; null only when there is no usable number of days. `from` is the
 * moment the row's clock starts (enrolment, a new cycle, a re-ask).
 */
export function dueAtFor(
  defaults: { due_days: number | null | undefined },
  opts: { from: Date; fixed?: string | null; timeZone?: string }
): Date | null {
  const fixed = endOfDayIn(opts.fixed, opts.timeZone);
  if (fixed && fixed.getTime() > opts.from.getTime()) return fixed;
  const days = defaults.due_days;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) return null;
  return new Date(opts.from.getTime() + days * DAY);
}

/** Midnight UTC of the calendar day `d` falls on, as seen in `timeZone`. */
function dayNumber(d: Date, timeZone: string): number {
  const shifted = d.getTime() + (timeZone && timeZone !== "UTC" ? zoneOffsetMs(d, timeZone) : 0);
  return Math.floor(shifted / DAY);
}

/**
 * Whole calendar days from `now` to the due date, in `timeZone`: 0 on the
 * due day, negative once it has passed. (A due date set 14 days out reads as
 * 14 the day it is set, whatever the time of day.)
 */
export function daysLeft(dueAt: string | Date, now: Date = new Date(), timeZone = "UTC"): number {
  const due = typeof dueAt === "string" ? new Date(dueAt) : dueAt;
  return dayNumber(due, timeZone) - dayNumber(now, timeZone);
}

/** A row's due date and whether a current confirmation stands (acknowledged_at is the current one, null while pending). */
export interface DueRow {
  due_at: string | Date | null;
  acknowledged_at?: string | Date | null;
}

/**
 * Overdue = the due date plus the grace has passed and no current
 * confirmation stands. A row without a due date is never overdue; a
 * confirmed row is never overdue however old its due date.
 */
export function isOverdue(row: DueRow, defaults: { overdue_grace_days: number }, now: Date = new Date()): boolean {
  if (!row.due_at || row.acknowledged_at) return false;
  const due = typeof row.due_at === "string" ? new Date(row.due_at) : row.due_at;
  if (Number.isNaN(due.getTime())) return false;
  const grace = Math.max(0, defaults.overdue_grace_days || 0);
  return due.getTime() + grace * DAY < now.getTime();
}

// --- Copy ------------------------------------------------------------------------

/** The per-policy deadline as policy_settings stores it: a number of days, a fixed 'YYYY-MM-DD', or neither (inherit). */
export interface DueRule {
  due_days: number | null;
  due_at: string | null;
}

/** `fmt` formats an ISO instant or a 'YYYY-MM-DD' the workspace's way (useFormatDate().date on the client, formatDay / formatDate on the server). */
export type DateFormatter = (value: string) => string;

/** The rule in words: "29 Oct 2026" for a fixed date, else "14 days after assignment". */
export function dueRuleLabel(rule: Partial<DueRule> | null | undefined, resolved: { due_days: number }, fmt: DateFormatter): string {
  if (rule?.due_at && parseYmd(rule.due_at)) return fmt(rule.due_at);
  const days = rule?.due_days ?? resolved.due_days;
  return `${days} ${days === 1 ? "day" : "days"} after assignment`;
}

/** Where an inherited number comes from, for the Deadline card's first radio: "Inherit (14 days, from Security space)". */
export function inheritLabel(resolved: ResolvedDefaults, spaceName: string | null | undefined): string {
  const days = resolved.values.due_days;
  const unit = days === 1 ? "day" : "days";
  switch (resolved.origin.due_days) {
    case "space":
      return `Inherit (${days} ${unit}, from ${spaceName || "the space"})`;
    case "workspace":
      return `Inherit (${days} ${unit}, the workspace default)`;
    default:
      return `Inherit (${days} ${unit}, built-in)`;
  }
}

/** The Deadline card's helper line: "Current audience: due 29 Oct 2026 · new joiners: 14 days after they join". */
export function audienceDueHelper(rule: Partial<DueRule> | null | undefined, resolved: PolicyDefaults, fmt: DateFormatter): string {
  const current =
    rule?.due_at && parseYmd(rule.due_at) ? `due ${fmt(rule.due_at)}` : `due ${dueRuleLabel(rule, resolved, fmt)}`;
  const joiners = `${resolved.new_joiner_days} ${resolved.new_joiner_days === 1 ? "day" : "days"} after they join`;
  return `Current audience: ${current} · new joiners: ${joiners}`;
}

/** The portal row: "Due 29 Oct 2026 · 12 overdue" or "Due 14 days after assignment" (the overdue count only when there is one). */
export function portalDueLine(
  rule: Partial<DueRule> | null | undefined,
  resolved: { due_days: number },
  overdue: number,
  fmt: DateFormatter
): string {
  const base = `Due ${dueRuleLabel(rule, resolved, fmt)}`;
  return overdue > 0 ? `${base} · ${overdue} overdue` : base;
}

export type DueTone = "neutral" | "warn" | "error";

/**
 * The card's and the roster's chip: "Due 29 Oct 2026" (neutral more than
 * three days out, warn at three or fewer) or "Overdue since 29 Oct 2026"
 * (error); null without a due date or once confirmed.
 */
export function dueChip(
  row: DueRow,
  defaults: { overdue_grace_days: number },
  fmt: DateFormatter,
  now: Date = new Date(),
  timeZone = "UTC"
): { tone: DueTone; label: string } | null {
  if (!row.due_at || row.acknowledged_at) return null;
  const iso = typeof row.due_at === "string" ? row.due_at : row.due_at.toISOString();
  if (isOverdue(row, defaults, now)) return { tone: "error", label: `Overdue since ${fmt(iso)}` };
  const left = daysLeft(iso, now, timeZone);
  return { tone: left <= 3 ? "warn" : "neutral", label: `Due ${fmt(iso)}` };
}

/** The sticky control's short chip: "Due in 2 days", "Due tomorrow", "Due today", "Overdue"; null without a due date or once confirmed. */
export function dueStickyLabel(
  row: DueRow,
  defaults: { overdue_grace_days: number },
  now: Date = new Date(),
  timeZone = "UTC"
): string | null {
  if (!row.due_at || row.acknowledged_at) return null;
  if (isOverdue(row, defaults, now)) return "Overdue";
  const left = daysLeft(row.due_at, now, timeZone);
  if (left <= 0) return "Due today";
  if (left === 1) return "Due tomorrow";
  return `Due in ${left} days`;
}

/** The card's sentence on an overdue policy: confirming is the same button, only the copy changes. */
export function overdueConfirmCopy(dueAt: string, fmt: DateFormatter): string {
  return `This was due ${fmt(dueAt)}. Confirming now still records today's date.`;
}

/** The email's {{due_line}}: "Please confirm by 29 Oct 2026." (blank without a date). */
export function dueLineFor(dueAt: string | null | undefined, fmt: DateFormatter): string {
  return dueAt ? `Please confirm by ${fmt(dueAt)}.` : "";
}

/** The email subject's {{due_suffix}}: " by 29 Oct 2026" (blank without a date). */
export function dueSuffixFor(dueAt: string | null | undefined, fmt: DateFormatter): string {
  return dueAt ? ` by ${fmt(dueAt)}` : "";
}
