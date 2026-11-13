// Helpdesk 1.20.6: the desk's event calendar, the shapes and checks the
// server and the desk share. Pure: safe in client components.
//
// A ticket can carry one event: a start and an end (or whole days), a place
// and a setup lead time ("ready by" so many minutes before the start).
// Events show on the desk's Calendar page (/desk/calendar), and an event
// ticket cannot be solved until its setup is marked complete.
//
// Names: this is the "Calendar" of events. The business-hours "Calendars"
// (lib/helpdesk/calendars) are a different thing and keep their name.
//
// Time: instants are UTC everywhere. A timed event is two instants and is
// drawn in the viewer's time zone (the workspace's, or the person's own).
// An all-day event is calendar days ("2026-11-20" to "2026-11-21",
// inclusive): they never shift with the viewer's zone. Its instants (used
// for "ready by", reminders and overlap) are those days' midnights in the
// zone the event was entered in, found with the zone's own rules, so a day
// with a clock change is 23 or 25 hours long, as it really is.

import { wallClock } from "./sla";
import type { HdFormField } from "./types";

export const EVENT_LIMITS = {
  place: 200,
  /** The longest setup lead time: a week. */
  setupMinutes: 7 * 24 * 60,
  /** The longest event: 31 days. */
  maxDays: 31,
  /** Reminder lead times an admin may list. */
  reminderLeads: 5,
  /** The longest reminder lead time: 14 days. */
  reminderMinutes: 14 * 24 * 60,
  /** Calendar ranges: at most this many days in one read. */
  rangeDays: 45,
} as const;

const MIN = 60_000;
const DAY_MS = 86_400_000;

// --- Shapes -----------------------------------------------------------------------

export type HdEventSource = "agent" | "request" | "invite" | "api";

/** A ticket's event as the desk, the API, webhooks and the Claude connector read it. */
export interface HdTicketEvent {
  /** ISO instants (UTC). */
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  /** All-day only: the first and last calendar day, "YYYY-MM-DD", inclusive. */
  start_date: string | null;
  end_date: string | null;
  /** The zone the event was entered in (all-day events count their days in it). */
  timezone: string;
  place: string;
  setup_minutes: number;
  /** starts_at minus the setup lead time. */
  ready_at: string;
  setup_complete: boolean;
  setup_completed_at: string | null;
  setup_completed_by: string | null;
  cancelled: boolean;
  cancelled_at: string | null;
  source: HdEventSource;
  /** From a repeating meeting invite: only its first date is on the calendar. */
  repeats: boolean;
}

/** Another event at the same place whose time overlaps. */
export interface HdEventConflict {
  /** Null when the viewer may not see that ticket: only its team and time are told. */
  number: number | null;
  subject: string | null;
  team_name: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
  place: string;
}

/** GET /api/helpdesk/tickets/[number]/event. */
export interface HdTicketEventView {
  event: HdTicketEvent | null;
  conflicts: HdEventConflict[];
  /** The viewer may add, change and remove the event and mark its setup. */
  can_edit: boolean;
  /** Minutes offered when an event is added by hand. */
  default_setup_minutes: number;
}

/** What a caller sends to set or change an event. Left-out fields keep what the ticket has. */
export interface HdEventInput {
  starts_at?: string;
  ends_at?: string;
  all_day?: boolean;
  start_date?: string;
  end_date?: string;
  timezone?: string;
  place?: string;
  setup_minutes?: number;
}

/** The checked times of an event. */
export interface HdEventTimes {
  starts_at: Date;
  ends_at: Date;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
  timezone: string;
  place: string;
  setup_minutes: number;
}

/** A request type's "Goes on the calendar" (hd_request_types.calendar). */
export interface HdRequestTypeCalendar {
  enabled: boolean;
  /** The form field holding the start: a "Date and time" field, or a "Date" field for whole days. */
  start_field: string;
  /** The end (the same kind as the start); '' = one hour, or the one day. */
  end_field: string;
  /** The place: a short answer or a pick-one field; '' = none. */
  place_field: string;
  /** The default setup lead time, in minutes. */
  lead_minutes: number;
}

export const REQUEST_TYPE_CALENDAR_OFF: HdRequestTypeCalendar = { enabled: false, start_field: "", end_field: "", place_field: "", lead_minutes: 30 };

/** Desk settings → Event calendar (the settings key `helpdesk_calendar`). */
export interface HdCalendarSettings {
  /** Reminders this long before "ready by", in minutes, longest first. Empty: none. */
  reminder_minutes: number[];
  /** Remind once the event has started and setup is still not complete. */
  late_reminder: boolean;
  /** owner_else_team: the ticket's owner, or its team when nobody owns it. owner_and_team: both. */
  recipients: "owner_else_team" | "owner_and_team";
  /** Also message agents in Microsoft Teams or Slack, where one is connected and knows them. */
  chat: boolean;
  /** The lead time offered when an agent adds an event by hand. */
  default_setup_minutes: number;
}

export const CALENDAR_SETTINGS_DEFAULTS: HdCalendarSettings = {
  reminder_minutes: [1440, 60],
  late_reminder: true,
  recipients: "owner_else_team",
  chat: false,
  default_setup_minutes: 30,
};

// --- The Calendar page --------------------------------------------------------------

export type HdCalendarView = "day" | "week" | "month";
export const HD_CALENDAR_VIEWS: readonly HdCalendarView[] = ["day", "week", "month"];
export type HdCalendarColour = "team" | "status";
export type HdCalendarLayer = "due" | "recurring";

/** What a person last chose on the Calendar page (hd_calendar_prefs). */
export interface HdCalendarPrefs {
  view: HdCalendarView;
  /** 0 = every team the person works. */
  team_id: number;
  colour: HdCalendarColour;
  layers: HdCalendarLayer[];
}

export const CALENDAR_PREFS_DEFAULTS: HdCalendarPrefs = { view: "week", team_id: 0, colour: "team", layers: [] };

export function resolveCalendarPrefs(raw: unknown): HdCalendarPrefs {
  const v = isObj(raw) ? raw : {};
  const layers = Array.isArray(v.layers) ? (["due", "recurring"] as const).filter((l) => (v.layers as unknown[]).includes(l)) : [];
  return {
    view: HD_CALENDAR_VIEWS.includes(v.view as HdCalendarView) ? (v.view as HdCalendarView) : CALENDAR_PREFS_DEFAULTS.view,
    team_id: Number.isInteger(v.team_id) && (v.team_id as number) > 0 ? (v.team_id as number) : 0,
    colour: v.colour === "status" ? "status" : "team",
    layers,
  };
}

/** One event on the Calendar page. */
export interface HdCalendarEvent {
  number: number;
  subject: string;
  status: string;
  status_label: string;
  team_id: number | null;
  team_name: string | null;
  assignee_name: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
  place: string;
  setup_minutes: number;
  ready_at: string;
  setup_complete: boolean;
  cancelled: boolean;
  repeats: boolean;
  /** Ticket numbers of the events it overlaps at the same place (null: one the viewer may not see). */
  conflicts: (number | null)[];
}

/** A ticket's due time (the Due dates layer). */
export interface HdCalendarDue {
  number: number;
  subject: string;
  at: string;
  kind: "first_reply" | "resolve";
  team_id: number | null;
  team_name: string | null;
  assignee_name: string | null;
  overdue: boolean;
}

/** A ticket a recurring schedule will open (the Recurring tickets layer). */
export interface HdCalendarRecurring {
  recurring_id: number;
  title: string;
  at: string;
  team_id: number;
  team_name: string;
  /** "moved from Mon May 25, Spring bank holiday", or ''. */
  note: string;
}

/** GET /api/helpdesk/calendar. */
export interface HdCalendarData {
  /** The zone the range was cut in: the viewer's. */
  timezone: string;
  /** "YYYY-MM-DD", inclusive. */
  from: string;
  to: string;
  events: HdCalendarEvent[];
  due: HdCalendarDue[];
  recurring: HdCalendarRecurring[];
  /** The teams the viewer may filter by. */
  teams: { id: number; name: string }[];
  /** More than the page shows were found (a very busy range). */
  truncated: boolean;
}

/** A feed link as its row shows it (never the token). */
export interface HdCalendarFeedView {
  id: number;
  owner_id: number;
  owner_name: string;
  /** Null: every team the owner works. */
  team_id: number | null;
  team_name: string | null;
  hint: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  mine: boolean;
}

export const HD_CALENDAR_FEED_PREFIX = "cdf_";

// --- Small helpers ------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pad = (n: number) => String(n).padStart(2, "0");
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** What two places are compared by: trimmed, single-spaced, lower-cased. */
export function placeKey(place: string): string {
  return place.trim().replace(/\s+/g, " ").toLowerCase();
}

export function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A real calendar date "YYYY-MM-DD" → its parts; null otherwise. */
export function parseDay(s: unknown): { y: number; m: number; d: number } | null {
  if (typeof s !== "string") return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && y >= 1970 && y <= 2200 ? { y, m: mo, d } : null;
}

export function dayKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** The calendar day `n` days after `day` (pure Gregorian arithmetic, no zone). */
export function addDays(day: string, n: number): string {
  const p = parseDay(day);
  if (!p) return day;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + n * DAY_MS);
  return dayKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  const pa = parseDay(a);
  const pb = parseDay(b);
  if (!pa || !pb) return 0;
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

/** ISO weekday of a calendar day: 1 = Monday … 7 = Sunday. */
export function weekdayOf(day: string): number {
  const p = parseDay(day);
  if (!p) return 1;
  const w = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** The zone's offset from UTC at an instant, in ms (wall clock minus UTC). */
function zoneOffset(t: number, tz: string): number {
  const w = wallClock(t, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(t / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `tz` reads y-m-d h:min, exact around
 * clock changes, as iCalendar (RFC 5545) reads local times:
 *   - a time that happens twice (the clocks go back) is the first of the two;
 *   - a time that never happens (the clocks go forward) is read with the
 *     offset from before the change, so it lands that long after the change
 *     (01:30 on a night the clocks jump from 01:00 to 02:00 is 02:30).
 * The offsets a day before and a day after bracket any single change.
 */
export function wallInstant(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, h, min);
  const before = zoneOffset(wall - DAY_MS, tz);
  const after = zoneOffset(wall + DAY_MS, tz);
  const reads = (t: number) => zoneOffset(t, tz) === wall - t;
  const a = wall - before;
  const b = wall - after;
  const okA = reads(a);
  const okB = reads(b);
  if (okA && okB) return Math.min(a, b);
  if (okA) return a;
  if (okB) return b;
  return a;
}

/** The instant a calendar day starts in `tz` (its local midnight; where a clock change skips midnight, the first instant of the day). */
export function dayStart(day: string, tz: string): number {
  const p = parseDay(day)!;
  return wallInstant(p.y, p.m, p.d, 0, 0, tz);
}

/** The calendar day an instant falls on in `tz`. */
export function dayOf(t: number | string | Date, tz: string): string {
  const ms = typeof t === "number" ? t : new Date(t).getTime();
  const w = wallClock(ms, tz);
  return dayKey(w.y, w.m, w.d);
}

/** Minutes since local midnight at an instant, by the wall clock in `tz`. */
export function wallMinutes(t: number, tz: string): number {
  const w = wallClock(t, tz);
  return w.h * 60 + w.min;
}

/**
 * A wall-clock time ("2026-11-20T14:00", as a datetime-local input gives it)
 * read in `tz` → the instant. A time a clock change skips is read with the
 * offset from before the change, so 01:30 on the night the clocks go forward
 * at 01:00 is 02:30 after it; a time that happens twice is the first of the
 * two (both as iCalendar reads them). Null when it isn't a real date and time.
 */
export function wallToInstant(local: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(local.trim());
  if (!m) return null;
  const day = parseDay(`${m[1]}-${m[2]}-${m[3]}`);
  const h = Number(m[4]);
  const min = Number(m[5]);
  if (!day || h > 23 || min > 59) return null;
  return wallInstant(day.y, day.m, day.d, h, min, tz);
}

/** An instant as a datetime-local value in `tz`. */
export function instantToWall(t: number | string, tz: string): string {
  const ms = typeof t === "number" ? t : new Date(t).getTime();
  const w = wallClock(ms, tz);
  return `${dayKey(w.y, w.m, w.d)}T${pad(w.h)}:${pad(w.min)}`;
}

/** The instants of an all-day event: local midnight of its first day to local midnight after its last. */
export function allDayInstants(startDate: string, endDate: string, tz: string): { starts_at: number; ends_at: number } {
  return { starts_at: dayStart(startDate, tz), ends_at: dayStart(addDays(endDate, 1), tz) };
}

// --- Words --------------------------------------------------------------------------

/** "30 minutes", "1 hour", "1 hour 30 minutes", "1 day", "2 days". */
export function leadLabel(minutes: number): string {
  if (minutes <= 0) return "no setup time";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} ${d === 1 ? "day" : "days"}`);
  if (h) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
  if (m) parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
  return parts.join(" ");
}

const WD = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WD_LONG = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_LONG = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const weekdayShort = (day: string) => WD[weekdayOf(day)];
export const weekdayLong = (day: string) => WD_LONG[weekdayOf(day)];
export const monthLong = (m: number) => MON_LONG[m] ?? "";

/** "Fri 20 Nov 2026" for a calendar day. */
export function dayLabel(day: string, opts: { year?: boolean; long?: boolean } = {}): string {
  const p = parseDay(day);
  if (!p) return day;
  const wd = opts.long ? WD_LONG[weekdayOf(day)] : WD[weekdayOf(day)];
  const mo = opts.long ? MON_LONG[p.m] : MON[p.m];
  return `${wd} ${p.d} ${mo}${opts.year === false ? "" : ` ${p.y}`}`;
}

/** "14:00" or "2:00 PM" for an instant in `tz`. */
export function timeLabel(t: number | string, tz: string, hour12 = false): string {
  const ms = typeof t === "number" ? t : new Date(t).getTime();
  const w = wallClock(ms, tz);
  if (!hour12) return `${pad(w.h)}:${pad(w.min)}`;
  const h = w.h % 12 === 0 ? 12 : w.h % 12;
  return `${h}:${pad(w.min)} ${w.h < 12 ? "AM" : "PM"}`;
}

/** "London time" for "Europe/London"; "UTC" stays. */
export function zoneLabel(tz: string): string {
  if (tz === "UTC" || tz === "Etc/UTC") return "UTC";
  const city = tz.split("/").pop() ?? tz;
  return `${city.replace(/_/g, " ")} time`;
}

type WhenFields = Pick<HdTicketEvent, "starts_at" | "ends_at" | "all_day" | "start_date" | "end_date">;

/**
 * When an event is, in words: "Fri 20 Nov 2026, 14:00 to 15:30", "Fri 20 Nov
 * 2026, 22:00 to Sat 21 Nov, 01:00", "Fri 20 Nov 2026, all day", "Fri 20 to
 * Sun 22 Nov 2026, all day". Timed events are read in `tz`; whole days are
 * the days themselves.
 */
export function eventWhen(e: WhenFields, tz: string, hour12 = false): string {
  if (e.all_day && e.start_date && e.end_date) {
    if (e.start_date === e.end_date) return `${dayLabel(e.start_date)}, all day`;
    const a = parseDay(e.start_date)!;
    const b = parseDay(e.end_date)!;
    const first = a.y === b.y ? (a.m === b.m ? `${WD[weekdayOf(e.start_date)]} ${a.d}` : dayLabel(e.start_date, { year: false })) : dayLabel(e.start_date);
    return `${first} to ${dayLabel(e.end_date)}, all day`;
  }
  const s = new Date(e.starts_at).getTime();
  const en = new Date(e.ends_at).getTime();
  const d1 = dayOf(s, tz);
  const d2 = dayOf(en, tz);
  if (d1 === d2) return `${dayLabel(d1)}, ${timeLabel(s, tz, hour12)} to ${timeLabel(en, tz, hour12)}`;
  return `${dayLabel(d1)}, ${timeLabel(s, tz, hour12)} to ${dayLabel(d2, { year: false })}, ${timeLabel(en, tz, hour12)}`;
}

/** "13:30" on the event's own day, else "Thu 19 Nov, 13:30": when setup must be ready. */
export function readyByLabel(e: Pick<HdTicketEvent, "starts_at" | "ready_at">, tz: string, hour12 = false): string {
  const r = new Date(e.ready_at).getTime();
  const s = new Date(e.starts_at).getTime();
  const sameDay = dayOf(r, tz) === dayOf(s, tz);
  return sameDay ? timeLabel(r, tz, hour12) : `${dayLabel(dayOf(r, tz), { year: false })}, ${timeLabel(r, tz, hour12)}`;
}

// --- Checks -------------------------------------------------------------------------

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function instantOf(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  // An instant must say its zone: "2026-11-20T14:00:00Z" or "…+01:00".
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

const Y_MIN = Date.UTC(2000, 0, 1);
const Y_MAX = Date.UTC(2100, 0, 1);

/**
 * Check what a caller sent for an event and lay it over what the ticket has
 * (`base`). `zone` is the zone to count whole days in when the caller names
 * none. Times are instants with their zone ("2026-11-20T14:00:00Z" or with
 * an offset); whole days are dates.
 */
export function checkEventInput(raw: unknown, base: HdEventTimes | null, zone: string): Checked<HdEventTimes> {
  if (!isObj(raw)) return { ok: false, error: "Send the event as { starts_at, ends_at, place, setup_minutes }, or { all_day: true, start_date, end_date }." };
  const has = (k: string) => raw[k] !== undefined && raw[k] !== null;
  let place = base?.place ?? "";
  if (raw.place !== undefined) {
    if (raw.place !== null && typeof raw.place !== "string") return { ok: false, error: "The place is text." };
    place = String(raw.place ?? "").trim().replace(/\s+/g, " ");
    if (place.length > EVENT_LIMITS.place) return { ok: false, error: `Keep the place under ${EVENT_LIMITS.place} characters.` };
  }
  let setup = base?.setup_minutes ?? 0;
  if (has("setup_minutes")) {
    const n = Number(raw.setup_minutes);
    if (!Number.isInteger(n) || n < 0 || n > EVENT_LIMITS.setupMinutes) return { ok: false, error: `The setup time is 0 to ${EVENT_LIMITS.setupMinutes} minutes (a week).` };
    setup = n;
  }
  if (raw.all_day !== undefined && typeof raw.all_day !== "boolean") return { ok: false, error: "all_day is true or false." };
  if (raw.timezone !== undefined && raw.timezone !== null && !validZone(raw.timezone)) return { ok: false, error: "That time zone isn't one we know. Use a name like Europe/London." };
  const allDay = raw.all_day !== undefined ? raw.all_day === true : (has("start_date") && !has("starts_at")) || (!has("starts_at") && !has("ends_at") && (base?.all_day ?? false));

  if (allDay) {
    const tz = validZone(raw.timezone) ? raw.timezone : base?.all_day ? base.timezone : zone;
    const startDate = has("start_date") ? raw.start_date : base?.all_day ? base.start_date : undefined;
    if (!parseDay(startDate)) return { ok: false, error: "Give the day the event is on, like 2026-11-20." };
    const endDate = has("end_date") ? raw.end_date : has("start_date") ? startDate : base?.all_day ? base.end_date : startDate;
    if (!parseDay(endDate)) return { ok: false, error: "The last day isn't a date." };
    const span = daysBetween(startDate as string, endDate as string);
    if (span < 0) return { ok: false, error: "The last day is before the first." };
    if (span >= EVENT_LIMITS.maxDays) return { ok: false, error: `An event is at most ${EVENT_LIMITS.maxDays} days long.` };
    const t = allDayInstants(startDate as string, endDate as string, tz);
    if (t.starts_at < Y_MIN || t.ends_at > Y_MAX) return { ok: false, error: "That date is out of range." };
    return { ok: true, value: { starts_at: new Date(t.starts_at), ends_at: new Date(t.ends_at), all_day: true, start_date: startDate as string, end_date: endDate as string, timezone: tz, place, setup_minutes: setup } };
  }

  const baseTimed = base && !base.all_day ? base : null;
  let start: number | null = baseTimed ? baseTimed.starts_at.getTime() : null;
  if (has("starts_at")) {
    start = instantOf(raw.starts_at);
    if (start === null) return { ok: false, error: "The start is a date and time with its zone, like 2026-11-20T14:00:00Z." };
  }
  if (start === null) return { ok: false, error: "Say when the event starts." };
  let end: number | null = null;
  if (has("ends_at")) {
    end = instantOf(raw.ends_at);
    if (end === null) return { ok: false, error: "The end is a date and time with its zone, like 2026-11-20T15:00:00Z." };
  } else if (baseTimed) {
    // A moved start keeps the event's length.
    end = start + (baseTimed.ends_at.getTime() - baseTimed.starts_at.getTime());
  } else end = start + 60 * MIN;
  if (end <= start) return { ok: false, error: "The end must be after the start." };
  if (end - start > EVENT_LIMITS.maxDays * DAY_MS) return { ok: false, error: `An event is at most ${EVENT_LIMITS.maxDays} days long.` };
  if (start < Y_MIN || end > Y_MAX) return { ok: false, error: "That date is out of range." };
  const tz = validZone(raw.timezone) ? raw.timezone : base?.timezone && validZone(base.timezone) ? base.timezone : zone;
  return { ok: true, value: { starts_at: new Date(start), ends_at: new Date(end), all_day: false, start_date: null, end_date: null, timezone: tz, place, setup_minutes: setup } };
}

/** The request form fields that can hold an event's start and end, and its place. */
export function calendarFieldChoices(form: HdFormField[]): { when: HdFormField[]; place: HdFormField[] } {
  return {
    when: form.filter((f) => f.type === "datetime" || f.type === "date"),
    place: form.filter((f) => f.type === "text" || f.type === "select" || f.type === "choice"),
  };
}

/** A stored or sent "Goes on the calendar" value read whole: anything missing is the default (off). Never throws. */
export function resolveRequestTypeCalendar(raw: unknown): HdRequestTypeCalendar {
  const v = isObj(raw) ? raw : {};
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  const lead = Number(v.lead_minutes);
  return {
    enabled: v.enabled === true,
    start_field: s(v.start_field),
    end_field: s(v.end_field),
    place_field: s(v.place_field),
    lead_minutes: Number.isInteger(lead) && lead >= 0 && lead <= EVENT_LIMITS.setupMinutes ? lead : REQUEST_TYPE_CALENDAR_OFF.lead_minutes,
  };
}

/** Check "Goes on the calendar" against the form it reads from. */
export function checkRequestTypeCalendar(raw: unknown, form: HdFormField[]): Checked<HdRequestTypeCalendar> {
  if (raw === undefined || raw === null) return { ok: true, value: { ...REQUEST_TYPE_CALENDAR_OFF } };
  if (!isObj(raw)) return { ok: false, error: "Send the calendar settings as { enabled, start_field, end_field, place_field, lead_minutes }." };
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return { ok: false, error: "Goes on the calendar is on or off." };
  const lead = raw.lead_minutes === undefined || raw.lead_minutes === null || raw.lead_minutes === "" ? REQUEST_TYPE_CALENDAR_OFF.lead_minutes : Number(raw.lead_minutes);
  if (!Number.isInteger(lead) || lead < 0 || lead > EVENT_LIMITS.setupMinutes) return { ok: false, error: `The setup time is 0 to ${EVENT_LIMITS.setupMinutes} minutes (a week).` };
  const v = resolveRequestTypeCalendar({ ...raw, lead_minutes: lead });
  const { when, place } = calendarFieldChoices(form);
  if (!v.enabled) {
    // Switched off: the choices are kept while the fields still exist, so switching it back on is one click.
    return {
      ok: true,
      value: {
        enabled: false,
        start_field: when.some((f) => f.key === v.start_field) ? v.start_field : "",
        end_field: when.some((f) => f.key === v.end_field) ? v.end_field : "",
        place_field: place.some((f) => f.key === v.place_field) ? v.place_field : "",
        lead_minutes: lead,
      },
    };
  }
  const start = when.find((f) => f.key === v.start_field);
  if (!start) return { ok: false, error: 'To put requests on the calendar, choose the question that holds the start. Add a "Date and time" question (or a "Date" question for whole days) first.' };
  if (v.end_field) {
    const end = when.find((f) => f.key === v.end_field);
    if (!end) return { ok: false, error: "The question chosen for the end is no longer a date on the form." };
    if (end.type !== start.type) return { ok: false, error: "The start and the end must be the same kind of question: both a date and time, or both a date." };
    if (end.key === start.key) return { ok: false, error: "Choose a different question for the end, or leave it out." };
  }
  if (v.place_field && !place.some((f) => f.key === v.place_field)) return { ok: false, error: "The question chosen for the place is no longer a short answer or a pick-one question." };
  return { ok: true, value: { ...v, lead_minutes: lead } };
}

/** Read stored calendar settings; anything missing or odd is the default. Never throws. */
export function resolveCalendarSettings(raw: unknown): HdCalendarSettings {
  const v = isObj(raw) ? raw : {};
  const d = CALENDAR_SETTINGS_DEFAULTS;
  const leads = Array.isArray(v.reminder_minutes) ? cleanLeads(v.reminder_minutes) : null;
  const setup = Number(v.default_setup_minutes);
  return {
    reminder_minutes: leads ?? [...d.reminder_minutes],
    late_reminder: typeof v.late_reminder === "boolean" ? v.late_reminder : d.late_reminder,
    recipients: v.recipients === "owner_and_team" ? "owner_and_team" : "owner_else_team",
    chat: v.chat === true,
    default_setup_minutes: Number.isInteger(setup) && setup >= 0 && setup <= EVENT_LIMITS.setupMinutes ? setup : d.default_setup_minutes,
  };
}

function cleanLeads(raw: unknown[]): number[] | null {
  const out: number[] = [];
  for (const x of raw) {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1 || n > EVENT_LIMITS.reminderMinutes) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out.length > EVENT_LIMITS.reminderLeads ? null : out.sort((a, b) => b - a);
}

/** Check a settings body (PUT /api/helpdesk/admin/calendar), laid over what is stored. */
export function checkCalendarSettings(raw: unknown, base: HdCalendarSettings): Checked<HdCalendarSettings> {
  if (!isObj(raw)) return { ok: false, error: "Send the settings as JSON." };
  const out = { ...base };
  if (raw.reminder_minutes !== undefined) {
    if (!Array.isArray(raw.reminder_minutes)) return { ok: false, error: "The reminder times are a list of minutes." };
    if (raw.reminder_minutes.length > EVENT_LIMITS.reminderLeads) return { ok: false, error: `Up to ${EVENT_LIMITS.reminderLeads} reminder times.` };
    const leads = cleanLeads(raw.reminder_minutes);
    if (!leads) return { ok: false, error: `A reminder time is 1 minute to ${EVENT_LIMITS.reminderMinutes / 1440} days before.` };
    out.reminder_minutes = leads;
  }
  if (raw.late_reminder !== undefined) {
    if (typeof raw.late_reminder !== "boolean") return { ok: false, error: "The late reminder is on or off." };
    out.late_reminder = raw.late_reminder;
  }
  if (raw.recipients !== undefined) {
    if (raw.recipients !== "owner_else_team" && raw.recipients !== "owner_and_team") return { ok: false, error: "Choose who gets the reminders." };
    out.recipients = raw.recipients;
  }
  if (raw.chat !== undefined) {
    if (typeof raw.chat !== "boolean") return { ok: false, error: "The chat app choice is on or off." };
    out.chat = raw.chat;
  }
  if (raw.default_setup_minutes !== undefined) {
    const n = Number(raw.default_setup_minutes);
    if (!Number.isInteger(n) || n < 0 || n > EVENT_LIMITS.setupMinutes) return { ok: false, error: `The setup time is 0 to ${EVENT_LIMITS.setupMinutes} minutes (a week).` };
    out.default_setup_minutes = n;
  }
  return { ok: true, value: out };
}

// --- "Before you solve" --------------------------------------------------------------

/** How the unmet setup reads in the refusal sentence ("Before you solve, this ticket needs: the event setup marked complete."). */
export const EVENT_SETUP_LABEL = "The event setup marked complete";

// --- The grid -----------------------------------------------------------------------

/** The days a view shows around `day`: the day, its Monday-to-Sunday week, or the whole weeks that hold its month. */
export function viewRange(view: HdCalendarView, day: string): { from: string; to: string; days: string[] } {
  let from = day;
  let to = day;
  if (view === "week") {
    from = addDays(day, 1 - weekdayOf(day));
    to = addDays(from, 6);
  } else if (view === "month") {
    const p = parseDay(day)!;
    const first = dayKey(p.y, p.m, 1);
    const last = dayKey(p.y, p.m, new Date(Date.UTC(p.y, p.m, 0)).getUTCDate());
    from = addDays(first, 1 - weekdayOf(first));
    to = addDays(last, 7 - weekdayOf(last));
  }
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 50; d = addDays(d, 1)) days.push(d);
  return { from, to, days };
}

/** The day a view moves to with Previous (-1) or Next (+1). */
export function stepDay(view: HdCalendarView, day: string, dir: -1 | 1): string {
  if (view === "day") return addDays(day, dir);
  if (view === "week") return addDays(day, 7 * dir);
  const p = parseDay(day)!;
  const t = new Date(Date.UTC(p.y, p.m - 1 + dir, 1));
  return dayKey(t.getUTCFullYear(), t.getUTCMonth() + 1, 1);
}

/** "Fri 20 Nov 2026", "16 to 22 Nov 2026", "November 2026": the range in the toolbar. */
export function viewTitle(view: HdCalendarView, day: string): string {
  const p = parseDay(day)!;
  if (view === "day") return dayLabel(day, { long: true });
  if (view === "month") return `${MON_LONG[p.m]} ${p.y}`;
  const { from, to } = viewRange("week", day);
  const a = parseDay(from)!;
  const b = parseDay(to)!;
  if (a.y !== b.y) return `${a.d} ${MON[a.m]} ${a.y} to ${b.d} ${MON[b.m]} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${MON[a.m]} to ${b.d} ${MON[b.m]} ${b.y}`;
  return `${a.d} to ${b.d} ${MON[b.m]} ${b.y}`;
}

/** Does the event touch this calendar day (in `tz` for a timed one)? Its setup block counts with `withSetup`. */
export function eventOnDay(e: Pick<HdCalendarEvent, "starts_at" | "ends_at" | "ready_at" | "all_day" | "start_date" | "end_date">, day: string, tz: string, withSetup = false): boolean {
  if (e.all_day && e.start_date && e.end_date) {
    if (day >= e.start_date && day <= e.end_date) return true;
    if (!withSetup) return false;
  }
  const a = dayStart(day, tz);
  const b = dayStart(addDays(day, 1), tz);
  const s = new Date(withSetup ? e.ready_at : e.starts_at).getTime();
  const en = new Date(e.ends_at).getTime();
  // An event that ends exactly at midnight does not touch the next day.
  return s < b && en > a;
}

/** A block in a day's time grid: minutes from the top by the wall clock, 0 to 1440. */
export interface DaySegment {
  top: number;
  bottom: number;
  /** The block starts before this day / ends after it. */
  before: boolean;
  after: boolean;
}

/** The part of [from, to) that falls on `day` in `tz`, in wall-clock minutes; null when none does. */
export function daySegment(from: number, to: number, day: string, tz: string): DaySegment | null {
  const a = dayStart(day, tz);
  const b = dayStart(addDays(day, 1), tz);
  if (to <= a || from >= b || to <= from) return null;
  const top = from <= a ? 0 : wallMinutes(from, tz);
  const bottom = to >= b ? 1440 : wallMinutes(to, tz);
  // On the night the clocks go back the wall clock repeats an hour, so a block can read as ending before it starts.
  return { top, bottom: Math.max(bottom, top + 1), before: from < a, after: to > b };
}

/** Side-by-side columns for blocks that overlap in a day: each block's column and how many its cluster has. */
export function layoutColumns<T extends { top: number; bottom: number }>(blocks: T[]): (T & { col: number; cols: number })[] {
  const sorted = blocks.map((b, i) => ({ b, i })).sort((x, y) => x.b.top - y.b.top || y.b.bottom - x.b.bottom || x.i - y.i);
  const out: (T & { col: number; cols: number })[] = [];
  let cluster: (T & { col: number; cols: number })[] = [];
  let clusterEnd = -1;
  let colEnds: number[] = [];
  const flush = () => {
    for (const c of cluster) c.cols = colEnds.length;
    out.push(...cluster);
    cluster = [];
    colEnds = [];
  };
  for (const { b } of sorted) {
    if (cluster.length && b.top >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= b.top);
    if (col < 0) {
      col = colEnds.length;
      colEnds.push(b.bottom);
    } else colEnds[col] = b.bottom;
    cluster.push({ ...b, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, b.bottom);
  }
  flush();
  return out;
}
