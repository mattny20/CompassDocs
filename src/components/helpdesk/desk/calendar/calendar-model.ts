// The Calendar page's view model (1.20.6, lib/helpdesk/desk-calendar): what
// the day, week, month and list views, on screen and on paper, all draw from.
// Pure: the server's print page and the client page share it, so the paper
// shows what the screen showed.
//
// One CalItem per thing on the calendar: an event (with its setup block), a
// ticket's due time (the Due dates layer) or a ticket a recurring schedule
// will open (the Recurring tickets layer). Timed items are placed by the
// viewer's wall clock; whole-day events sit on their calendar days.

import {
  addDays,
  dayOf,
  daySegment,
  dayStart,
  eventOnDay,
  layoutColumns,
  timeLabel,
  type DaySegment,
  type HdCalendarColour,
  type HdCalendarData,
  type HdCalendarEvent,
} from "@/lib/helpdesk/desk-calendar-shared";

export type CalKind = "event" | "due" | "recurring";

export interface CalItem {
  kind: CalKind;
  key: string;
  /** Instants (ms). A layer item is a moment: end = start. */
  start: number;
  end: number;
  /** Events: when setup must be ready (= start with no setup time). */
  ready: number;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  number: number | null;
  title: string;
  place: string;
  teamId: number | null;
  teamName: string | null;
  assignee: string | null;
  status: string;
  statusLabel: string;
  setupComplete: boolean;
  cancelled: boolean;
  repeats: boolean;
  conflicts: (number | null)[];
  /** Layer items: "Reply due", "Resolve due", "Recurring ticket". */
  layerLabel: string;
  overdue: boolean;
  href: string | null;
}

const base = { place: "", assignee: null, status: "", statusLabel: "", setupComplete: false, cancelled: false, repeats: false, conflicts: [], overdue: false, allDay: false, startDate: null, endDate: null } as const;

function eventItem(e: HdCalendarEvent): CalItem {
  return {
    kind: "event",
    key: `e${e.number}`,
    start: new Date(e.starts_at).getTime(),
    end: new Date(e.ends_at).getTime(),
    ready: new Date(e.ready_at).getTime(),
    allDay: e.all_day,
    startDate: e.start_date,
    endDate: e.end_date,
    number: e.number,
    title: e.subject,
    place: e.place,
    teamId: e.team_id,
    teamName: e.team_name,
    assignee: e.assignee_name,
    status: e.status,
    statusLabel: e.status_label,
    setupComplete: e.setup_complete,
    cancelled: e.cancelled,
    repeats: e.repeats,
    conflicts: e.conflicts,
    layerLabel: "",
    overdue: false,
    href: `/desk/tickets/${e.number}`,
  };
}

/** Every item of a calendar read, events first. */
export function calendarItems(data: HdCalendarData): CalItem[] {
  const out: CalItem[] = data.events.map(eventItem);
  for (const d of data.due) {
    const at = new Date(d.at).getTime();
    out.push({
      ...base,
      conflicts: [],
      kind: "due",
      key: `d${d.number}`,
      start: at,
      end: at,
      ready: at,
      number: d.number,
      title: d.subject,
      teamId: d.team_id,
      teamName: d.team_name,
      assignee: d.assignee_name,
      layerLabel: d.kind === "first_reply" ? "Reply due" : "Resolve due",
      overdue: d.overdue,
      href: `/desk/tickets/${d.number}`,
    });
  }
  for (const r of data.recurring) {
    const at = new Date(r.at).getTime();
    out.push({ ...base, conflicts: [], kind: "recurring", key: `r${r.recurring_id}:${r.at}`, start: at, end: at, ready: at, number: null, title: r.title, teamId: r.team_id, teamName: r.team_name, layerLabel: "Recurring ticket", href: null });
  }
  return out;
}

/** Does the item show on this calendar day? An event's setup block counts with `withSetup` (the time grid draws it). */
export function itemOnDay(i: CalItem, day: string, tz: string, withSetup = false): boolean {
  if (i.kind !== "event") return dayOf(i.start, tz) === day;
  return eventOnDay(
    { starts_at: new Date(i.start).toISOString(), ends_at: new Date(i.end).toISOString(), ready_at: new Date(i.ready).toISOString(), all_day: i.allDay, start_date: i.startDate, end_date: i.endDate },
    day,
    tz,
    withSetup
  );
}

/** A day's items in reading order: whole-day events, then by start time. */
export function dayItems(items: CalItem[], day: string, tz: string): CalItem[] {
  const a = dayStart(day, tz);
  return items
    .filter((i) => itemOnDay(i, day, tz))
    .sort((x, y) => Number(y.allDay) - Number(x.allDay) || Math.max(x.start, a) - Math.max(y.start, a) || (x.number ?? 0) - (y.number ?? 0));
}

/** "14:00 to 15:30", "All day", "from 22:00" / "until 01:00" for a part of a longer event, "09:00" for a layer item. */
export function itemTime(i: CalItem, day: string, tz: string, h12: boolean): string {
  if (i.kind !== "event") return timeLabel(i.start, tz, h12);
  if (i.allDay) return "All day";
  const a = dayStart(day, tz);
  const b = dayStart(addDays(day, 1), tz);
  const startsHere = i.start >= a;
  const endsHere = i.end <= b;
  if (startsHere && endsHere) return `${timeLabel(i.start, tz, h12)} to ${timeLabel(i.end, tz, h12)}`;
  if (startsHere) return `from ${timeLabel(i.start, tz, h12)}`;
  if (endsHere) return `until ${timeLabel(i.end, tz, h12)}`;
  return "All day";
}

/** The time the short rows lead with: "14:00", "All day". */
export function itemStartLabel(i: CalItem, day: string, tz: string, h12: boolean): string {
  if (i.kind === "event" && (i.allDay || i.start < dayStart(day, tz))) return i.allDay ? "All day" : "Cont.";
  return timeLabel(i.start, tz, h12);
}

/** A layer item's word where room is short: "Reply due", "Due" (a resolve target), "Opens" (a recurring ticket). */
export function layerShort(i: CalItem): string {
  return i.kind === "due" ? (i.layerLabel === "Reply due" ? "Reply due" : "Due") : i.kind === "recurring" ? "Opens" : "";
}

/** A block in a day's time grid. */
export interface GridBlock {
  item: CalItem;
  /** The whole block, setup included: wall-clock minutes from the top. */
  top: number;
  bottom: number;
  /** Where the event itself starts inside the block (= top with no setup on this day). */
  eventTop: number;
  seg: DaySegment;
  col: number;
  cols: number;
}

/** A layer item takes this much room in the grid so its words fit. */
const MOMENT_MINUTES = 30;
/** The shortest block drawn, so a 10-minute event is still readable. */
const MIN_BLOCK = 25;

/** The timed blocks of a day, laid out side by side where they overlap. Whole-day events are not here. */
export function dayBlocks(items: CalItem[], day: string, tz: string): GridBlock[] {
  const raw: (Omit<GridBlock, "col" | "cols">)[] = [];
  for (const i of items) {
    if (i.kind === "event" && i.allDay) continue;
    if (i.kind !== "event") {
      if (dayOf(i.start, tz) !== day) continue;
      const seg = daySegment(i.start, i.start + MOMENT_MINUTES * 60_000, day, tz);
      if (!seg) continue;
      const top = Math.min(seg.top, 1440 - MOMENT_MINUTES);
      raw.push({ item: i, top, bottom: top + MOMENT_MINUTES, eventTop: top, seg });
      continue;
    }
    const seg = daySegment(i.ready, i.end, day, tz);
    if (!seg) continue;
    const ev = daySegment(i.start, i.end, day, tz);
    const bottom = Math.min(1440, Math.max(seg.bottom, seg.top + MIN_BLOCK));
    raw.push({ item: i, top: Math.min(seg.top, 1440 - MIN_BLOCK), bottom, eventTop: ev ? Math.min(ev.top, bottom - 1) : bottom, seg });
  }
  return layoutColumns(raw);
}

// --- Colour and its words ---------------------------------------------------------------

/** A short text tag for a team: "IT Service Desk" → "ISD", "Facilities" → "FAC". Never the only thing telling teams apart: the legend spells it out. */
export function abbreviate(name: string | null): string {
  const words = (name ?? "").trim().split(/[\s/&-]+/).filter(Boolean);
  if (!words.length) return "NO TEAM";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .slice(0, 4)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

const STATUS_SHORT: Record<string, string> = { new: "New", open: "Open", pending: "Waiting", on_hold: "On hold", solved: "Solved", closed: "Closed" };

/** Team colour slots: slot 1 (the workspace accent) to 8 of the reports' validated palette, by the team's place in the list. */
export function teamSlots(teams: { id: number }[]): Map<number, number> {
  return new Map(teams.map((t, i) => [t.id, (i % 8) + 1]));
}

/** The colour variable and the words that go with it for one item. */
export function itemTone(i: CalItem, colour: HdCalendarColour, slots: Map<number, number>): { color: string; tag: string; label: string } {
  if (i.kind !== "event" || colour === "team") {
    const slot = i.teamId !== null ? slots.get(i.teamId) : undefined;
    return { color: slot ? `var(--s${slot})` : "rgb(var(--slate-400))", tag: abbreviate(i.teamName), label: i.teamName ?? "No team" };
  }
  const STATUS: Record<string, string> = {
    new: "#0ea5e9",
    open: "rgb(var(--compass-500))",
    pending: "#f59e0b",
    on_hold: "rgb(var(--slate-400))",
    solved: "#10b981",
    closed: "rgb(var(--slate-300))",
  };
  return { color: STATUS[i.status] ?? "rgb(var(--slate-400))", tag: STATUS_SHORT[i.status] ?? i.statusLabel, label: i.statusLabel };
}

/** What a screen reader hears for an item, and what its tooltip says. */
export function itemSummary(i: CalItem, day: string, tz: string, h12: boolean): string {
  const parts: string[] = [];
  if (i.kind === "event") {
    parts.push(`#${i.number} ${i.title}`, itemTime(i, day, tz, h12));
    if (i.place) parts.push(i.place);
    if (i.teamName) parts.push(i.teamName);
    parts.push(i.statusLabel);
    if (i.cancelled) parts.push("Cancelled");
    else {
      if (i.ready < i.start) parts.push(`Setup ready by ${timeLabel(i.ready, tz, h12)}`);
      parts.push(i.setupComplete ? "Setup complete" : "Setup not complete");
    }
    if (i.conflicts.length) parts.push("Double-booked");
  } else {
    parts.push(`${i.layerLabel}${i.overdue ? " (overdue)" : ""}`, i.number ? `#${i.number} ${i.title}` : i.title, timeLabel(i.start, tz, h12));
    if (i.teamName) parts.push(i.teamName);
  }
  return parts.join(" · ");
}
