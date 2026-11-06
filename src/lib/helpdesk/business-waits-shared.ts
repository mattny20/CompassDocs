// Helpdesk 1.19.1: business-hours counting for workflow time (agent V5).
// A Wait step ("until 2 days before the start date", "for 8 hours"), a
// task's due offset and an approval's reminder delay may count calendar
// time (the default, and the only option before 1.19.1) or business time:
// offsets in days become business days, hours become business hours, in a
// team's calendar (lib/helpdesk/calendars: office hours and holidays).
//
//   business day  a local date in the calendar's zone with some open time
//                 left after its holidays (a part-day holiday leaves the
//                 day a business day; a whole-day one does not)
//   N days before the date   the Nth business day before it (the date
//                 itself never counts); N after: the Nth after; on the
//                 day: the date, or the next business day when it is not one
//   a wait ends   at the opening of that business day; a task is due at
//                 its close (calendar mode keeps 00:00 and 17:00 UTC)
//   N hours       N business hours from the moment it starts
//
// Pure: safe in client components (the builder's summaries) and on the
// server (the engine, the test run, the worked example).

import { addBusinessMinutes, dayClosures, dayOpenIntervals, hasOpenHours, HD_NO_OPEN_HOURS_DUE, wallClock, zonedInstant } from "./sla";
import type { HdBusinessHours, HdCountDef, HdFormAnswers, HdWaitStepDef, HdDueDef } from "./types";

export type HdCountMode = "calendar" | "business";

/** How a step counts: "business" only when it says so. */
export function countMode(s: HdCountDef | null | undefined): HdCountMode {
  return s?.count === "business" ? "business" : "calendar";
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The count fields of a raw step, checked: { count: "business",
 * count_team_id? } or {} for calendar (a stored "calendar" is dropped so a
 * definition saved again stays byte-identical to an older one).
 */
export function checkCount(raw: unknown, where: string): Checked<HdCountDef> {
  if (!isObj(raw)) return { ok: true, value: {} };
  const c = raw.count;
  if (c === undefined || c === null || c === "calendar") return { ok: true, value: {} };
  if (c !== "business") return { ok: false, error: `${where}: count calendar days or business days.` };
  const out: HdCountDef = { count: "business" };
  const t = raw.count_team_id;
  if (t !== undefined && t !== null && t !== 0) {
    if (typeof t !== "number" || !Number.isInteger(t) || t <= 0) return { ok: false, error: `${where}: pick the team whose calendar counts.` };
    out.count_team_id = t;
  }
  return { ok: true, value: out };
}

// --- Dates --------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MAX_SCAN = 3 * 366;

function isIso(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

function shift(y: number, m: number, d: number, by: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d) + by * DAY_MS);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The open time of local date y-m-d left after its holidays, as [opens, closes] pieces (empty: not a business day). */
export function businessPieces(y: number, m: number, d: number, hours: HdBusinessHours): { a: number; b: number }[] {
  let pieces = dayOpenIntervals(y, m, d, hours).map((s) => ({ a: s.a, b: s.b }));
  if (!pieces.length) return [];
  for (const c of dayClosures(y, m, d, hours)) {
    const next: { a: number; b: number }[] = [];
    for (const p of pieces) {
      if (c.b <= p.a || c.a >= p.b) next.push(p);
      else {
        if (c.a > p.a) next.push({ a: p.a, b: c.a });
        if (c.b < p.b) next.push({ a: c.b, b: p.b });
      }
    }
    pieces = next;
  }
  return pieces;
}

/** Why a local date is not a business day: its holiday's name, or null (a weekend or a day the calendar is shut). */
function closedBecause(y: number, m: number, d: number, hours: HdBusinessHours): string | null {
  if (!dayOpenIntervals(y, m, d, hours).length) return null;
  return dayClosures(y, m, d, hours).find((c) => c.whole)?.name ?? dayClosures(y, m, d, hours)[0]?.name ?? null;
}

export interface BusinessDayShift {
  /** The resulting local date (YYYY-MM-DD), or null when the calendar has no business day in reach. */
  date: string | null;
  /** When the step moves on (a wait: the day's opening) or falls due (a task: its close). */
  at: number | null;
  /** Holidays passed over on the way (date and name), for the explanation. */
  holidays: { date: string; name: string }[];
}

/**
 * The form date `date` moved by `offsetDays` business days in `hours`
 * (see the header). `at`: "open" for a wait, "close" for a due.
 */
export function shiftBusinessDays(date: string, offsetDays: number, hours: HdBusinessHours, at: "open" | "close"): BusinessDayShift {
  const r = shiftRaw(date, offsetDays, hours, at);
  // Oldest first, however the count walked.
  r.holidays.sort((a, b) => a.date.localeCompare(b.date));
  return r;
}

function shiftRaw(date: string, offsetDays: number, hours: HdBusinessHours, at: "open" | "close"): BusinessDayShift {
  const holidays: { date: string; name: string }[] = [];
  if (!isIso(date) || !hasOpenHours(hours)) return { date: null, at: null, holidays };
  let [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const step = offsetDays < 0 ? -1 : 1;
  let left = Math.abs(offsetDays);
  const note = (yy: number, mm: number, dd: number) => {
    const why = closedBecause(yy, mm, dd, hours);
    if (why) holidays.push({ date: iso(yy, mm, dd), name: why });
  };
  if (left === 0) {
    // On the day: that date, or the next business day when it is not one.
    for (let i = 0; i < MAX_SCAN; i++) {
      const p = businessPieces(y, m, d, hours);
      if (p.length) return { date: iso(y, m, d), at: at === "open" ? p[0].a : p[p.length - 1].b, holidays };
      note(y, m, d);
      [y, m, d] = shift(y, m, d, 1);
    }
    return { date: null, at: null, holidays };
  }
  for (let i = 0; i < MAX_SCAN; i++) {
    [y, m, d] = shift(y, m, d, step);
    const p = businessPieces(y, m, d, hours);
    if (!p.length) {
      note(y, m, d);
      continue;
    }
    if (--left === 0) return { date: iso(y, m, d), at: at === "open" ? p[0].a : p[p.length - 1].b, holidays };
  }
  return { date: null, at: null, holidays };
}

/** A form date plus calendar days at a UTC hour (the 1.19.0 rule, kept for calendar mode). */
function calendarFieldDate(answers: HdFormAnswers, field: string, offsetDays: number, hourUtc: number): Date | null {
  const v = answers[field];
  if (!isIso(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays, hourUtc));
}

/**
 * When a task is due, counting as the step says. `hours` is the counting
 * team's calendar (only read in business mode). Null = no due date.
 */
export function countedTaskDue(due: HdDueDef | undefined, answers: HdFormAnswers, from: Date, mode: HdCountMode, hours: HdBusinessHours | null): Date | null {
  if (!due) return null;
  if (mode === "business" && hours) {
    if ("field" in due) {
      const v = answers[due.field];
      if (!isIso(v)) return null;
      const r = shiftBusinessDays(v, due.offset_days ?? 0, hours, "close");
      return r.at !== null ? new Date(r.at) : calendarFieldDate(answers, due.field, due.offset_days ?? 0, 17);
    }
    return capped(addBusinessMinutes(from, due.after_hours * 60, hours), from, due.after_hours);
  }
  if ("field" in due) return calendarFieldDate(answers, due.field, due.offset_days ?? 0, 17);
  return new Date(from.getTime() + due.after_hours * 3_600_000);
}

/** When a wait ends, counting as the step says. A missing date ends it at once. */
export function countedWaitUntil(until: HdWaitStepDef["until"], answers: HdFormAnswers, from: Date, mode: HdCountMode, hours: HdBusinessHours | null): Date {
  if ("field" in until) {
    const off = until.offset_days ?? 0;
    if (mode === "business" && hours) {
      const v = answers[until.field];
      if (!isIso(v)) return from;
      const r = shiftBusinessDays(v, off, hours, "open");
      if (r.at !== null) return new Date(r.at);
    }
    return calendarFieldDate(answers, until.field, off, 0) ?? from;
  }
  if (mode === "business" && hours) return capped(addBusinessMinutes(from, until.after_hours * 60, hours), from, until.after_hours);
  return new Date(from.getTime() + until.after_hours * 3_600_000);
}

/** When an approval's reminder goes, counting as the step says (null: no reminder). */
export function countedReminderAt(createdAt: Date, remindHours: number | null | undefined, mode: HdCountMode, hours: HdBusinessHours | null): Date | null {
  if (!remindHours) return null;
  if (mode === "business" && hours) return capped(addBusinessMinutes(createdAt, remindHours * 60, hours), createdAt, remindHours);
  return new Date(createdAt.getTime() + remindHours * 3_600_000);
}

/** A calendar with no open hours never reaches a business due: fall back to calendar time rather than year 9999. */
function capped(d: Date, from: Date, hoursN: number): Date {
  return d.getTime() >= HD_NO_OPEN_HOURS_DUE ? new Date(from.getTime() + hoursN * 3_600_000) : d;
}

// --- Words --------------------------------------------------------------------------

/** An hours delay in words, honest about how it counts ("1 business day" means 8 business hours only when business). */
export function countedHoursLabel(h: number, mode: HdCountMode): string {
  if (mode === "business") {
    if (h % 40 === 0 && h >= 40) return h === 40 ? "1 working week" : `${h / 40} working weeks`;
    if (h % 8 === 0 && h >= 8) return h === 8 ? "1 business day" : `${h / 8} business days`;
    return h === 1 ? "1 business hour" : `${h} business hours`;
  }
  if (h % 24 === 0 && h >= 24) return h === 24 ? "1 day" : `${h / 24} days`;
  return h === 1 ? "1 hour" : `${h} hours`;
}

/** "2 business days before" / "3 days after" / "on" (the field label follows). */
export function countedOffsetLabel(offsetDays: number, mode: HdCountMode): string {
  if (!offsetDays) return "on";
  const n = Math.abs(offsetDays);
  return `${n} ${mode === "business" ? "business " : ""}${n === 1 ? "day" : "days"} ${offsetDays < 0 ? "before" : "after"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon Jan 4" for a YYYY-MM-DD date. */
export function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MONTHS[m - 1]} ${d}`;
}

/** "Dec 31" for a YYYY-MM-DD date. */
function monthDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface CountExample {
  /** The sample form date (YYYY-MM-DD). */
  from: string;
  /** Where the step lands (YYYY-MM-DD). */
  to: string;
  holidays: { date: string; name: string }[];
  /** "Start date Mon Jan 4 → moves on Tue Dec 29 (Dec 31 and Jan 1 are holidays)." */
  text: string;
}

/**
 * The builder's worked example: a sample form date in the coming year that
 * shows the business rule at work, preferring one whose offset passes over
 * a holiday, else the next Monday (a weekend in between), and the date the
 * step would land on. Null when the calendar has no business days.
 */
export function countExample(
  offsetDays: number,
  hours: HdBusinessHours,
  opts: { fieldLabel: string; kind: "wait" | "due"; now?: number }
): CountExample | null {
  if (!hasOpenHours(hours)) return null;
  const now = opts.now ?? Date.now();
  const w = wallClock(now, hours.timezone);
  const verb = opts.kind === "wait" ? "moves on" : "due";
  const at = opts.kind === "wait" ? "open" : "close";
  const describe = (from: string, r: BusinessDayShift): CountExample | null => {
    if (!r.date) return null;
    const names = r.holidays.map((h) => monthDay(h.date));
    const why = names.length ? ` (${listWords(names)} ${names.length === 1 ? "is a holiday" : "are holidays"})` : offsetDays ? " (the weekend doesn't count)" : "";
    return { from, to: r.date, holidays: r.holidays, text: `${opts.fieldLabel} ${shortDate(from)} → ${verb} ${shortDate(r.date)}${why}.` };
  };
  let firstMonday: string | null = null;
  // Start a week out so the example date is in the future either way.
  for (let i = 7; i < 372; i++) {
    const [y, m, d] = shift(w.y, w.m, w.d, i);
    const day = iso(y, m, d);
    // On the day (offset 0) shows the roll past a holiday; otherwise start from a business day.
    if (!businessPieces(y, m, d, hours).length && offsetDays !== 0) continue;
    const r = shiftBusinessDays(day, offsetDays, hours, at);
    if (r.holidays.length) return describe(day, r);
    if (!firstMonday && new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 1) firstMonday = day;
  }
  if (!firstMonday) return null;
  return describe(firstMonday, shiftBusinessDays(firstMonday, offsetDays, hours, at));
}

/** zonedInstant re-exported for tests that build sample instants in a zone. */
export { zonedInstant };
