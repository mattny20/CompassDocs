// Helpdesk 1.19.0: service levels. Pure business-hours arithmetic (any IANA
// timezone, working days, a daily window, holidays), the due dates a ticket
// gets on create and on a priority change, the pause/resume while it waits on
// the requester or is on hold, the derived sla_state / due_label every read
// shows, and the periodic sweep that records breaches and nearing warnings
// once (lib/periodic.runHelpdeskSweeps).
//
// The arithmetic is pure and takes the hours explicitly, so tests need no
// settings. The DB helpers take an optional client so ticket writes can run
// them inside their own transaction. Server-only for the DB half; the pure
// half (everything above "Database") is safe to import anywhere.

import type {
  HdBusinessHours,
  HdHolidayRange,
  HdPriority,
  HdSlaPolicy,
  HdSlaState,
  HdStatus,
  HdTicketRow,
} from "./types";
import { HD_OPEN_STATUSES, HD_PAUSED_STATUSES } from "./types";

const MIN = 60_000;
const DAY_MS = 86_400_000;

// --- Zoned wall clock ----------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface WallClock {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  min: number;
  s: number;
  /** ISO weekday 1 = Monday … 7 = Sunday. */
  dow: number;
}

/** The wall clock in `tz` at instant `t` (ms). */
export function wallClock(t: number, tz: string): WallClock {
  const parts = fmt(tz).formatToParts(new Date(t));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    h: Number(get("hour")) % 24,
    min: Number(get("minute")),
    s: Number(get("second")),
    dow: WEEKDAY[get("weekday")] ?? 1,
  };
}

/** The zone's offset from UTC at instant t, in ms (wall − utc). */
function offsetAt(t: number, tz: string): number {
  const w = wallClock(t, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(t / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `tz` reads y-m-d h:min. In a DST gap
 * (a time that does not exist) the result is the instant just after the gap;
 * in an overlap, the earlier of the two.
 */
export function zonedInstant(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - offsetAt(guess, tz);
  const o2 = offsetAt(t, tz);
  const t2 = guess - o2;
  if (t2 !== t) {
    // Offset changed between the guess and the answer (near a transition).
    const o3 = offsetAt(t2, tz);
    t = o3 === o2 ? t2 : Math.max(t, t2);
  }
  return t;
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function hm(s: string): [number, number] {
  const [h, m] = s.split(":").map(Number);
  return [h || 0, m || 0];
}

/** The calendar date after y-m-d (pure Gregorian arithmetic, no zone). */
function nextDate(y: number, m: number, d: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d) + DAY_MS);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

function prevDate(y: number, m: number, d: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d) - DAY_MS);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

function dowOf(y: number, m: number, d: number): number {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

// --- Business calendars (agent L) ----------------------------------------------
//
// Two shapes of HdBusinessHours. Legacy (no `schedule`): one daily window
// start–end on `days`, whole-day `holidays`; every result is exactly what the
// single-window implementation gave (test/helpdesk-calendars-regression). A
// calendar (`schedule`, from lib/helpdesk/calendars): per-weekday intervals
// (split shifts, "00:00"–"24:00" for a whole day, end ≤ start running past
// midnight into the next day) and `holidayRanges` closing whole or partial
// days, once or every year. Closures are wall-clock time on their own date:
// Christmas Day closes 00:00–24:00 on the 25th whichever day's shift covers
// it. Everything is computed as the sorted, non-overlapping open segments
// (instants) from a point on, so a DST change, a year boundary or a shift
// across midnight is just another segment.

/**
 * The due a calendar with no open hours at all gets (31 Dec 9999 UTC): far
 * enough never to breach, and recognisable (`due >= HD_NO_OPEN_HOURS_DUE`)
 * so the UI can say "No office hours" instead of a date.
 */
export const HD_NO_OPEN_HOURS_DUE = Date.UTC(9999, 11, 31);

/** Minute of the day of "HH:MM" (0 … 1440; "24:00" = 1440). */
function minuteOf(s: string): number {
  const [h, m] = hm(s);
  return Math.max(0, Math.min(1440, h * 60 + m));
}

/** The instant the wall clock in `tz` reads minute `min` (0 … 1440) of local date y-m-d. */
function zonedMinute(y: number, m: number, d: number, min: number, tz: string): number {
  if (min >= 1440) {
    const [ny, nm, nd] = nextDate(y, m, d);
    return zonedInstant(ny, nm, nd, 0, 0, tz);
  }
  return zonedInstant(y, m, d, Math.floor(min / 60), min % 60, tz);
}

/** No working day at all (empty days, or start ≥ end): legacy arithmetic falls back to calendar time. */
function noBusinessTime(hours: HdBusinessHours): boolean {
  const [sh, sm] = hm(hours.start);
  const [eh, em] = hm(hours.end);
  return hours.days.length === 0 || eh * 60 + em <= sh * 60 + sm;
}

/** True when the hours open at all (a calendar with every day closed has none). */
export function hasOpenHours(hours: HdBusinessHours): boolean {
  if (!hours.schedule) return !noBusinessTime(hours);
  return hours.schedule.some((day) => (day ?? []).some((iv) => minuteOf(iv.start) !== minuteOf(iv.end) && minuteOf(iv.start) < 1440));
}

export interface BusinessSegment {
  /** Opens (ms). */
  a: number;
  /** Closes (ms, exclusive). */
  b: number;
}

/** The open intervals of local date y-m-d before closures (an overnight one ends on the next date). */
export function dayOpenIntervals(y: number, m: number, d: number, hours: HdBusinessHours): (BusinessSegment & { overnight: boolean })[] {
  const tz = hours.timezone;
  if (!hours.schedule) {
    if (!hours.days.includes(dowOf(y, m, d))) return [];
    const [sh, sm] = hm(hours.start);
    const [eh, em] = hm(hours.end);
    const open = zonedInstant(y, m, d, sh, sm, tz);
    const close = zonedInstant(y, m, d, eh, em, tz);
    return close > open ? [{ a: open, b: close, overnight: false }] : [];
  }
  const out: (BusinessSegment & { overnight: boolean })[] = [];
  for (const iv of hours.schedule[dowOf(y, m, d) % 7] ?? []) {
    const s = minuteOf(iv.start);
    const e = minuteOf(iv.end);
    if (s === e || s >= 1440) continue;
    const a = zonedMinute(y, m, d, s, tz);
    let b: number;
    let overnight = false;
    if (e > s) b = zonedMinute(y, m, d, e, tz);
    else {
      const [ny, nm, nd] = nextDate(y, m, d);
      b = zonedMinute(ny, nm, nd, e, tz);
      overnight = e > 0;
    }
    if (b > a) out.push({ a, b, overnight });
  }
  return out.sort((x, y2) => x.a - y2.a);
}

interface ClosureIndex {
  exact: Map<string, HdHolidayRange[]>;
  yearly: Map<string, HdHolidayRange[]>;
}
const closureIndexCache = new WeakMap<HdBusinessHours, ClosureIndex>();
function closureIndex(hours: HdBusinessHours): ClosureIndex {
  let idx = closureIndexCache.get(hours);
  if (idx) return idx;
  idx = { exact: new Map(), yearly: new Map() };
  const add = (map: Map<string, HdHolidayRange[]>, key: string, r: HdHolidayRange) => {
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  };
  for (const date of hours.holidays ?? []) add(idx.exact, date, { date, name: "Holiday" });
  for (const r of hours.holidayRanges ?? []) {
    if (r.yearly) add(idx.yearly, r.date.slice(5), r);
    else add(idx.exact, r.date, r);
  }
  closureIndexCache.set(hours, idx);
  return idx;
}

export interface DayClosure extends BusinessSegment {
  name: string;
  /** False when only part of the day closes. */
  whole: boolean;
}

/** The closures (holidays) on local date y-m-d, as instants. */
export function dayClosures(y: number, m: number, d: number, hours: HdBusinessHours): DayClosure[] {
  const idx = closureIndex(hours);
  if (!idx.exact.size && !idx.yearly.size) return [];
  const date = ymd(y, m, d);
  const hits = [...(idx.exact.get(date) ?? []), ...(idx.yearly.get(date.slice(5)) ?? [])];
  if (!hits.length) return [];
  const out: DayClosure[] = [];
  for (const r of hits) {
    const from = r.from ? minuteOf(r.from) : 0;
    const to = r.to ? minuteOf(r.to) : 1440;
    if (to <= from) continue;
    out.push({ a: zonedMinute(y, m, d, from, hours.timezone), b: zonedMinute(y, m, d, to, hours.timezone), name: r.name, whole: from === 0 && to === 1440 });
  }
  return out;
}

function subtract(seg: BusinessSegment, cuts: BusinessSegment[]): BusinessSegment[] {
  let pieces = [seg];
  for (const c of cuts) {
    if (c.b <= seg.a || c.a >= seg.b) continue;
    const next: BusinessSegment[] = [];
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

/** Days scanned before giving up (holidays every day for years is a config error). */
const MAX_SCAN_DAYS = 3 * 366;

/**
 * The open segments from `from` on, in order, non-overlapping, the first
 * clipped to start at `from`. Stops after `until` (a local day starting
 * past it) or after the scan limit. Starts a day early so a shift running
 * past midnight into `from`'s date counts.
 */
export function* businessSegments(hours: HdBusinessHours, from: number, until = Infinity): Generator<BusinessSegment> {
  const w = wallClock(from, hours.timezone);
  let [y, m, d] = prevDate(w.y, w.m, w.d);
  let frontier = from;
  for (let i = 0; i < MAX_SCAN_DAYS + 1; i++) {
    if (until !== Infinity && i > 1 && zonedInstant(y, m, d, 0, 0, hours.timezone) > until) return;
    const segs = dayOpenIntervals(y, m, d, hours);
    if (segs.length) {
      const cuts = dayClosures(y, m, d, hours);
      let cutsNext: DayClosure[] | null = null;
      for (const s of segs) {
        let all: BusinessSegment[] = cuts;
        if (s.overnight) {
          if (!cutsNext) {
            const [ny, nm, nd] = nextDate(y, m, d);
            cutsNext = dayClosures(ny, nm, nd, hours);
          }
          all = [...cuts, ...cutsNext];
        }
        for (const p of all.length ? subtract(s, all) : [s]) {
          const a = Math.max(p.a, frontier);
          if (p.b <= a) continue;
          yield { a, b: p.b };
          frontier = p.b;
        }
      }
    }
    [y, m, d] = nextDate(y, m, d);
  }
}

/**
 * The instant `minutes` business minutes after `from`. Time outside the
 * open intervals and holiday closures does not count; a start outside
 * hours begins counting at the next opening. 0 minutes from outside hours
 * is the next opening. Legacy hours with no working time fall back to
 * calendar time; a calendar with no open hours (or none for three years)
 * returns HD_NO_OPEN_HOURS_DUE.
 */
export function addBusinessMinutes(from: Date | number, minutes: number, hours: HdBusinessHours): Date {
  const start = typeof from === "number" ? from : from.getTime();
  if (!hours.schedule && noBusinessTime(hours)) return new Date(start + minutes * MIN);
  if (hours.schedule && !hasOpenHours(hours)) return new Date(HD_NO_OPEN_HOURS_DUE);
  let remaining = Math.max(0, minutes) * MIN;
  for (const s of businessSegments(hours, start)) {
    const avail = s.b - s.a;
    if (remaining <= avail) return new Date(s.a + remaining);
    remaining -= avail;
  }
  return hours.schedule ? new Date(HD_NO_OPEN_HOURS_DUE) : new Date(start + minutes * MIN);
}

/** Business minutes between two instants (0 when b ≤ a). */
export function businessMinutesBetween(a: Date | number, b: Date | number, hours: HdBusinessHours): number {
  const ta = typeof a === "number" ? a : a.getTime();
  const tb = typeof b === "number" ? b : b.getTime();
  if (tb <= ta) return 0;
  if (!hours.schedule && noBusinessTime(hours)) return (tb - ta) / MIN;
  if (hours.schedule && !hasOpenHours(hours)) return 0;
  let total = 0;
  for (const s of businessSegments(hours, ta, tb)) {
    if (s.a >= tb) break;
    total += Math.min(s.b, tb) - s.a;
  }
  return total / MIN;
}

/** Inside open hours right now? */
export function inBusinessHours(t: Date | number, hours: HdBusinessHours): boolean {
  const ts = typeof t === "number" ? t : t.getTime();
  if (!hours.schedule && noBusinessTime(hours)) return true;
  if (hours.schedule && !hasOpenHours(hours)) return false;
  for (const s of businessSegments(hours, ts, ts + 2 * DAY_MS)) return s.a <= ts;
  return false;
}

/** The next opening at or after `t` (t itself when open), or null when none within the scan limit. */
export function nextOpening(t: Date | number, hours: HdBusinessHours): number | null {
  const ts = typeof t === "number" ? t : t.getTime();
  if (!hours.schedule && noBusinessTime(hours)) return ts;
  if (hours.schedule && !hasOpenHours(hours)) return null;
  for (const s of businessSegments(hours, ts)) return s.a;
  return null;
}

/** The end of the open segment `t` is in, or null when closed at `t`. */
export function closesAt(t: Date | number, hours: HdBusinessHours): number | null {
  const ts = typeof t === "number" ? t : t.getTime();
  if (!hours.schedule && noBusinessTime(hours)) return null;
  for (const s of businessSegments(hours, ts, ts + 2 * DAY_MS)) {
    if (s.a > ts) return null;
    // Contiguous segments (24/7, midnight) read as one stretch.
    let end = s.b;
    for (const n of businessSegments(hours, end, end + 8 * DAY_MS)) {
      if (n.a > end || n.b - ts > 8 * DAY_MS) break;
      end = n.b;
    }
    return end;
  }
  return null;
}

/** The holiday closure covering `t`, if any. */
export function closureAt(t: Date | number, hours: HdBusinessHours): DayClosure | null {
  const ts = typeof t === "number" ? t : t.getTime();
  const w = wallClock(ts, hours.timezone);
  for (const c of dayClosures(w.y, w.m, w.d, hours)) if (c.a <= ts && ts < c.b) return c;
  return null;
}

// --- Targets -------------------------------------------------------------------

/** The starter targets (setup checklist, seed): urgent reply 1h; others reply 4 business hours, resolve 2 business days. */
export function starterPolicies(hours: Pick<HdBusinessHours, "start" | "end"> = { start: "09:00", end: "17:30" }): Omit<HdSlaPolicy, "id">[] {
  const [sh, sm] = hm(hours.start);
  const [eh, em] = hm(hours.end);
  const day = Math.max(60, eh * 60 + em - (sh * 60 + sm));
  return [
    { name: "Urgent", priority: "urgent", first_reply_minutes: 60, resolve_minutes: day, business_hours: 1 },
    { name: "High", priority: "high", first_reply_minutes: 240, resolve_minutes: 2 * day, business_hours: 1 },
    { name: "Normal", priority: "normal", first_reply_minutes: 240, resolve_minutes: 2 * day, business_hours: 1 },
    { name: "Low", priority: "low", first_reply_minutes: 240, resolve_minutes: 2 * day, business_hours: 1 },
  ];
}

/** Add a policy's minutes, in business or calendar time as the policy says. */
export function addPolicyMinutes(from: number, minutes: number, policy: Pick<HdSlaPolicy, "business_hours">, hours: HdBusinessHours): number {
  return policy.business_hours ? addBusinessMinutes(from, minutes, hours).getTime() : from + minutes * MIN;
}

/** Policy minutes between two instants. */
export function policyMinutesBetween(a: number, b: number, policy: Pick<HdSlaPolicy, "business_hours">, hours: HdBusinessHours): number {
  return policy.business_hours ? businessMinutesBetween(a, b, hours) : Math.max(0, (b - a) / MIN);
}

/** The due dates a ticket created (or re-prioritised) at `from` gets under `policy`. */
export function computeDues(
  from: number,
  policy: HdSlaPolicy,
  hours: HdBusinessHours
): { first_reply_due: Date; resolve_due: Date } {
  return {
    first_reply_due: new Date(addPolicyMinutes(from, policy.first_reply_minutes, policy, hours)),
    resolve_due: new Date(addPolicyMinutes(from, policy.resolve_minutes, policy, hours)),
  };
}

/**
 * Resume after a pause: a clock still running when it paused keeps the
 * business time it had left; a clock already past due when it paused stays
 * where it was (the breach stands). Returns the new dues (null stays null).
 */
export function resumedDues(
  t: Pick<HdTicketRow, "first_reply_due" | "resolve_due" | "first_replied_at">,
  pausedAt: number,
  now: number,
  policy: Pick<HdSlaPolicy, "business_hours">,
  hours: HdBusinessHours
): { first_reply_due: Date | null; resolve_due: Date | null } {
  const shift = (due: string | null, running: boolean): Date | null => {
    if (!due) return null;
    const d = Date.parse(due);
    if (!running || d <= pausedAt) return new Date(d);
    const left = policyMinutesBetween(pausedAt, d, policy, hours);
    return new Date(addPolicyMinutes(now, left, policy, hours));
  };
  return {
    first_reply_due: shift(t.first_reply_due, !t.first_replied_at),
    resolve_due: shift(t.resolve_due, true),
  };
}

// --- Derived state -------------------------------------------------------------

type SlaFields = Pick<
  HdTicketRow,
  | "status"
  | "first_reply_due"
  | "resolve_due"
  | "first_replied_at"
  | "solved_at"
  | "sla_paused_at"
  | "created_at"
>;

/** The window inside which a running clock reads "warn": a quarter of the target, at most an hour, at least 15 minutes. */
export function warnWindowMs(startedAt: number, due: number): number {
  const span = Math.max(0, due - startedAt);
  return Math.min(60 * MIN, Math.max(15 * MIN, span / 4));
}

export interface ClockState {
  due: string | null;
  met_at: string | null;
  state: HdSlaState | null;
}

/** One clock (first reply or resolution) of a ticket at `now`. */
export function clockState(due: string | null, metAt: string | null, startedAt: string, paused: boolean, now: number): ClockState {
  if (!due) return { due, met_at: metAt, state: null };
  const d = Date.parse(due);
  if (metAt) return { due, met_at: metAt, state: Date.parse(metAt) <= d ? "met" : "breached" };
  if (now > d) return { due, met_at: null, state: "breached" };
  if (paused) return { due, met_at: null, state: "paused" };
  return { due, met_at: null, state: d - now <= warnWindowMs(Date.parse(startedAt), d) ? "warn" : "ok" };
}

/** The ticket's one-word SLA state (the queue's Due column). */
export function slaState(t: SlaFields, now = Date.now()): HdSlaState | null {
  if (!t.first_reply_due && !t.resolve_due) return null;
  const closed = !HD_OPEN_STATUSES.includes(t.status);
  const paused = !!t.sla_paused_at && HD_PAUSED_STATUSES.includes(t.status);
  const fr = clockState(t.first_reply_due, t.first_replied_at, t.created_at, paused, now);
  const rs = clockState(t.resolve_due, closed ? t.solved_at : null, t.created_at, paused, now);
  if (closed) {
    if (fr.state === "breached" || rs.state === "breached") return "breached";
    // Solved without a recorded solve time (closed directly): met unless past due.
    return "met";
  }
  if (fr.state === "breached" || rs.state === "breached") return "breached";
  if (paused) return "paused";
  if (fr.state === "warn" || rs.state === "warn") return "warn";
  return "ok";
}

/** "25m", "1h 20m", "2d", "3d 4h". */
export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 && d < 3 ? `${d}d ${h % 24}h` : `${d}d`;
}

function dayIndex(t: number, tz: string): number {
  const w = wallClock(t, tz);
  return Math.floor(Date.UTC(w.y, w.m - 1, w.d) / DAY_MS);
}

/** "Resolve due in 3h 48m" / "tomorrow" / "in 2d". */
function dueIn(what: "Reply" | "Resolve", due: number, now: number, tz: string): string {
  const ms = due - now;
  if (ms < 12 * 3_600_000) return `${what} due in ${formatDuration(ms)}`;
  const days = dayIndex(due, tz) - dayIndex(now, tz);
  if (days <= 0) return `${what} due in ${formatDuration(ms)}`;
  if (days === 1) return `${what} due tomorrow`;
  return `${what} due in ${days}d`;
}

/**
 * What the queue's Due column says: "Reply overdue 25m", "Reply due in 1h
 * 20m", "Reply met · resolve in 5h", "Resolve due tomorrow", "Paused", "Met",
 * "Breached", or '' when the ticket has no SLA.
 */
export function dueLabel(t: SlaFields, now = Date.now(), tz = "UTC"): string {
  const state = slaState(t, now);
  if (state === null) return "";
  if (!HD_OPEN_STATUSES.includes(t.status)) return state === "breached" ? "Breached" : "Met";
  if (!t.first_replied_at && t.first_reply_due) {
    const d = Date.parse(t.first_reply_due);
    if (now > d) return `Reply overdue ${formatDuration(now - d)}`;
    if (state === "paused") return "Paused";
    // The team's calendar has no open hours: the clock never runs (never breaches).
    if (d >= HD_NO_OPEN_HOURS_DUE) return "No office hours";
    return dueIn("Reply", d, now, tz);
  }
  if (t.resolve_due) {
    const d = Date.parse(t.resolve_due);
    if (now > d) return `Resolve overdue ${formatDuration(now - d)}`;
    if (state === "paused") return "Paused";
    if (d >= HD_NO_OPEN_HOURS_DUE) return "No office hours";
    const repliedRecently = t.first_replied_at && now - Date.parse(t.first_replied_at) < 3_600_000;
    if (repliedRecently && d - now < 24 * 3_600_000) return `Reply met · resolve in ${formatDuration(d - now)}`;
    return dueIn("Resolve", d, now, tz);
  }
  return state === "paused" ? "Paused" : "Met";
}

/** The next due the Due column sorts by: first reply until met, then resolution. */
export function nextDue(t: Pick<HdTicketRow, "first_reply_due" | "resolve_due" | "first_replied_at">): string | null {
  return !t.first_replied_at && t.first_reply_due ? t.first_reply_due : t.resolve_due;
}

/** How much of the resolution window has elapsed, 0–100 (policy time), or null. */
export function resolveElapsedPercent(
  t: Pick<HdTicketRow, "created_at" | "resolve_due" | "solved_at" | "sla_paused_at">,
  policy: HdSlaPolicy | null,
  hours: HdBusinessHours,
  now = Date.now()
): number | null {
  if (!t.resolve_due || !policy) return null;
  const end = t.solved_at ? Date.parse(t.solved_at) : t.sla_paused_at ? Date.parse(t.sla_paused_at) : now;
  const due = Date.parse(t.resolve_due);
  if (end >= due) return 100;
  const created = Date.parse(t.created_at);
  const total = policyMinutesBetween(created, due, policy, hours);
  if (total <= 0) return 100;
  const left = policyMinutesBetween(end, due, policy, hours);
  return Math.max(0, Math.min(100, Math.round(((total - left) / total) * 100)));
}

/** True when moving from `from` to `to` pauses the clock. */
export function pausesSla(from: HdStatus, to: HdStatus): boolean {
  return !HD_PAUSED_STATUSES.includes(from) && HD_PAUSED_STATUSES.includes(to);
}
/** True when moving from `from` to `to` resumes it. */
export function resumesSla(from: HdStatus, to: HdStatus): boolean {
  return HD_PAUSED_STATUSES.includes(from) && !HD_PAUSED_STATUSES.includes(to);
}

export function isPriority(v: unknown): v is HdPriority {
  return v === "low" || v === "normal" || v === "high" || v === "urgent";
}
