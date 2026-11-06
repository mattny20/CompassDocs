// Helpdesk 1.19.1: recurring tickets, the parts both sides use (agent V8).
// Plain module (no server imports): the desk's editor validates and words
// a pattern with it, and the server computes the next runs with it.
//
// A pattern says which local dates a schedule falls on, and at what wall
// clock time, in the schedule's own time zone:
//
//   daily     every day
//   weekly    on chosen weekdays (ISO 1 = Monday … 7 = Sunday)
//   monthly   the nth (1–4, or -1 = last) weekday of the month, or a day
//             of the month (1–31, a short month uses its last day; -1 =
//             the last day), in every month or only the months listed
//             (quarterly: [1, 4, 7, 10])
//   interval  every N days or weeks, counted from a start date
//
// An occurrence is one scheduled local date; its key is that date
// ("2026-12-07"), whatever a holiday does to it, so the sweep can claim it
// once. The instant comes from L's zonedInstant, so 09:00 stays 09:00
// across a clock change (a time inside a spring-forward gap moves on by the
// gap: 02:30 on the change night opens at 03:30). A holiday is a whole-day closure in the team's calendar
// (lib/helpdesk/sla dayClosures): next_working_day moves the occurrence to
// the next date that has office hours and is not a holiday, skip drops it,
// same_day ignores holidays.

import type { HdBusinessHours } from "./types";
import { dayClosures, dayOpenIntervals, hasOpenHours, wallClock, zonedInstant } from "./sla";

// --- Types ------------------------------------------------------------------------------

export type RecurringKind = "daily" | "weekly" | "monthly" | "interval";

export type RecurringPattern =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "monthly"; mode: "nth_weekday"; nth: number; weekday: number; months: number[]; time: string }
  | { kind: "monthly"; mode: "day"; day: number; months: number[]; time: string }
  | { kind: "interval"; unit: "days" | "weeks"; every: number; start: string; time: string };

export const HD_HOLIDAY_RULES = ["next_working_day", "skip", "same_day"] as const;
export type HdHolidayRule = (typeof HD_HOLIDAY_RULES)[number];
export const HD_HOLIDAY_RULE_LABEL: Record<HdHolidayRule, string> = {
  next_working_day: "Open it on the next working day",
  skip: "Skip that date",
  same_day: "Open it anyway",
};

export const HD_ASSIGN_MODES = ["team_rules", "user"] as const;
export type HdRecurringAssignMode = (typeof HD_ASSIGN_MODES)[number];

/** One schedule as the API returns it. */
export interface HdRecurring {
  id: number;
  team_id: number;
  team_name: string;
  subject: string;
  body: string;
  priority: string;
  request_type_id: number | null;
  assign_mode: HdRecurringAssignMode;
  assignee_id: number | null;
  assignee_name: string | null;
  due_business_days: number | null;
  pattern: RecurringPattern;
  holiday_rule: HdHolidayRule;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_ticket_number: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

/** A run the preview shows: when, and what a holiday did. */
export interface HdRecurringPreviewItem {
  at: string;
  /** "Mon Dec 7" in the schedule's zone. */
  label: string;
  /** "moved from Mon May 25, Spring bank holiday" / "Mon May 4 skipped for Early May bank holiday". */
  note: string;
}

export const RECURRING_LIMITS = {
  subject: 300,
  body: 20_000,
  dueDays: 60,
  everyDays: 365,
  everyWeeks: 52,
  perTeam: 200,
} as const;

// --- Civil dates (no zone) -------------------------------------------------------------------

const DAY_MS = 86_400_000;

export interface CivilDate {
  y: number;
  m: number;
  d: number;
}

export function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayNumber(n: number): CivilDate {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function isoDate(c: CivilDate): string {
  return `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}

export function parseIsoDate(s: string): CivilDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const back = fromDayNumber(dayNumber(c.y, c.m, c.d));
  return back.y === c.y && back.m === c.m && back.d === c.d ? c : null;
}

/** ISO weekday 1 = Monday … 7 = Sunday. */
export function isoWeekday(c: CivilDate): number {
  const w = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
  return w === 0 ? 7 : w;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** ISO 8601 week number and its year. */
export function isoWeek(c: CivilDate): { year: number; week: number } {
  const n = dayNumber(c.y, c.m, c.d);
  const thursday = n - isoWeekday(c) + 4;
  const t = fromDayNumber(thursday);
  const jan1 = dayNumber(t.y, 1, 1);
  return { year: t.y, week: Math.floor((thursday - jan1) / 7) + 1 };
}

function hm(s: string): [number, number] {
  const [h, m] = s.split(":").map(Number);
  return [h || 0, m || 0];
}

// --- Validation ----------------------------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function intIn(v: unknown, lo: number, hi: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}

function monthList(v: unknown): number[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out = new Set<number>();
  for (const x of v) {
    const n = intIn(x, 1, 12);
    if (n === null) return null;
    out.add(n);
  }
  // Every month picked is the same as none picked.
  return out.size === 12 ? [] : [...out].sort((a, b) => a - b);
}

/** A pattern from a request body, or the sentence saying what is wrong. */
export function validatePattern(raw: unknown): { ok: true; value: RecurringPattern } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Say when the ticket repeats." };
  const r = raw as Record<string, unknown>;
  const time = typeof r.time === "string" ? r.time : "";
  if (!TIME_RE.test(time)) return { ok: false, error: "Give a time of day as HH:MM, for example 09:00." };
  switch (r.kind) {
    case "daily":
      return { ok: true, value: { kind: "daily", time } };
    case "weekly": {
      if (!Array.isArray(r.days)) return { ok: false, error: "Pick at least one day of the week." };
      const days = new Set<number>();
      for (const x of r.days) {
        const n = intIn(x, 1, 7);
        if (n === null) return { ok: false, error: "Days of the week are 1 (Monday) to 7 (Sunday)." };
        days.add(n);
      }
      if (!days.size) return { ok: false, error: "Pick at least one day of the week." };
      return { ok: true, value: { kind: "weekly", days: [...days].sort((a, b) => a - b), time } };
    }
    case "monthly": {
      const months = monthList(r.months);
      if (months === null) return { ok: false, error: "Months are 1 (January) to 12 (December)." };
      if (r.mode === "nth_weekday") {
        const nth = r.nth === -1 ? -1 : intIn(r.nth, 1, 4);
        const weekday = intIn(r.weekday, 1, 7);
        if (nth === null) return { ok: false, error: "Choose first, second, third, fourth or last." };
        if (weekday === null) return { ok: false, error: "Choose a day of the week." };
        return { ok: true, value: { kind: "monthly", mode: "nth_weekday", nth, weekday, months, time } };
      }
      if (r.mode === "day") {
        const day = r.day === -1 ? -1 : intIn(r.day, 1, 31);
        if (day === null) return { ok: false, error: "Choose a day of the month from 1 to 31, or the last day." };
        return { ok: true, value: { kind: "monthly", mode: "day", day, months, time } };
      }
      return { ok: false, error: "Choose a weekday of the month or a day of the month." };
    }
    case "interval": {
      const unit = r.unit === "weeks" ? "weeks" : r.unit === "days" ? "days" : null;
      if (!unit) return { ok: false, error: "Repeat every so many days or weeks." };
      const every = intIn(r.every, 1, unit === "weeks" ? RECURRING_LIMITS.everyWeeks : RECURRING_LIMITS.everyDays);
      if (every === null) {
        return { ok: false, error: unit === "weeks" ? `Repeat every 1 to ${RECURRING_LIMITS.everyWeeks} weeks.` : `Repeat every 1 to ${RECURRING_LIMITS.everyDays} days.` };
      }
      const start = typeof r.start === "string" && parseIsoDate(r.start) ? r.start : null;
      if (!start) return { ok: false, error: "Give the first date as YYYY-MM-DD." };
      return { ok: true, value: { kind: "interval", unit, every, start, time } };
    }
    default:
      return { ok: false, error: "Choose daily, weekly, monthly or a custom interval." };
  }
}

export function isHolidayRule(v: unknown): v is HdHolidayRule {
  return typeof v === "string" && (HD_HOLIDAY_RULES as readonly string[]).includes(v);
}

/** A real IANA zone (Intl knows it). */
export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// --- Which dates ------------------------------------------------------------------------------------

/** Does the pattern fall on local date c? */
export function patternMatches(p: RecurringPattern, c: CivilDate): boolean {
  switch (p.kind) {
    case "daily":
      return true;
    case "weekly":
      return p.days.includes(isoWeekday(c));
    case "monthly": {
      if (p.months.length && !p.months.includes(c.m)) return false;
      const last = lastDayOfMonth(c.y, c.m);
      if (p.mode === "day") return c.d === (p.day === -1 ? last : Math.min(p.day, last));
      if (isoWeekday(c) !== p.weekday) return false;
      return p.nth === -1 ? c.d + 7 > last : Math.ceil(c.d / 7) === p.nth;
    }
    case "interval": {
      const s = parseIsoDate(p.start);
      if (!s) return false;
      const diff = dayNumber(c.y, c.m, c.d) - dayNumber(s.y, s.m, s.d);
      const step = p.every * (p.unit === "weeks" ? 7 : 1);
      return diff >= 0 && diff % step === 0;
    }
  }
}

/** The longest gap between two matching dates, plus slack: how far a scan may look. */
function scanLimit(p: RecurringPattern): number {
  if (p.kind === "interval") return p.every * (p.unit === "weeks" ? 7 : 1) + 2;
  if (p.kind === "monthly") return 400;
  return 9;
}

export interface RawOccurrence {
  key: string;
  date: CivilDate;
  at: number;
}

/**
 * Scheduled occurrences from local date `fromDay` (a day number) on, in
 * order, before any holiday rule. Stops after `max` or when a whole scan
 * window finds nothing (a pattern that can never match).
 */
export function* rawOccurrences(p: RecurringPattern, tz: string, fromDay: number, max = 1000): Generator<RawOccurrence> {
  const [h, min] = hm(p.time);
  const limit = scanLimit(p);
  let day = fromDay;
  let emitted = 0;
  let sinceLast = 0;
  // Interval patterns jump straight to their first date on or after fromDay.
  if (p.kind === "interval") {
    const s = parseIsoDate(p.start);
    if (!s) return;
    const start = dayNumber(s.y, s.m, s.d);
    const step = p.every * (p.unit === "weeks" ? 7 : 1);
    day = day <= start ? start : start + Math.ceil((day - start) / step) * step;
    while (emitted < max) {
      const date = fromDayNumber(day);
      yield { key: isoDate(date), date, at: zonedInstant(date.y, date.m, date.d, h, min, tz) };
      emitted++;
      day += step;
    }
    return;
  }
  while (emitted < max && sinceLast <= limit) {
    const date = fromDayNumber(day);
    if (patternMatches(p, date)) {
      yield { key: isoDate(date), date, at: zonedInstant(date.y, date.m, date.d, h, min, tz) };
      emitted++;
      sinceLast = 0;
    } else sinceLast++;
    day++;
  }
}

// --- Holidays ------------------------------------------------------------------------------------------

/** The name of a whole-day closure on local date c in the team's calendar, or null. */
export function holidayOn(c: CivilDate, hours: HdBusinessHours | null): string | null {
  if (!hours) return null;
  const hit = dayClosures(c.y, c.m, c.d, hours).find((x) => x.whole);
  return hit ? hit.name : null;
}

/** A date with office hours that is not a holiday (any non-holiday date when the calendar never opens). */
export function isWorkingDay(c: CivilDate, hours: HdBusinessHours | null): boolean {
  if (!hours) return true;
  if (holidayOn(c, hours)) return false;
  if (!hasOpenHours(hours)) return true;
  return dayOpenIntervals(c.y, c.m, c.d, hours).length > 0;
}

export interface Occurrence {
  /** The scheduled date (the claim key). */
  key: string;
  /** When the ticket opens. */
  at: number;
  /** The local date it opens on. */
  date: CivilDate;
  /** Moved by next_working_day: the scheduled date and the holiday. */
  movedFrom?: { date: CivilDate; holiday: string };
  /** Holidays skipped since the previous occurrence (skip rule). */
  skipped?: { date: CivilDate; holiday: string }[];
}

/**
 * The runs from `after` (exclusive) on, holiday rule applied, at most
 * `count`. Looks back `lookbackDays` so an occurrence scheduled just before
 * `after` but moved past it by a holiday is still found. Two occurrences
 * never open on the same local date: one moved onto (or past) the next
 * scheduled date stands for both, under the earlier key.
 */
export function nextOccurrences(
  p: RecurringPattern,
  opts: { tz: string; rule: HdHolidayRule; hours: HdBusinessHours | null; after: number; count: number; lookbackDays?: number }
): Occurrence[] {
  const { tz, rule, hours, after, count } = opts;
  const lookback = opts.lookbackDays ?? 21;
  const w = wallClock(after, tz);
  const fromDay = dayNumber(w.y, w.m, w.d) - lookback;
  const [h, min] = hm(p.time);
  const out: Occurrence[] = [];
  let lastDay = -Infinity;
  let skipped: { date: CivilDate; holiday: string }[] = [];
  let guard = 0;
  for (const raw of rawOccurrences(p, tz, fromDay)) {
    if (out.length >= count || ++guard > 1000) break;
    const holiday = rule === "same_day" ? null : holidayOn(raw.date, hours);
    let occ: Occurrence = { key: raw.key, at: raw.at, date: raw.date };
    if (holiday && rule === "skip") {
      if (raw.at > after) skipped.push({ date: raw.date, holiday });
      continue;
    }
    if (holiday && rule === "next_working_day") {
      let n = dayNumber(raw.date.y, raw.date.m, raw.date.d);
      let moved: CivilDate | null = null;
      for (let i = 0; i < 31; i++) {
        n++;
        const c = fromDayNumber(n);
        if (isWorkingDay(c, hours)) {
          moved = c;
          break;
        }
      }
      if (!moved) continue;
      occ = { key: raw.key, at: zonedInstant(moved.y, moved.m, moved.d, h, min, tz), date: moved, movedFrom: { date: raw.date, holiday } };
    }
    const day = dayNumber(occ.date.y, occ.date.m, occ.date.d);
    if (day <= lastDay) continue;
    lastDay = day;
    if (occ.at <= after) continue;
    if (skipped.length) occ.skipped = skipped;
    skipped = [];
    out.push(occ);
  }
  return out;
}

/**
 * The occurrence stored under `key` (its scheduled date) as the calendar
 * has it now: on its date, or moved later by a holiday. Null when the
 * pattern no longer falls on that date, the skip rule drops it, or the day
 * before moved onto it (that run stands for both). The search starts at
 * 00:00 local on the day before the key's date, so the window is the same
 * whatever the zone's offset (an anchor in UTC missed evening runs west of
 * Greenwich).
 */
export function occurrenceForKey(
  p: RecurringPattern,
  key: string,
  opts: { tz: string; rule: HdHolidayRule; hours: HdBusinessHours | null }
): Occurrence | null {
  const date = parseIsoDate(key);
  if (!date) return null;
  const prev = fromDayNumber(dayNumber(date.y, date.m, date.d) - 1);
  const after = zonedInstant(prev.y, prev.m, prev.d, 0, 0, opts.tz);
  return nextOccurrences(p, { ...opts, after, count: 4, lookbackDays: 0 }).find((x) => x.key === key) ?? null;
}

// --- Due dates ------------------------------------------------------------------------------------------

/**
 * The close of the nth working day after `from` in the team's calendar (the
 * last open interval's end that day). With no calendar or no open hours,
 * n calendar days later.
 */
export function dueAfterBusinessDays(from: number, n: number, hours: HdBusinessHours | null): number {
  if (!hours || !hasOpenHours(hours)) return from + n * DAY_MS;
  const w = wallClock(from, hours.timezone);
  let day = dayNumber(w.y, w.m, w.d);
  let left = n;
  for (let i = 0; i < 400; i++) {
    day++;
    const c = fromDayNumber(day);
    if (!isWorkingDay(c, hours)) continue;
    if (--left > 0) continue;
    const segs = dayOpenIntervals(c.y, c.m, c.d, hours);
    const end = segs.length ? Math.max(...segs.map((s) => s.b)) : zonedInstant(c.y, c.m, c.d, 23, 59, hours.timezone);
    return end;
  }
  return from + n * DAY_MS;
}

// --- Words ------------------------------------------------------------------------------------------------

const DAY_LONG = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTH_SHORT = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const NTH_LABEL: Record<string, string> = { "1": "First", "2": "Second", "3": "Third", "4": "Fourth", "-1": "Last" };

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

/** "Mon Dec 7" */
export function shortDateLabel(c: CivilDate): string {
  return `${DAY_SHORT[isoWeekday(c)]} ${MONTH_SHORT[c.m]} ${c.d}`;
}

/** The list's line: "first Monday", "every Friday 09:00", "Jan, Apr, Jul, Oct", "every 2 weeks". */
export function patternSummary(p: RecurringPattern): string {
  switch (p.kind) {
    case "daily":
      return `every day ${p.time}`;
    case "weekly":
      if (p.days.length === 5 && p.days.every((d) => d <= 5)) return `weekdays ${p.time}`;
      if (p.days.length === 1) return `every ${DAY_LONG[p.days[0]]} ${p.time}`;
      return `${p.days.map((d) => DAY_SHORT[d]).join(", ")} ${p.time}`;
    case "monthly": {
      const what =
        p.mode === "day"
          ? p.day === -1
            ? "last day of the month"
            : `${ordinal(p.day)} of the month`
          : `${NTH_LABEL[String(p.nth)].toLowerCase()} ${DAY_LONG[p.weekday]}`;
      return p.months.length ? `${what} · ${p.months.map((m) => MONTH_SHORT[m]).join(", ")}` : what;
    }
    case "interval":
      return p.every === 1 ? `every ${p.unit === "weeks" ? "week" : "day"}` : `every ${p.every} ${p.unit}`;
  }
}

/** The note a preview row carries for a moved or skipped date. */
export function occurrenceNote(o: Occurrence): string {
  const parts: string[] = [];
  if (o.movedFrom) parts.push(`moved from ${shortDateLabel(o.movedFrom.date)}, ${o.movedFrom.holiday}`);
  for (const s of o.skipped ?? []) parts.push(`${shortDateLabel(s.date)} skipped for ${s.holiday}`);
  return parts.join("; ");
}

export const RECURRING_PLACEHOLDERS = ["{{month}}", "{{date}}", "{{week}}", "{{team}}"] as const;

/** Fill the placeholders for the occurrence's scheduled date: {{month}} "December 2026", {{date}} "Mon 7 Dec 2026", {{week}} "Week 49, 2026", {{team}}. */
export function renderTemplate(s: string, v: { date: CivilDate; team: string }): string {
  const c = v.date;
  const wk = isoWeek(c);
  return s
    .replace(/\{\{\s*month\s*\}\}/g, `${MONTH_LONG[c.m]} ${c.y}`)
    .replace(/\{\{\s*date\s*\}\}/g, `${DAY_SHORT[isoWeekday(c)]} ${c.d} ${MONTH_SHORT[c.m]} ${c.y}`)
    .replace(/\{\{\s*week\s*\}\}/g, `Week ${wk.week}, ${wk.year}`)
    .replace(/\{\{\s*team\s*\}\}/g, v.team);
}

/** The schedule's name in the list: the subject without its placeholders ("Monthly backup restore test"). */
export function scheduleTitle(subject: string): string {
  return subject.replace(/\{\{[^}]*\}\}/g, "").replace(/[\s:·,–—-]+$/u, "").replace(/\s{2,}/g, " ").trim() || subject.trim();
}
