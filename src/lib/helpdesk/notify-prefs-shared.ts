// Helpdesk 1.19.0: an agent's notification preferences, as data and pure
// functions. The desk's Notifications page (client) and lib/helpdesk/
// notify-prefs (server) share this module, so the matrix the agent sees and
// the rules the server applies cannot drift. No server imports here.
//
// The stored shape (hd_notify_prefs.prefs, jsonb) holds only what the agent
// changed; `resolvePrefs()` lays it over the defaults, so a new event or
// option added later reaches everyone with its default.

/** The agent-facing events, in the order the matrix shows them. */
export const HD_NOTIFY_EVENTS = [
  "assigned_to_me",
  "new_in_my_teams",
  "requester_replied",
  "mention_or_note",
  "approval_needed",
  "task_assigned",
  "workflow_blocked",
  "reopened",
  "review_requested",
  "review_returned",
  "sla_warning",
  "sla_breach",
] as const;
export type HdNotifyEvent = (typeof HD_NOTIFY_EVENTS)[number];
/** The same list under the name the workspace notification policy (lib/notify-policy) imports. */
export const AGENT_NOTIFY_EVENTS = HD_NOTIFY_EVENTS;

export const HD_NOTIFY_CHANNELS = ["push", "email", "bell"] as const;
export type HdNotifyChannel = (typeof HD_NOTIFY_CHANNELS)[number];

export const HD_CHANNEL_LABEL: Record<HdNotifyChannel, string> = {
  push: "Push",
  email: "Email",
  bell: "Bell",
};

export interface HdNotifyEventInfo {
  label: string;
  hint: string;
  /** Whether an email exists for this event (the matrix shows a dash otherwise). */
  email: boolean;
  /** The default per channel. */
  defaults: Record<HdNotifyChannel, boolean>;
}

export const HD_NOTIFY_EVENT_INFO: Record<HdNotifyEvent, HdNotifyEventInfo> = {
  assigned_to_me: {
    label: "Assigned to me",
    hint: "A ticket is assigned to you",
    email: true,
    defaults: { push: true, email: true, bell: true },
  },
  new_in_my_teams: {
    label: "New in my teams",
    hint: "A new ticket arrives in a team you belong to (choose the teams below)",
    email: true,
    defaults: { push: true, email: false, bell: true },
  },
  requester_replied: {
    label: "Requester replied",
    hint: "The requester answers on a ticket assigned to you",
    email: true,
    defaults: { push: true, email: true, bell: true },
  },
  mention_or_note: {
    label: "Mentions and notes",
    hint: "Someone adds an internal note to your ticket, or a workflow step messages you",
    email: true,
    defaults: { push: true, email: true, bell: true },
  },
  approval_needed: {
    label: "Approval needed",
    hint: "A request waits for your approval",
    email: true,
    defaults: { push: true, email: true, bell: true },
  },
  task_assigned: {
    label: "Workflow task",
    hint: "A workflow task is handed to you or your team",
    email: true,
    defaults: { push: true, email: true, bell: true },
  },
  workflow_blocked: {
    label: "Workflow stopped",
    hint: "A team couldn't do its task, so the request came back to your team",
    email: true,
    defaults: { push: true, email: true, bell: true },
  },
  reopened: {
    label: "Reopened",
    hint: "A requester answers on a solved ticket and it opens again",
    email: true,
    defaults: { push: true, email: true, bell: true },
  },
  review_requested: {
    label: "Reply waiting for review",
    hint: "A newbie's reply in your team needs your review",
    email: true,
    defaults: { push: true, email: false, bell: true },
  },
  review_returned: {
    label: "Reply returned",
    hint: "A reviewer sent your reply back with a note",
    email: true,
    defaults: { push: true, email: false, bell: true },
  },
  sla_warning: {
    label: "SLA nearing",
    hint: "A ticket of yours is close to its reply or resolve target",
    email: true,
    defaults: { push: true, email: false, bell: true },
  },
  sla_breach: {
    label: "SLA breached",
    hint: "A ticket of yours missed its reply or resolve target",
    email: true,
    defaults: { push: true, email: true, bell: true },
  },
};

export type HdPreviewMode = "full" | "private";

export interface HdQuietHours {
  enabled: boolean;
  /** "HH:MM", 24-hour, in the agent's time zone. */
  start: string;
  end: string;
  /** Days the quiet window starts on: 0 Sunday … 6 Saturday. */
  days: number[];
  /** Urgent tickets and SLA breaches still come through. */
  breakthrough: boolean;
}

export interface HdNotifyPrefs {
  matrix: Record<HdNotifyEvent, Record<HdNotifyChannel, boolean>>;
  /** Per-team opt-in for "New in my teams", keyed by team id; a missing team is on. */
  teams: Record<string, boolean>;
  quiet: HdQuietHours;
  preview: HdPreviewMode;
  sound: boolean;
  /** Push and email paused: `until` an instant, or null for "until I resume". */
  pause: { until: string | null } | null;
}

/** What the agent may send in a PUT: any part of the prefs, plus a pause request. */
export type HdPauseRequest = "1h" | "tomorrow" | "indefinite" | "off";

export const DEFAULT_QUIET: HdQuietHours = {
  enabled: false,
  start: "18:00",
  end: "08:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  breakthrough: true,
};

export function defaultPrefs(): HdNotifyPrefs {
  const matrix = {} as HdNotifyPrefs["matrix"];
  for (const ev of HD_NOTIFY_EVENTS) matrix[ev] = { ...HD_NOTIFY_EVENT_INFO[ev].defaults };
  return { matrix, teams: {}, quiet: { ...DEFAULT_QUIET, days: [...DEFAULT_QUIET.days] }, preview: "full", sound: true, pause: null };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Lay stored (or submitted) prefs over the defaults, dropping anything
 * unknown or malformed. Never throws: a corrupt row reads as the defaults.
 */
export function resolvePrefs(stored: unknown): HdNotifyPrefs {
  const out = defaultPrefs();
  if (!isObj(stored)) return out;
  if (isObj(stored.matrix)) {
    for (const ev of HD_NOTIFY_EVENTS) {
      const row = stored.matrix[ev];
      if (!isObj(row)) continue;
      for (const ch of HD_NOTIFY_CHANNELS) {
        if (typeof row[ch] === "boolean") out.matrix[ev][ch] = row[ch] as boolean;
      }
      if (!HD_NOTIFY_EVENT_INFO[ev].email) out.matrix[ev].email = false;
    }
  }
  if (isObj(stored.teams)) {
    for (const [k, v] of Object.entries(stored.teams)) {
      if (/^\d{1,9}$/.test(k) && typeof v === "boolean") out.teams[k] = v;
    }
  }
  if (isObj(stored.quiet)) {
    const q = stored.quiet;
    if (typeof q.enabled === "boolean") out.quiet.enabled = q.enabled;
    if (typeof q.start === "string" && TIME_RE.test(q.start)) out.quiet.start = q.start;
    if (typeof q.end === "string" && TIME_RE.test(q.end)) out.quiet.end = q.end;
    if (Array.isArray(q.days)) {
      const days = [...new Set(q.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      out.quiet.days = days;
    }
    if (typeof q.breakthrough === "boolean") out.quiet.breakthrough = q.breakthrough;
  }
  if (stored.preview === "full" || stored.preview === "private") out.preview = stored.preview;
  if (typeof stored.sound === "boolean") out.sound = stored.sound;
  if (isObj(stored.pause)) {
    const u = stored.pause.until;
    if (u === null) out.pause = { until: null };
    else if (typeof u === "string" && !Number.isNaN(Date.parse(u))) out.pause = { until: new Date(u).toISOString() };
  }
  return out;
}

/**
 * Check a submitted prefs patch strictly (the API refuses rather than
 * silently dropping a field the agent changed). Returns the problem
 * sentence, or null when the patch is acceptable.
 */
export function prefsPatchProblem(patch: unknown): string | null {
  if (!isObj(patch)) return "Send the preferences as an object.";
  const known = new Set(["matrix", "teams", "quiet", "preview", "sound", "pause"]);
  for (const k of Object.keys(patch)) if (!known.has(k)) return `Unknown preference "${k.slice(0, 40)}".`;
  if (patch.matrix !== undefined) {
    if (!isObj(patch.matrix)) return "The event matrix must be an object.";
    for (const [ev, row] of Object.entries(patch.matrix)) {
      if (!(HD_NOTIFY_EVENTS as readonly string[]).includes(ev)) return `Unknown event "${ev.slice(0, 40)}".`;
      if (!isObj(row)) return "Each event needs an object of channels.";
      for (const [ch, v] of Object.entries(row)) {
        if (!(HD_NOTIFY_CHANNELS as readonly string[]).includes(ch)) return `Unknown channel "${ch.slice(0, 40)}".`;
        if (typeof v !== "boolean") return "Channel switches are true or false.";
        if (ch === "email" && v && !HD_NOTIFY_EVENT_INFO[ev as HdNotifyEvent].email) {
          return `No email is sent for "${HD_NOTIFY_EVENT_INFO[ev as HdNotifyEvent].label}".`;
        }
      }
    }
  }
  if (patch.teams !== undefined) {
    if (!isObj(patch.teams)) return "Teams must be an object of team ids.";
    const entries = Object.entries(patch.teams);
    if (entries.length > 200) return "Too many teams.";
    for (const [k, v] of entries) {
      if (!/^\d{1,9}$/.test(k) || typeof v !== "boolean") return "Each team is an id with true or false.";
    }
  }
  if (patch.quiet !== undefined) {
    if (!isObj(patch.quiet)) return "Quiet hours must be an object.";
    const q = patch.quiet;
    if (q.enabled !== undefined && typeof q.enabled !== "boolean") return "Quiet hours are on or off.";
    if (q.start !== undefined && (typeof q.start !== "string" || !TIME_RE.test(q.start))) return "Start quiet hours at a time like 18:00.";
    if (q.end !== undefined && (typeof q.end !== "string" || !TIME_RE.test(q.end))) return "End quiet hours at a time like 08:00.";
    if (q.days !== undefined) {
      if (!Array.isArray(q.days) || q.days.length > 7 || !q.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        return "Quiet days are numbers from 0 (Sunday) to 6 (Saturday).";
      }
    }
    if (q.breakthrough !== undefined && typeof q.breakthrough !== "boolean") return "Break-through is on or off.";
    for (const k of Object.keys(q)) {
      if (!["enabled", "start", "end", "days", "breakthrough"].includes(k)) return `Unknown quiet-hours field "${k.slice(0, 40)}".`;
    }
  }
  if (patch.preview !== undefined && patch.preview !== "full" && patch.preview !== "private") return "Preview is full or private.";
  if (patch.sound !== undefined && typeof patch.sound !== "boolean") return "Sound is on or off.";
  if (patch.pause !== undefined && !["1h", "tomorrow", "indefinite", "off"].includes(patch.pause as string)) {
    return "Pause for 1h, until tomorrow, indefinitely, or off.";
  }
  return null;
}

// --- Time zones -------------------------------------------------------------------

/** The local wall clock of an instant in an IANA zone: weekday 0–6 and minutes since midnight. */
export function localClock(at: Date, timeZone: string): { y: number; m: number; d: number; weekday: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    return localClock(at, "UTC");
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour")) % 24;
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    weekday: weekday < 0 ? 0 : weekday,
    minutes: hour * 60 + Number(get("minute")),
  };
}

/** The UTC instant at which the wall clock in `timeZone` reads y-m-d hh:mm (DST-safe to the minute). */
export function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const c = localClock(new Date(guess), timeZone);
    const seen = Date.UTC(c.y, c.m - 1, c.d, Math.floor(c.minutes / 60), c.minutes % 60);
    const diff = wanted - seen;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * True when `at` falls inside the agent's quiet hours. `days` are the days a
 * window starts on, so an overnight window (22:00 to 07:00) set for Friday
 * keeps Saturday 03:00 quiet and leaves Saturday 23:00 alone. Equal start
 * and end mean the whole of each chosen day.
 */
export function inQuietHours(quiet: HdQuietHours, at: Date, timeZone: string): boolean {
  if (!quiet.enabled || quiet.days.length === 0) return false;
  const { weekday, minutes } = localClock(at, timeZone);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  const on = (day: number) => quiet.days.includes(((day % 7) + 7) % 7);
  if (start === end) return on(weekday);
  if (start < end) return on(weekday) && minutes >= start && minutes < end;
  return (minutes >= start && on(weekday)) || (minutes < end && on(weekday - 1));
}

/** True while a pause holds at `at`. */
export function isPaused(prefs: Pick<HdNotifyPrefs, "pause">, at: Date): boolean {
  if (!prefs.pause) return false;
  if (prefs.pause.until === null) return true;
  return Date.parse(prefs.pause.until) > at.getTime();
}

/** The stored pause for a request: one hour, until 08:00 tomorrow in the agent's zone, until resumed, or none. */
export function pauseFor(request: HdPauseRequest, now: Date, timeZone: string): HdNotifyPrefs["pause"] {
  if (request === "off") return null;
  if (request === "indefinite") return { until: null };
  if (request === "1h") return { until: new Date(now.getTime() + 3_600_000).toISOString() };
  const today = localClock(now, timeZone);
  const next = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
  return { until: zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 8, 0, timeZone).toISOString() };
}

/** Events that may break through quiet hours when the agent allows it. */
export function breaksThrough(event: HdNotifyEvent, urgent: boolean): boolean {
  return urgent || event === "sla_breach";
}

/**
 * Whether push and email are held back for this event right now, and why.
 * The bell is never held: it is the record, so nothing is lost.
 */
export function holdReason(
  prefs: HdNotifyPrefs,
  event: HdNotifyEvent,
  urgent: boolean,
  at: Date,
  timeZone: string
): "paused" | "quiet" | null {
  if (isPaused(prefs, at)) return "paused";
  if (inQuietHours(prefs.quiet, at, timeZone) && !(prefs.quiet.breakthrough && breaksThrough(event, urgent))) return "quiet";
  return null;
}

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
