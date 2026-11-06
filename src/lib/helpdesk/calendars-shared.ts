// Helpdesk 1.19.0: business calendars, the pure half (agent L). Safe to
// import in the browser: the API shapes, schedule validation and the
// "Mon–Fri 09:00–17:30" summary, the holiday paste and .ics parsers, the
// preview explanation ("Opens Mon 09:00 (Easter Monday closed)"), the clock
// note the queue shows while a team is closed, and the requester-side open
// state. The arithmetic itself is lib/helpdesk/sla (businessSegments …).

import {
  HD_NO_OPEN_HOURS_DUE,
  addBusinessMinutes,
  businessSegments,
  closesAt,
  closureAt,
  dayClosures,
  dayOpenIntervals,
  hasOpenHours,
  inBusinessHours,
  nextOpening,
  wallClock,
  zonedInstant,
} from "./sla";
import { HD_OPEN_STATUSES, HD_PAUSED_STATUSES, HD_PRIORITIES } from "./types";
import type { HdBusinessHours, HdHolidayRange, HdPriority, HdStatus, HdTimeInterval } from "./types";

// --- API shapes ------------------------------------------------------------------

export type HdWeekSchedule = HdTimeInterval[][];

export interface HdCalendar {
  id: number;
  name: string;
  timezone: string;
  /** Index 0 = Sunday … 6 = Saturday. */
  schedule: HdWeekSchedule;
  is_default: boolean;
  holiday_set_ids: number[];
  /** Teams that use it (the default also serves every team without one). */
  team_ids: number[];
  created_at: string;
  updated_at: string;
}

export interface HdHolidaySet {
  id: number;
  name: string;
  description: string;
  calendar_ids: number[];
  holiday_count: number;
}

export interface HdHoliday {
  id: number;
  set_id: number;
  /** "YYYY-MM-DD". */
  date: string;
  name: string;
  recurring_yearly: boolean;
  /** "HH:MM" or null (closed from midnight). */
  closed_from: string | null;
  /** "HH:MM" or null (closed to the end of the day). */
  closed_to: string | null;
}

export type HdHolidayInput = Omit<HdHoliday, "id" | "set_id">;

export interface HdCalendarTeam {
  id: number;
  name: string;
  calendar_id: number | null;
}

export interface HdTeamSlaTarget {
  priority: HdPriority;
  first_reply_minutes: number;
  resolve_minutes: number;
  business_hours: number;
}

export interface HdTeamSlaView {
  team: { id: number; name: string };
  /** The team's own targets (missing priorities use the workspace's). */
  targets: HdTeamSlaTarget[];
  /** The workspace policies, for the greyed "Workspace default" line. */
  workspace: HdTeamSlaTarget[];
}

export interface HdDuePreview {
  due: string | null;
  no_open_hours: boolean;
  /** One line: "Due Mon 9 Nov 12:00 · opens Mon 09:00 (Easter Monday closed)". */
  summary: string;
  /** The working stretches counted and the closures skipped, in order. */
  lines: string[];
  timezone: string;
  calendar: { id: number; name: string } | null;
  /** When a priority was given: the target used and where it came from. */
  target?: { priority: HdPriority; minutes: number; business_hours: number; source: "team" | "workspace"; what: "first_reply" | "resolve" };
}

export const CALENDAR_LIMITS = {
  name: 80,
  description: 300,
  holidayName: 120,
  intervalsPerDay: 6,
  holidaysPerSet: 2000,
  holidaysPerRequest: 500,
  setsPerCalendar: 20,
  calendars: 100,
  sets: 100,
  icsBytes: 512 * 1024,
  previewMinutes: 60 * 24 * 365,
} as const;

// --- Days and times ----------------------------------------------------------------

/** Display order Monday first, as indexes into a schedule (0 = Sunday). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function validDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1970 && y <= 2200;
}

function minutes(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

export function emptySchedule(): HdWeekSchedule {
  return [[], [], [], [], [], [], []];
}

/** The legacy single window as a schedule (ISO days 1 … 7 → index 1 … 6, 0). */
export function scheduleFromLegacy(days: number[], start: string, end: string): HdWeekSchedule {
  const s = emptySchedule();
  for (const d of days) if (d >= 1 && d <= 7) s[d % 7] = [{ start, end }];
  return s;
}

/** The legacy fields a schedule summarises (the earliest opening, the latest close). */
export function legacyFromSchedule(schedule: HdWeekSchedule): { days: number[]; start: string; end: string } {
  const days: number[] = [];
  let lo = "",
    hi = "";
  schedule.forEach((ivs, i) => {
    const open = ivs.filter((iv) => iv.start !== iv.end);
    if (!open.length) return;
    days.push(i === 0 ? 7 : i);
    for (const iv of open) {
      if (!lo || iv.start < lo) lo = iv.start;
      const e = iv.end <= iv.start || iv.end === "24:00" ? "23:59" : iv.end;
      if (!hi || e > hi) hi = e;
    }
  });
  return { days: days.sort((a, b) => a - b), start: lo || "09:00", end: hi || "17:30" };
}

/** Validate a schedule from a request body: 7 days, at most 6 intervals each, no overlaps within a day. */
export function validateSchedule(raw: unknown): { ok: true; value: HdWeekSchedule } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length !== 7) return { ok: false, error: "Send the week as seven days, Sunday first." };
  const out: HdWeekSchedule = [];
  for (let i = 0; i < 7; i++) {
    const day = raw[i];
    if (!Array.isArray(day)) return { ok: false, error: `${DAY_LONG[i]}: send a list of intervals.` };
    if (day.length > CALENDAR_LIMITS.intervalsPerDay) return { ok: false, error: `${DAY_LONG[i]}: at most ${CALENDAR_LIMITS.intervalsPerDay} intervals.` };
    const ivs: HdTimeInterval[] = [];
    for (const iv of day as Record<string, unknown>[]) {
      const start = typeof iv?.start === "string" ? iv.start : "";
      const end = typeof iv?.end === "string" ? iv.end : "";
      if (!TIME.test(start) || !END_TIME.test(end)) return { ok: false, error: `${DAY_LONG[i]}: times are HH:MM (24-hour), ending at 24:00 at the latest.` };
      if (start === end) return { ok: false, error: `${DAY_LONG[i]}: ${start}–${end} is empty.` };
      ivs.push({ start, end });
    }
    ivs.sort((a, b) => a.start.localeCompare(b.start));
    const spans = ivs.map((iv) => {
      const s = minutes(iv.start);
      let e = iv.end === "24:00" ? 1440 : minutes(iv.end);
      if (e <= s) e += 1440;
      return [s, e] as const;
    });
    for (let j = 1; j < spans.length; j++) {
      if (spans[j][0] < spans[j - 1][1]) return { ok: false, error: `${DAY_LONG[i]}: ${ivs[j - 1].start}–${ivs[j - 1].end} and ${ivs[j].start}–${ivs[j].end} overlap.` };
    }
    out.push(ivs);
  }
  return { ok: true, value: out };
}

function ivLabel(iv: HdTimeInterval): string {
  if (iv.start === "00:00" && iv.end === "24:00") return "all day";
  return `${iv.start}–${iv.end === "24:00" ? "24:00" : iv.end}`;
}

/** "Mon–Fri 09:00–17:30", "Mon–Thu 09:00–17:30 · Fri 09:00–16:00", "Open 24/7", "Closed every day". */
export function summarizeSchedule(schedule: HdWeekSchedule): string {
  const keys = WEEK_ORDER.map((i) => (schedule[i] ?? []).map(ivLabel).join(", "));
  if (keys.every((k) => k === "all day")) return "Open 24/7";
  if (keys.every((k) => k === "")) return "Closed every day";
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    if (!keys[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < 7 && keys[j + 1] === keys[i]) j++;
    const from = DAY_SHORT[WEEK_ORDER[i]];
    const to = DAY_SHORT[WEEK_ORDER[j]];
    const days = i === j ? from : j === i + 1 ? `${from}, ${to}` : `${from}–${to}`;
    parts.push(`${days} ${keys[i]}`);
    i = j + 1;
  }
  return parts.join(" · ");
}

/** Open minutes a week (display: "42.5 hours a week"). */
export function weeklyOpenMinutes(schedule: HdWeekSchedule): number {
  let total = 0;
  for (const ivs of schedule) {
    for (const iv of ivs) {
      const s = minutes(iv.start);
      let e = iv.end === "24:00" ? 1440 : minutes(iv.end);
      if (e <= s) e += 1440;
      total += e - s;
    }
  }
  return total;
}

/** The hours the arithmetic takes, built from a calendar and its holidays. */
export function hoursFromCalendar(
  cal: Pick<HdCalendar, "id" | "name" | "timezone" | "schedule">,
  holidays: Pick<HdHoliday, "date" | "name" | "recurring_yearly" | "closed_from" | "closed_to">[]
): HdBusinessHours {
  const legacy = legacyFromSchedule(cal.schedule);
  const holidayRanges: HdHolidayRange[] = holidays.map((h) => ({
    date: h.date,
    name: h.name,
    from: h.closed_from,
    to: h.closed_to,
    yearly: h.recurring_yearly,
  }));
  return {
    timezone: cal.timezone,
    days: legacy.days,
    start: legacy.start,
    end: legacy.end,
    holidays: [],
    schedule: cal.schedule,
    holidayRanges,
    calendar: { id: cal.id, name: cal.name },
  };
}

// --- Holiday input -----------------------------------------------------------------

export function validateHoliday(raw: Record<string, unknown>): { ok: true; value: HdHolidayInput } | { ok: false; error: string } {
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  if (!validDate(date)) return { ok: false, error: "Give the date as YYYY-MM-DD." };
  const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: `Name the holiday on ${date}.` };
  if (name.length > CALENDAR_LIMITS.holidayName) return { ok: false, error: `Holiday names are up to ${CALENDAR_LIMITS.holidayName} characters.` };
  const t = (v: unknown, re: RegExp) => (v === null || v === undefined || v === "" ? null : typeof v === "string" && re.test(v) ? v : undefined);
  const from = t(raw.closed_from, TIME);
  const to = t(raw.closed_to, END_TIME);
  if (from === undefined || to === undefined) return { ok: false, error: "Partial-day times are HH:MM." };
  if (from && to && to <= from && to !== "24:00") return { ok: false, error: `${name}: the closure ends before it starts.` };
  return {
    ok: true,
    value: {
      date,
      name,
      recurring_yearly: raw.recurring_yearly === true || raw.recurring_yearly === 1,
      closed_from: from === "00:00" ? null : from,
      closed_to: to === "24:00" ? null : to,
    },
  };
}

/**
 * Pasted lines, one holiday each: "2026-12-25 Christmas Day", optionally a
 * partial day "2026-12-24 13:00-24:00 Christmas Eve" and "(yearly)" /
 * "every year" at the end. Commas or tabs after the date are fine.
 */
export function parseHolidayLines(text: string): { holidays: HdHolidayInput[]; errors: { line: number; text: string; error: string }[] } {
  const holidays: HdHolidayInput[] = [];
  const errors: { line: number; text: string; error: string }[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^(\d{4}-\d{2}-\d{2})[\s,;\t]+(?:(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})[\s,;\t]+)?(.+)$/.exec(line);
    if (!m) {
      errors.push({ line: i + 1, text: line, error: "Start the line with a date (YYYY-MM-DD) and a name." });
      return;
    }
    let name = m[4].trim();
    let yearly = false;
    const y = /\s*(\(yearly\)|\(every year\)|every year|yearly)$/i.exec(name);
    if (y) {
      yearly = true;
      name = name.slice(0, y.index).trim();
    }
    const v = validateHoliday({ date: m[1], name, closed_from: m[2] ?? null, closed_to: m[3] ?? null, recurring_yearly: yearly });
    if (!v.ok) errors.push({ line: i + 1, text: line, error: v.error });
    else holidays.push(v.value);
  });
  return { holidays, errors };
}

/**
 * The holidays in an iCalendar file (.ics): each VEVENT's DTSTART date and
 * SUMMARY; an all-day event spanning several days becomes one holiday per
 * day (up to 31); RRULE:FREQ=YEARLY (no COUNT, UNTIL or INTERVAL) repeats
 * every year; other repeat rules keep the first date and are reported.
 * Timed events with floating or TZID local times close that part of the
 * day; UTC-timed ones close the whole day. Never fetches anything.
 */
export function parseIcs(text: string): { holidays: HdHolidayInput[]; skipped: string[] } {
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const holidays: HdHolidayInput[] = [];
  const skipped: string[] = [];
  const events = unfolded.split(/\nBEGIN:VEVENT\n|^BEGIN:VEVENT\n/m).slice(1);
  for (const chunk of events.slice(0, CALENDAR_LIMITS.holidaysPerSet)) {
    const body = chunk.split(/\nEND:VEVENT/)[0];
    const props = new Map<string, { params: string; value: string }>();
    for (const line of body.split("\n")) {
      const m = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
      if (m && !props.has(m[1].toUpperCase())) props.set(m[1].toUpperCase(), { params: m[2], value: m[3].trim() });
    }
    const summary = (props.get("SUMMARY")?.value ?? "")
      .replace(/\\n/gi, " ")
      .replace(/\\([,;\\])/g, "$1")
      .trim()
      .slice(0, CALENDAR_LIMITS.holidayName);
    const ds = props.get("DTSTART");
    const dm = ds ? /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z)?)?$/.exec(ds.value) : null;
    if (!dm || !summary) {
      skipped.push(summary ? `${summary}: no start date` : "An event with no name");
      continue;
    }
    const date = `${dm[1]}-${dm[2]}-${dm[3]}`;
    if (!validDate(date)) {
      skipped.push(`${summary}: bad date`);
      continue;
    }
    const rr = props.get("RRULE")?.value.toUpperCase() ?? "";
    let yearly = false;
    if (rr) {
      const parts = Object.fromEntries(rr.split(";").map((p) => p.split("=") as [string, string]));
      if (parts.FREQ === "YEARLY" && !parts.COUNT && !parts.UNTIL && (!parts.INTERVAL || parts.INTERVAL === "1") && !parts.BYDAY && !parts.BYWEEKNO && !parts.BYYEARDAY && !parts.BYSETPOS) yearly = true;
      else skipped.push(`${summary}: repeat rule not supported, imported ${date} only`);
    }
    let from: string | null = null;
    let to: string | null = null;
    let days = 1;
    const de = props.get("DTEND");
    const em = de ? /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z)?)?$/.exec(de.value) : null;
    if (dm[4] !== undefined) {
      if (!dm[6]) {
        from = `${dm[4]}:${dm[5]}`;
        if (em && em[4] !== undefined && `${em[1]}-${em[2]}-${em[3]}` === date) to = `${em[4]}:${em[5]}`;
        else to = null;
        if (from === "00:00") from = null;
      }
    } else if (em && em[4] === undefined) {
      const span = (Date.UTC(+em[1], +em[2] - 1, +em[3]) - Date.UTC(+dm[1], +dm[2] - 1, +dm[3])) / 86_400_000;
      days = Math.max(1, Math.min(31, Math.round(span)));
    }
    for (let k = 0; k < days; k++) {
      const t = new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3]) + k * 86_400_000);
      const d = t.toISOString().slice(0, 10);
      const v = validateHoliday({ date: d, name: summary, closed_from: from, closed_to: to, recurring_yearly: yearly });
      if (v.ok) holidays.push(v.value);
      else skipped.push(`${summary}: ${v.error}`);
    }
  }
  return { holidays, skipped };
}

// --- Words for instants ------------------------------------------------------------

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function dayNumber(t: number, tz: string): number {
  const w = wallClock(t, tz);
  return Math.floor(Date.UTC(w.y, w.m - 1, w.d) / 86_400_000);
}

/** "today 13:00", "tomorrow 09:00", "Mon 09:00" (this week), "Mon 4 Jan 09:00", in `tz`. */
export function formatWhen(t: number, tz: string, now = Date.now()): string {
  const w = wallClock(t, tz);
  const time = `${pad(w.h)}:${pad(w.min)}`;
  const days = dayNumber(t, tz) - dayNumber(now, tz);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const dow = DAY_SHORT[w.dow % 7];
  if (days > 1 && days < 7) return `${dow} ${time}`;
  const year = w.y !== wallClock(now, tz).y ? ` ${w.y}` : "";
  return `${dow} ${w.d} ${MONTH_SHORT[w.m - 1]}${year} ${time}`;
}

/** "Mon 9 Nov 09:00" (always with the date), in `tz`. */
export function formatStamp(t: number, tz: string): string {
  const w = wallClock(t, tz);
  return `${DAY_SHORT[w.dow % 7]} ${w.d} ${MONTH_SHORT[w.m - 1]} ${w.y} ${pad(w.h)}:${pad(w.min)}`;
}

/** "45m", "4h", "4h 30m", "2d" (a day being 24 hours of the clock). */
export function formatMinutes(m: number): string {
  const r = Math.round(m);
  if (r < 60) return `${r}m`;
  const h = Math.floor(r / 60);
  return r % 60 ? `${h}h ${r % 60}m` : `${h}h`;
}

/** "2 business hours", "30 minutes", "1 hour 30 minutes" for prose. */
export function targetPhrase(minutesTotal: number, business: boolean): string {
  const h = Math.floor(minutesTotal / 60);
  const m = minutesTotal % 60;
  const unit = (n: number, w: string) => `${n} ${business ? "business " : ""}${w}${n === 1 ? "" : "s"}`;
  if (!h) return unit(m, "minute");
  if (!m) return unit(h, "hour");
  return `${unit(h, "hour")} ${m} minute${m === 1 ? "" : "s"}`;
}

/** The holiday names that closed what would otherwise have been open hours in [a, b). */
export function closuresIn(a: number, b: number, hours: HdBusinessHours, cap = 4): string[] {
  const names: string[] = [];
  const w = wallClock(a, hours.timezone);
  let day = Date.UTC(w.y, w.m - 1, w.d);
  for (let i = 0; i < 400 && names.length < cap; i++, day += 86_400_000) {
    const t = new Date(day);
    const [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
    const opens = dayOpenIntervals(y, m, d, hours);
    if (!opens.length) {
      if (zonedInstant(y, m, d, 0, 0, hours.timezone) >= b) break;
      continue;
    }
    if (opens[0].a >= b) break;
    for (const c of dayClosures(y, m, d, hours)) {
      const hit = opens.some((o) => o.a < c.b && c.a < o.b && Math.max(o.a, c.a) < b && Math.min(o.b, c.b) > a);
      if (hit && !names.includes(c.name)) names.push(c.name);
    }
  }
  return names;
}

/**
 * What a due computed from `from` + `minutes` business minutes looks like:
 * the due, a one-line summary and the stretches counted (with the closures
 * skipped between them). Calendar-time targets (business = false) just add.
 */
export function explainDue(from: number, minutesTotal: number, hours: HdBusinessHours, business = true): Omit<HdDuePreview, "calendar" | "target"> {
  const tz = hours.timezone;
  if (!business) {
    const due = from + minutesTotal * 60_000;
    return { due: new Date(due).toISOString(), no_open_hours: false, summary: `Due ${formatStamp(due, tz)}: the target counts around the clock.`, lines: [], timezone: tz };
  }
  if (!hasOpenHours(hours)) {
    return { due: null, no_open_hours: true, summary: "No open hours: this calendar is closed every day, so the clock never runs.", lines: [], timezone: tz };
  }
  const due = addBusinessMinutes(from, minutesTotal, hours).getTime();
  if (due >= HD_NO_OPEN_HOURS_DUE) {
    return { due: null, no_open_hours: true, summary: "No open hours in the next three years (holidays cover every working day).", lines: [], timezone: tz };
  }
  const lines: string[] = [];
  let remaining = minutesTotal * 60_000;
  let prevEnd = from;
  let firstOpen: number | null = null;
  let firstClosures: string[] = [];
  let count = 0;
  for (const s of businessSegments(hours, from)) {
    if (s.a > prevEnd) {
      const names = closuresIn(prevEnd, s.a, hours);
      if (firstOpen === null) {
        firstClosures = names;
      }
      if (count > 0 || s.a - from > 60_000) {
        lines.push(`Closed until ${formatStamp(s.a, tz)}${names.length ? ` (${names.join(", ")})` : ""}`);
      }
    }
    if (firstOpen === null) firstOpen = s.a;
    const use = Math.min(remaining, s.b - s.a);
    const end = s.a + use;
    count++;
    if (count <= 8) {
      const w0 = wallClock(s.a, tz);
      const w1 = wallClock(end, tz);
      lines.push(`${formatStamp(s.a, tz)}–${pad(w1.h)}:${pad(w1.min)}${w0.d !== w1.d ? " (next day)" : ""}: ${formatMinutes(use / 60_000)} counted`);
    } else if (count === 9) lines.push("…");
    remaining -= use;
    prevEnd = s.b;
    if (remaining <= 0) break;
  }
  let summary = `Due ${formatStamp(due, tz)}`;
  if (firstOpen !== null && firstOpen > from + 60_000) {
    summary += ` · opens ${formatWhen(firstOpen, tz, from)}${firstClosures.length ? ` (${firstClosures.join(", ")} closed)` : ""}`;
  }
  return { due: new Date(due).toISOString(), no_open_hours: false, summary, lines, timezone: tz };
}

// --- The queue's clock note and the requester's open state ----------------------------

export interface ClockNoteFields {
  status: HdStatus;
  first_reply_due: string | null;
  resolve_due: string | null;
  first_replied_at: string | null;
  sla_paused_at: string | null;
}

/**
 * Why a running SLA clock is not moving right now: "Paused for Christmas
 * Day, resumes Mon 09:00", "Outside office hours, resumes tomorrow 09:00",
 * "No office hours: the clock doesn't run". Null when it is running (or
 * paused by status, or counts calendar time, or is already overdue).
 */
export function clockNoteWith(t: ClockNoteFields, hours: HdBusinessHours, now = Date.now(), business = true): string | null {
  if (!business) return null;
  if (!HD_OPEN_STATUSES.includes(t.status)) return null;
  if (t.sla_paused_at && HD_PAUSED_STATUSES.includes(t.status)) return null;
  const due = !t.first_replied_at && t.first_reply_due ? t.first_reply_due : t.resolve_due;
  if (!due) return null;
  const d = Date.parse(due);
  if (d >= HD_NO_OPEN_HOURS_DUE || !hasOpenHours(hours)) return "No office hours: the clock doesn't run";
  if (d <= now) return null;
  if (inBusinessHours(now, hours)) return null;
  const opens = nextOpening(now, hours);
  if (opens === null) return "No office hours: the clock doesn't run";
  const when = formatWhen(opens, hours.timezone, now);
  const closure = closureAt(now, hours);
  if (closure) return `Paused for ${closure.name}, resumes ${when}`;
  const names = closuresIn(now, opens, hours, 1);
  if (names.length) return `Paused for ${names[0]}, resumes ${when}`;
  return `Outside office hours, resumes ${when}`;
}

export interface HdTeamOpenState {
  open: boolean;
  /** ISO, when closed and an opening is coming. */
  opensAt?: string;
  /** ISO, when open. */
  closesAt?: string;
  /** The holiday it is closed for. */
  holidayName?: string;
  teamName: string;
  timezone: string;
  /** "The IT team is closed for Christmas Day. We'll reply from Mon 09:00." */
  message: string;
}

/** "The IT team", "The Support team", "The helpdesk". */
export function teamPhrase(name: string | null): string {
  if (!name) return "The helpdesk";
  return /\bteam$/i.test(name.trim()) ? `The ${name.trim()}` : `The ${name.trim()} team`;
}

export function openStateWith(hours: HdBusinessHours, teamName: string | null, now = Date.now()): HdTeamOpenState {
  const tz = hours.timezone;
  const who = teamPhrase(teamName);
  const base = { teamName: teamName ?? "Helpdesk", timezone: tz };
  if (inBusinessHours(now, hours)) {
    const c = closesAt(now, hours);
    return {
      ...base,
      open: true,
      ...(c ? { closesAt: new Date(c).toISOString() } : {}),
      message: c && c - now < 7 * 86_400_000 ? `${who} is open until ${formatWhen(c, tz, now)}.` : `${who} is open.`,
    };
  }
  const opens = nextOpening(now, hours);
  if (opens === null) return { ...base, open: false, message: `${who} has no office hours set, so replies may take a while.` };
  const when = formatWhen(opens, tz, now);
  const closure = closureAt(now, hours);
  const holiday = closure?.name ?? closuresIn(now, opens, hours, 1)[0];
  return {
    ...base,
    open: false,
    opensAt: new Date(opens).toISOString(),
    ...(holiday ? { holidayName: holiday } : {}),
    message: holiday ? `${who} is closed for ${holiday}. We'll reply from ${when}.` : `${who} is closed right now. We'll reply from ${when}.`,
  };
}

export function isPriorityKey(v: unknown): v is HdPriority {
  return typeof v === "string" && (HD_PRIORITIES as readonly string[]).includes(v);
}

// --- Calendar input ------------------------------------------------------------------

export function validTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface HdCalendarInput {
  name: string;
  timezone: string;
  schedule: HdWeekSchedule;
  holiday_set_ids: number[];
}

/** Validate POST / PATCH bodies for a calendar (`partial`: only what is sent). */
export function validateCalendarInput(
  raw: Record<string, unknown>,
  partial = false
): { ok: true; value: Partial<HdCalendarInput> } | { ok: false; error: string } {
  const out: Partial<HdCalendarInput> = {};
  if (raw.name !== undefined || !partial) {
    const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ") : "";
    if (!name) return { ok: false, error: "Name the calendar." };
    if (name.length > CALENDAR_LIMITS.name) return { ok: false, error: `Calendar names are up to ${CALENDAR_LIMITS.name} characters.` };
    out.name = name;
  }
  if (raw.timezone !== undefined || !partial) {
    const tz = typeof raw.timezone === "string" ? raw.timezone.trim() : "";
    if (!validTimeZone(tz)) return { ok: false, error: "Pick a time zone from the list (for example Europe/London)." };
    out.timezone = tz;
  }
  if (raw.schedule !== undefined || !partial) {
    const s = validateSchedule(raw.schedule);
    if (!s.ok) return s;
    out.schedule = s.value;
  }
  if (raw.holiday_set_ids !== undefined) {
    if (!Array.isArray(raw.holiday_set_ids) || raw.holiday_set_ids.length > CALENDAR_LIMITS.setsPerCalendar) {
      return { ok: false, error: `Attach up to ${CALENDAR_LIMITS.setsPerCalendar} holiday sets.` };
    }
    const ids = raw.holiday_set_ids.map(Number);
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return { ok: false, error: "Holiday sets are given by id." };
    out.holiday_set_ids = [...new Set(ids)];
  }
  return { ok: true, value: out };
}

/** Validate a holiday set's name / description. */
export function validateHolidaySetInput(
  raw: Record<string, unknown>,
  partial = false
): { ok: true; value: { name?: string; description?: string } } | { ok: false; error: string } {
  const out: { name?: string; description?: string } = {};
  if (raw.name !== undefined || !partial) {
    const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ") : "";
    if (!name) return { ok: false, error: "Name the holiday set." };
    if (name.length > CALENDAR_LIMITS.name) return { ok: false, error: `Names are up to ${CALENDAR_LIMITS.name} characters.` };
    out.name = name;
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string" || raw.description.length > CALENDAR_LIMITS.description) {
      return { ok: false, error: `Descriptions are up to ${CALENDAR_LIMITS.description} characters.` };
    }
    out.description = raw.description.trim();
  }
  return { ok: true, value: out };
}
