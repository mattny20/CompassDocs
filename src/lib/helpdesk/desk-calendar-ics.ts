// Helpdesk 1.20.6: iCalendar in and out for the desk's event calendar. Pure
// (no database, no network): lib/helpdesk/inbound reads a meeting invite with
// parseInvite, and the private feed (lib/helpdesk/desk-calendar-feed) writes
// its .ics with buildCalendar.
//
// The reader is small and strict on purpose. An invite arrives in an email
// from anyone, so it is treated as hostile:
//   - at most ICS_LIMITS.bytes of text and ICS_LIMITS.lines lines; anything
//     larger is not an invite (null), never a long parse;
//   - one pass over the text, character by character: no regular expression
//     ever runs over more than one short value, so no input can make it slow;
//   - only the first VEVENT is read, and only the few properties below;
//     nested components (alarms) and everything else are skipped;
//   - no recurrence is expanded: an RRULE event is its first occurrence and
//     `repeats` says so;
//   - it never throws: something that isn't a usable invite is null.
//
// What it reads: METHOD (REQUEST, or none, is an invite; CANCEL cancels;
// anything else, such as an attendee's REPLY, is not an invite), and from the
// first VEVENT: UID, SEQUENCE, SUMMARY, LOCATION, STATUS, DTSTART, DTEND or
// DURATION, RRULE. Times: UTC ("…Z"), a named zone (TZID, an IANA name or one
// of the common Windows names Outlook writes), a floating time (read in the
// desk's zone, with a note) or whole days (VALUE=DATE; DTEND is the day after
// the last, as iCalendar has it).

import { addDays, daysBetween, EVENT_LIMITS, parseDay, validZone, wallInstant } from "./desk-calendar-shared";
import { mdInline } from "./md-inline";

export const ICS_LIMITS = {
  /** Larger than this is not read at all. */
  bytes: 256 * 1024,
  /** Physical lines (before unfolding). */
  lines: 5000,
  /** An unfolded line is cut here (a long DESCRIPTION is never needed). */
  line: 4096,
  uid: 255,
  summary: 300,
  location: EVENT_LIMITS.place,
} as const;

export interface ParsedInvite {
  /** "request": the meeting as it stands. "cancel": it was cancelled. */
  method: "request" | "cancel";
  uid: string;
  sequence: number;
  summary: string;
  location: string;
  all_day: boolean;
  /** All-day: the first and last day, inclusive. */
  start_date: string | null;
  end_date: string | null;
  /** The instants (ms). For whole days: their midnights in `timezone`. */
  starts_at: number;
  ends_at: number;
  /** The zone the times were read in. */
  timezone: string;
  repeats: boolean;
  /** Sentences for the agents (a zone that was not known, an end that was cut). */
  notes: string[];
}

// Outlook writes Windows zone names in TZID. The common ones, mapped to the
// IANA zone Windows itself maps them to (CLDR windowsZones, territory 001).
const WINDOWS_ZONES: Record<string, string> = {
  "utc": "UTC",
  "coordinated universal time": "UTC",
  "greenwich standard time": "Atlantic/Reykjavik",
  "gmt standard time": "Europe/London",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "central european standard time": "Europe/Warsaw",
  "romance standard time": "Europe/Paris",
  "e. europe standard time": "Europe/Chisinau",
  "fle standard time": "Europe/Kiev",
  "gtb standard time": "Europe/Bucharest",
  "turkey standard time": "Europe/Istanbul",
  "russian standard time": "Europe/Moscow",
  "israel standard time": "Asia/Jerusalem",
  "south africa standard time": "Africa/Johannesburg",
  "egypt standard time": "Africa/Cairo",
  "w. central africa standard time": "Africa/Lagos",
  "e. africa standard time": "Africa/Nairobi",
  "arab standard time": "Asia/Riyadh",
  "arabian standard time": "Asia/Dubai",
  "iran standard time": "Asia/Tehran",
  "pakistan standard time": "Asia/Karachi",
  "india standard time": "Asia/Kolkata",
  "bangladesh standard time": "Asia/Dhaka",
  "se asia standard time": "Asia/Bangkok",
  "china standard time": "Asia/Shanghai",
  "singapore standard time": "Asia/Singapore",
  "taipei standard time": "Asia/Taipei",
  "w. australia standard time": "Australia/Perth",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "cen. australia standard time": "Australia/Adelaide",
  "aus central standard time": "Australia/Darwin",
  "e. australia standard time": "Australia/Brisbane",
  "aus eastern standard time": "Australia/Sydney",
  "tasmania standard time": "Australia/Hobart",
  "new zealand standard time": "Pacific/Auckland",
  "hawaiian standard time": "Pacific/Honolulu",
  "alaskan standard time": "America/Anchorage",
  "pacific standard time": "America/Los_Angeles",
  "pacific standard time (mexico)": "America/Tijuana",
  "us mountain standard time": "America/Phoenix",
  "mountain standard time": "America/Denver",
  "central standard time": "America/Chicago",
  "central standard time (mexico)": "America/Mexico_City",
  "canada central standard time": "America/Regina",
  "eastern standard time": "America/New_York",
  "us eastern standard time": "America/Indianapolis",
  "sa pacific standard time": "America/Bogota",
  "venezuela standard time": "America/Caracas",
  "atlantic standard time": "America/Halifax",
  "newfoundland standard time": "America/St_Johns",
  "e. south america standard time": "America/Sao_Paulo",
  "argentina standard time": "America/Buenos_Aires",
  "pacific sa standard time": "America/Santiago",
  "azores standard time": "Atlantic/Azores",
  "cape verde standard time": "Atlantic/Cape_Verde",
  "morocco standard time": "Africa/Casablanca",
};

const known = (zone: string): boolean => validZone(zone);

/** A TZID as an IANA zone we can count in, or null. */
export function zoneFromTzid(raw: string): string | null {
  const id = raw.trim().replace(/^"|"$/g, "");
  if (!id || id.length > 120) return null;
  if (known(id)) return id;
  const win = WINDOWS_ZONES[id.toLowerCase()];
  if (win && known(win)) return win;
  // "/mozilla.org/20050126_1/Europe/London" and the like: the zone is the tail.
  const parts = id.split("/").filter(Boolean);
  for (const n of [3, 2]) {
    if (parts.length >= n) {
      const tail = parts.slice(-n).join("/");
      if (known(tail)) return tail;
    }
  }
  return null;
}

interface Prop {
  params: Map<string, string>;
  value: string;
}

/** One content line → its name, parameters and value. One pass; a quoted parameter value may hold ':' and ';'. */
function readLine(line: string): { name: string; prop: Prop } | null {
  let i = 0;
  const n = line.length;
  while (i < n && line[i] !== ";" && line[i] !== ":") i++;
  if (i === 0 || i >= n) return null;
  const name = line.slice(0, i).toUpperCase();
  const params = new Map<string, string>();
  while (i < n && line[i] === ";") {
    i++;
    const ks = i;
    while (i < n && line[i] !== "=" && line[i] !== ";" && line[i] !== ":") i++;
    const key = line.slice(ks, i).toUpperCase();
    let val = "";
    if (line[i] === "=") {
      i++;
      if (line[i] === '"') {
        const vs = ++i;
        while (i < n && line[i] !== '"') i++;
        val = line.slice(vs, i);
        if (i < n) i++;
        // Anything between the closing quote and the next delimiter is not part of the value.
        while (i < n && line[i] !== ";" && line[i] !== ":") i++;
      } else {
        const vs = i;
        while (i < n && line[i] !== ";" && line[i] !== ":") i++;
        val = line.slice(vs, i);
      }
    }
    if (key && !params.has(key)) params.set(key, val);
  }
  if (line[i] !== ":") return null;
  return { name, prop: { params, value: line.slice(i + 1) } };
}

/** A TEXT value as one line of plain text: escapes undone, line breaks and control characters as spaces. */
function text(value: string, max: number): string {
  let out = "";
  for (let i = 0; i < value.length && out.length < max * 2; i++) {
    const c = value[i];
    if (c === "\\" && i + 1 < value.length) {
      const d = value[++i];
      out += d === "n" || d === "N" ? " " : d;
    } else out += c;
  }
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

interface When {
  date: string;
  /** Null: a whole day. */
  time: { h: number; min: number } | null;
  utc: boolean;
}

function readWhen(value: string): When | null {
  const v = value.trim();
  if (v.length > 20) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(v);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!parseDay(date) || Number(m[1]) < 2000 || Number(m[1]) > 2099) return null;
  if (m[4] === undefined) return { date, time: null, utc: false };
  const h = Number(m[4]);
  const min = Number(m[5]);
  if (h > 23 || min > 59) return null;
  return { date, time: { h, min }, utc: !!m[7] };
}

/** "PT1H30M", "P1D", "P2W" → milliseconds; null when not a positive duration we read. */
function readDuration(value: string): number | null {
  const m = /^\+?P(?:(\d{1,3})W)?(?:(\d{1,4})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,5})M)?(?:(\d{1,6})S)?)?$/i.exec(value.trim().slice(0, 40));
  if (!m) return null;
  const ms = (Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0)) * 86_400_000 + Number(m[3] ?? 0) * 3_600_000 + Number(m[4] ?? 0) * 60_000 + Number(m[5] ?? 0) * 1000;
  return ms > 0 ? ms : null;
}

const WANTED = new Set(["UID", "SEQUENCE", "SUMMARY", "LOCATION", "STATUS", "DTSTART", "DTEND", "DURATION", "RRULE"]);

/**
 * Read a meeting invite. `fallbackZone` is the zone a time with no zone of
 * its own is read in (the desk's). Null when the text is not an invite we
 * act on: too large, not a calendar, no event with a start, or a method
 * other than a request or a cancellation. Never throws.
 */
export function parseInvite(input: string | Uint8Array, fallbackZone: string): ParsedInvite | null {
  try {
    return parse(input, validZone(fallbackZone) ? fallbackZone : "UTC");
  } catch {
    return null;
  }
}

function parse(input: string | Uint8Array, fallbackZone: string): ParsedInvite | null {
  if (typeof input !== "string") {
    if (input.byteLength > ICS_LIMITS.bytes) return null;
    input = new TextDecoder("utf-8").decode(input);
  }
  if (input.length > ICS_LIMITS.bytes) return null;
  let src = input;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  let method = "";
  let sawCalendar = false;
  /** Component nesting: 1 inside VCALENDAR. */
  let depth = 0;
  /** The depth the first VEVENT opened at; 0 before it, -1 once it has closed. */
  let eventDepth = 0;
  const props = new Map<string, Prop>();

  const handle = (line: string): void => {
    const r = readLine(line);
    if (!r) return;
    const { name, prop } = r;
    if (name === "BEGIN") {
      const what = prop.value.trim().toUpperCase();
      depth++;
      if (what === "VCALENDAR" && depth === 1) sawCalendar = true;
      else if (what === "VEVENT" && depth === 2 && eventDepth === 0 && sawCalendar) eventDepth = depth;
      return;
    }
    if (name === "END") {
      if (eventDepth > 0 && depth === eventDepth && prop.value.trim().toUpperCase() === "VEVENT") eventDepth = -1;
      depth = Math.max(0, depth - 1);
      return;
    }
    if (depth === 1 && sawCalendar && name === "METHOD" && !method) method = prop.value.trim().toUpperCase().slice(0, 20);
    // Only the event's own properties: a nested alarm has a DURATION and a SUMMARY of its own.
    else if (eventDepth > 0 && depth === eventDepth && WANTED.has(name) && !props.has(name)) props.set(name, prop);
  };

  // Unfold and walk the lines in one pass.
  let lines = 0;
  let cur = "";
  let started = false;
  let i = 0;
  const n = src.length;
  while (i <= n) {
    let j = i;
    while (j < n && src.charCodeAt(j) !== 10 && src.charCodeAt(j) !== 13) j++;
    const piece = src.slice(i, j);
    if (++lines > ICS_LIMITS.lines) return null;
    const c0 = piece.charCodeAt(0);
    if (started && (c0 === 32 || c0 === 9)) {
      // A folded line: the rest of the one before, without the leading space.
      if (cur.length < ICS_LIMITS.line) cur += piece.slice(1, 1 + ICS_LIMITS.line - cur.length);
    } else {
      if (started && cur) handle(cur);
      cur = piece.length > ICS_LIMITS.line ? piece.slice(0, ICS_LIMITS.line) : piece;
      started = true;
    }
    if (j >= n) break;
    i = src.charCodeAt(j) === 13 && src.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
  }
  if (cur) handle(cur);

  if (!sawCalendar || eventDepth === 0) return null;
  let kind: "request" | "cancel";
  if (method === "CANCEL") kind = "cancel";
  else if (method === "" || method === "REQUEST" || method === "PUBLISH") kind = "request";
  else return null;
  if ((props.get("STATUS")?.value ?? "").trim().toUpperCase() === "CANCELLED") kind = "cancel";

  const uid = text(props.get("UID")?.value ?? "", ICS_LIMITS.uid);
  const seqRaw = (props.get("SEQUENCE")?.value ?? "").trim();
  const sequence = /^\d{1,9}$/.test(seqRaw) ? Number(seqRaw) : 0;
  const summary = text(props.get("SUMMARY")?.value ?? "", ICS_LIMITS.summary);
  const location = text(props.get("LOCATION")?.value ?? "", ICS_LIMITS.location);
  const repeats = props.has("RRULE");
  const notes: string[] = [];

  const ds = props.get("DTSTART");
  const start = ds ? readWhen(ds.value) : null;
  if (!ds || !start) return null;
  const de = props.get("DTEND");
  const end = de ? readWhen(de.value) : null;
  const duration = props.has("DURATION") ? readDuration(props.get("DURATION")!.value) : null;

  // Whole days.
  if (!start.time) {
    let last = start.date;
    if (end && !end.time) last = daysBetween(start.date, end.date) >= 1 ? addDays(end.date, -1) : start.date;
    else if (duration && duration >= 86_400_000) last = addDays(start.date, Math.floor(duration / 86_400_000) - 1);
    if (daysBetween(start.date, last) >= EVENT_LIMITS.maxDays) {
      last = addDays(start.date, EVENT_LIMITS.maxDays - 1);
      notes.push(`The invite runs for longer than ${EVENT_LIMITS.maxDays} days. Only its first ${EVENT_LIMITS.maxDays} days are on the calendar.`);
    }
    const a = parseDay(start.date)!;
    const next = parseDay(addDays(last, 1))!;
    return {
      method: kind,
      uid,
      sequence,
      summary,
      location,
      all_day: true,
      start_date: start.date,
      end_date: last,
      starts_at: wallInstant(a.y, a.m, a.d, 0, 0, fallbackZone),
      ends_at: wallInstant(next.y, next.m, next.d, 0, 0, fallbackZone),
      timezone: fallbackZone,
      repeats,
      notes,
    };
  }

  // A time: UTC, a named zone, or floating.
  const zoneOf = (p: Prop, w: When): string => {
    if (w.utc) return "UTC";
    const tzid = p.params.get("TZID");
    if (tzid) {
      const z = zoneFromTzid(tzid);
      if (z) return z;
      // The note becomes an agents-only Markdown line: the sender's zone name is escaped so it stays the characters it is.
      const shown = mdInline(text(tzid, 60));
      const note = `The invite's time zone ("${shown}") isn't one the desk knows, so its times were read in the desk's zone. Check them.`;
      if (!notes.includes(note)) notes.push(note);
      return fallbackZone;
    }
    const note = "The invite gave its times without a time zone, so they were read in the desk's zone. Check them.";
    if (!notes.includes(note)) notes.push(note);
    return fallbackZone;
  };
  const at = (w: When, zone: string): number => {
    const d = parseDay(w.date)!;
    return zone === "UTC" ? Date.UTC(d.y, d.m - 1, d.d, w.time!.h, w.time!.min) : wallInstant(d.y, d.m, d.d, w.time!.h, w.time!.min, zone);
  };
  const zone = zoneOf(ds, start);
  const startsAt = at(start, zone);
  let endsAt: number;
  if (end && end.time) endsAt = at(end, zoneOf(de!, end));
  else if (duration) endsAt = startsAt + duration;
  else endsAt = startsAt + 3_600_000;
  if (endsAt <= startsAt) endsAt = startsAt + 3_600_000;
  if (endsAt - startsAt > EVENT_LIMITS.maxDays * 86_400_000) {
    endsAt = startsAt + EVENT_LIMITS.maxDays * 86_400_000;
    notes.push(`The invite runs for longer than ${EVENT_LIMITS.maxDays} days. Only its first ${EVENT_LIMITS.maxDays} days are on the calendar.`);
  }
  return { method: kind, uid, sequence, summary, location, all_day: false, start_date: null, end_date: null, starts_at: startsAt, ends_at: endsAt, timezone: zone, repeats, notes };
}

/** Does this attachment look like a calendar file? By its claimed type or its name. */
export function isCalendarFile(f: { name: string; type: string }): boolean {
  const type = (f.type || "").toLowerCase();
  return type.startsWith("text/calendar") || type.startsWith("application/ics") || /\.(ics|vcs)$/i.test(f.name || "");
}

// --- Writing -------------------------------------------------------------------------

/** One event of a feed. Times are instants; whole days are dates (the last day inclusive). */
export interface FeedEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  url: string;
  all_day: boolean;
  starts_at: Date;
  ends_at: Date;
  start_date: string | null;
  end_date: string | null;
  cancelled: boolean;
  sequence: number;
  updated_at: Date;
}

/** A TEXT value: backslash, semicolon and comma escaped, line breaks as \n, control characters dropped. */
export function icsText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

const enc = new TextEncoder();

/** Fold a content line at 75 octets, never inside a character (RFC 5545 §3.1). */
export function foldLine(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
      limit = 74; // the continuation's leading space counts
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const p2 = (n: number) => String(n).padStart(2, "0");
const utcStamp = (d: Date) => `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
const dateStamp = (day: string) => day.replace(/-/g, "");

/** A whole calendar (METHOD:PUBLISH) as text with CRLF line ends. */
export function buildCalendar(name: string, events: FeedEvent[], now: Date = new Date()): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CompassDocs//Helpdesk calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${icsText(e.uid)}`, `DTSTAMP:${utcStamp(now)}`, `LAST-MODIFIED:${utcStamp(e.updated_at)}`, `SEQUENCE:${Math.max(0, Math.floor(e.sequence))}`);
    if (e.all_day && e.start_date && e.end_date) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(e.start_date)}`, `DTEND;VALUE=DATE:${dateStamp(addDays(e.end_date, 1))}`);
    } else {
      lines.push(`DTSTART:${utcStamp(e.starts_at)}`, `DTEND:${utcStamp(e.ends_at)}`);
    }
    lines.push(`SUMMARY:${icsText(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url.replace(/[\r\n]/g, "")}`);
    lines.push(`STATUS:${e.cancelled ? "CANCELLED" : "CONFIRMED"}`, "TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
