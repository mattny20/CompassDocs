// Helpdesk 1.20.6: the desk's event calendar (schema in
// lib/helpdesk/desk-calendar-schema, shapes and checks in
// desk-calendar-shared, iCalendar in desk-calendar-ics, reminders in
// desk-calendar-reminders, the private feed in desk-calendar-feed).
//
//   events      a ticket carries at most one event: start, end (or whole
//               days), a place, a setup lead time. Agents who work the
//               ticket add, change and remove it (the Event block in the
//               ticket's side panel; `event` on the API and the Claude
//               connector); each change leaves an agents-only timeline
//               line. A request type that "Goes on the calendar" fills the
//               event in from its form's answers when the request is raised;
//               a meeting invite sent to a help address fills it in from its
//               first VEVENT (lib/helpdesk/inbound).
//   setup       "Setup complete" (who and when) is set from the Event block,
//               the Calendar page, the "Before you solve" dialog, the API or
//               the connector. Until it is set the ticket cannot leave the
//               open statuses for solved or closed, and cannot go from solved
//               to closed, by any route: lib/helpdesk/tickets updateTicket
//               asks eventSetupOnCloseTx inside its transaction, the routes
//               that would write a reply first ask through
//               lib/helpdesk/solve-requirements (the event's setup is one
//               more thing a solve needs, refused with that module's
//               sentence and code, so every caller that already understands a
//               "Before you solve" refusal understands this one), and
//               retention's auto-close skips it (desk-calendar-schema EVENT_HOLDS_CLOSE_SQL). A
//               cancelled event blocks nothing. An event in the past whose
//               setup was never marked still blocks: Desk settings → Event
//               calendar lists those so someone can mark or remove them.
//   overlap     two events at the same place (compared trimmed and without
//               case) whose times overlap, setup time included, warn on the
//               ticket and on the calendar. Never a refusal. An event counts
//               until it is cancelled or its ticket is merged or binned (a
//               solved ticket's room is still booked).
//   calendar    /desk/calendar reads calendarData: the events of tickets the
//               viewer may see (their teams' and their own, as the queue),
//               and two optional layers: tickets' due times and the tickets
//               recurring schedules will open.
//
// Server-only.

import "server-only";
import { audit, type AuditActor } from "../audit";
import { getSetting, setSetting } from "../db";
import { logEvent } from "../log";
import { hq, hqOne, withTx, type HdQueryable } from "./db-core";
import { mdInline } from "./md-inline";
import { agentTeamIds } from "./access";
import { hoursForTeam } from "./calendars";
import { HD_OPEN_STATUSES, HD_STATUS_LABEL } from "./types";
import type { HdFormAnswers, HdFormField, HdStatus } from "./types";
import type { Role } from "../types";
import type { ParsedInvite } from "./desk-calendar-ics";
import {
  addDays,
  allDayInstants,
  CALENDAR_PREFS_DEFAULTS,
  checkCalendarSettings,
  checkEventInput,
  dayStart,
  daysBetween,
  EVENT_LIMITS,
  eventWhen,
  leadLabel,
  parseDay,
  placeKey,
  readyByLabel,
  resolveCalendarPrefs,
  resolveCalendarSettings,
  resolveRequestTypeCalendar,
  validZone,
  wallToInstant,
  zoneLabel,
  type HdCalendarData,
  type HdCalendarDue,
  type HdCalendarEvent,
  type HdCalendarLayer,
  type HdCalendarPrefs,
  type HdCalendarRecurring,
  type HdCalendarSettings,
  type HdEventConflict,
  type HdEventSource,
  type HdEventTimes,
  type HdTicketEvent,
  type HdTicketEventView,
} from "./desk-calendar-shared";

export * from "./desk-calendar-shared";

export class EventError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

type U = { id: number; role: Role };

/** Who made a change, and through what (as lib/helpdesk/tickets UpdateActor). */
export interface EventActor {
  id: number | null;
  name: string;
  via?: "mcp" | "api" | "claude_desk";
}

// --- Rows ---------------------------------------------------------------------------

const COLS = `e.ticket_id, e.starts_at, e.ends_at, e.all_day, to_char(e.start_date, 'YYYY-MM-DD') AS start_date,
  to_char(e.end_date, 'YYYY-MM-DD') AS end_date, e.timezone, e.place, e.place_key, e.setup_minutes, e.ready_at, e.setup_done_at,
  e.setup_done_by, e.setup_done_by_name, e.cancelled_at, e.source, e.ics_uid, e.ics_sequence, e.repeats, e.time_rev, e.updated_at`;

export interface EventRow {
  ticket_id: number;
  starts_at: string;
  ends_at: string;
  all_day: number;
  start_date: string | null;
  end_date: string | null;
  timezone: string;
  place: string;
  place_key: string;
  setup_minutes: number;
  ready_at: string;
  setup_done_at: string | null;
  setup_done_by: number | null;
  setup_done_by_name: string;
  cancelled_at: string | null;
  source: HdEventSource;
  ics_uid: string;
  ics_sequence: number;
  repeats: number;
  time_rev: number;
  updated_at: string;
}

export function toEvent(r: EventRow): HdTicketEvent {
  return {
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    all_day: r.all_day === 1,
    start_date: r.all_day === 1 ? r.start_date : null,
    end_date: r.all_day === 1 ? r.end_date : null,
    timezone: r.timezone,
    place: r.place,
    setup_minutes: r.setup_minutes,
    ready_at: r.ready_at,
    setup_complete: r.setup_done_at !== null,
    setup_completed_at: r.setup_done_at,
    setup_completed_by: r.setup_done_at ? r.setup_done_by_name || null : null,
    cancelled: r.cancelled_at !== null,
    cancelled_at: r.cancelled_at,
    source: r.source,
    repeats: r.repeats === 1,
  };
}

export async function eventRow(ticketId: number, client?: HdQueryable, lock = false): Promise<EventRow | undefined> {
  return hqOne<EventRow>(`SELECT ${COLS} FROM hd_ticket_events e WHERE e.ticket_id = $1${lock ? " FOR UPDATE" : ""}`, [ticketId], client);
}

/** The ticket's event, or null. */
export async function getTicketEvent(ticketId: number, client?: HdQueryable): Promise<HdTicketEvent | null> {
  const r = await eventRow(ticketId, client);
  return r ? toEvent(r) : null;
}

function timesOf(r: EventRow): HdEventTimes {
  return {
    starts_at: new Date(r.starts_at),
    ends_at: new Date(r.ends_at),
    all_day: r.all_day === 1,
    start_date: r.start_date,
    end_date: r.end_date,
    timezone: r.timezone,
    place: r.place,
    setup_minutes: r.setup_minutes,
  };
}

// --- Zones and words -----------------------------------------------------------------

/** The zone a signed-in person reads times in: their own, else the workspace's (as the desk's layout resolves it). */
export async function viewerZone(user: { timezone?: string } | null | undefined): Promise<string> {
  const own = (user?.timezone ?? "").trim();
  if (own && validZone(own)) return own;
  const { getAppSettings } = await import("../settings-store");
  const tz = (await getAppSettings()).timezone;
  return validZone(tz) ? tz : "UTC";
}

/** The zone a timeline line about this ticket's event is written in: its team's business calendar's. */
async function lineZone(teamId: number | null, client?: HdQueryable): Promise<string> {
  try {
    const tz = (await hoursForTeam(teamId, client)).timezone;
    return validZone(tz) ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

/** "Fri 20 Nov 2026, 14:00 to 15:30 (London time) at Boardroom A. Setup ready by 13:30 (30 minutes before)." */
function describe(e: HdTicketEvent, tz: string): string {
  // The line is Markdown: a bare "14:00" would read ":00" as a directive, so the times go through mdInline too.
  const when = mdInline(e.all_day ? eventWhen(e, tz) : `${eventWhen(e, tz)} (${zoneLabel(tz)})`);
  const place = e.place ? ` at ${mdInline(e.place)}` : "";
  const setup = e.setup_minutes > 0 ? ` Setup ready by ${mdInline(readyByLabel(e, tz))} (${leadLabel(e.setup_minutes)} before).` : "";
  return `${when}${place}.${setup}`;
}

const viaSuffix = (a: EventActor) => (a.via === "mcp" ? " via Claude" : a.via === "api" ? " via API" : a.via === "claude_desk" ? " via Claude in the desk" : "");

async function line(client: HdQueryable, ticketId: number, actor: EventActor, body: string, now: Date): Promise<void> {
  await client.query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at) VALUES ($1, $2, $3, 'internal', $4, 'system', $5)`,
    [ticketId, actor.id, actor.name, `${body}${viaSuffix(actor)}`, now]
  );
  await client.query("UPDATE hd_tickets SET updated_at = $2 WHERE id = $1", [ticketId, now]);
}

type TicketRef = { id: number; number: number; team_id: number | null; status: HdStatus; merged_into?: number | null };

/** May the event be changed? Not on a merged or closed ticket. (The caller already checked the person works it.) */
export function eventEditable(t: Pick<TicketRef, "status" | "merged_into">): boolean {
  return !t.merged_into && t.status !== "closed";
}

async function afterEventChange(ticketId: number, actor: EventActor, origin: string | undefined, setupCompleted = false): Promise<void> {
  try {
    const hooks = await import("./webhooks");
    await hooks.emitHelpdeskWebhookEvent("ticket.updated", { ticketId, changed: ["event"], actor: { id: actor.id, name: actor.name }, origin });
    if (setupCompleted) await hooks.emitHelpdeskWebhookEvent("event.setup_completed", { ticketId, actor: { id: actor.id, name: actor.name }, origin });
  } catch (e) {
    logEvent("error", "helpdesk.hook_failed", { step: "calendar.webhooks", error: e instanceof Error ? e.message : String(e) });
  }
}

/** After a commit that marked setup complete inside another module's transaction (lib/helpdesk/tickets updateTicket). */
export async function afterSetupCompleted(ticketId: number, actor: { id: number | null; name: string }, origin?: string): Promise<void> {
  await afterEventChange(ticketId, actor, origin, true);
}

// --- Writes -------------------------------------------------------------------------

export interface SetEventOptions {
  source?: HdEventSource;
  /** The zone whole days are counted in when the caller names none; default the ticket's team calendar's. */
  zone?: string;
  /** The meeting invite it came from (lib/helpdesk/inbound). */
  ics?: { uid: string; sequence: number; repeats: boolean };
  /** A sentence that opens the timeline line instead of "Ana added an event" ("Event added from the request"). */
  lead?: { added: string; changed: string };
  origin?: string;
  now?: Date;
}

/**
 * Add the ticket's event, or change it (left-out fields keep their value).
 * One transaction with the ticket's row locked, an agents-only timeline line,
 * then the ticket.updated webhook. A changed start, end or lead time re-arms
 * the reminders (time_rev) and, when the event had been cancelled, brings it
 * back. Throws EventError on bad input.
 */
export async function setTicketEvent(
  ticket: TicketRef,
  raw: unknown,
  actor: EventActor,
  opts: SetEventOptions = {}
): Promise<{ event: HdTicketEvent; created: boolean; changed: boolean }> {
  const now = opts.now ?? new Date();
  const tz = await lineZone(ticket.team_id);
  const zone = opts.zone && validZone(opts.zone) ? opts.zone : tz;
  const res = await withTx(async (client) => {
    const t = await hqOne<{ id: number; status: HdStatus; merged_into: number | null; deleted_at: string | null }>(
      "SELECT id, status, merged_into, deleted_at FROM hd_tickets WHERE id = $1 FOR UPDATE",
      [ticket.id],
      client
    );
    if (!t || t.deleted_at) throw new EventError("That ticket no longer exists.", 404);
    if (!eventEditable(t)) throw new EventError(t.merged_into ? "This ticket was merged into another. Change the event there." : "A closed ticket's event can't be changed.", 409);
    const before = await eventRow(ticket.id, client, true);
    const c = checkEventInput(raw, before ? timesOf(before) : null, zone);
    if (!c.ok) throw new EventError(c.error);
    const v = c.value;
    const ready = new Date(v.starts_at.getTime() - v.setup_minutes * 60_000);
    const who = mdInline(actor.name) || "Someone";
    if (!before) {
      await client.query(
        `INSERT INTO hd_ticket_events (ticket_id, starts_at, ends_at, all_day, start_date, end_date, timezone, place, place_key, setup_minutes, ready_at,
                                       source, ics_uid, ics_sequence, repeats, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)`,
        [ticket.id, v.starts_at, v.ends_at, v.all_day ? 1 : 0, v.start_date, v.end_date, v.timezone, v.place, placeKey(v.place), v.setup_minutes, ready,
         opts.source ?? "agent", opts.ics?.uid ?? "", opts.ics?.sequence ?? 0, opts.ics?.repeats ? 1 : 0, actor.id, now]
      );
      const row = (await eventRow(ticket.id, client))!;
      await line(client, ticket.id, actor, `${opts.lead?.added ?? `${who} added an event`}: ${describe(toEvent(row), tz)}`, now);
      return { row, created: true, changed: true };
    }
    const timeMoved =
      before.starts_at !== v.starts_at.toISOString() ||
      before.ends_at !== v.ends_at.toISOString() ||
      (before.all_day === 1) !== v.all_day ||
      before.setup_minutes !== v.setup_minutes ||
      (v.all_day && (before.start_date !== v.start_date || before.end_date !== v.end_date));
    const placeMoved = before.place !== v.place;
    const icsMoved = !!opts.ics && (before.ics_uid !== opts.ics.uid || before.ics_sequence !== opts.ics.sequence || (before.repeats === 1) !== opts.ics.repeats);
    const revived = before.cancelled_at !== null && (timeMoved || placeMoved || !!opts.ics);
    if (!timeMoved && !placeMoved && !icsMoved && !revived) return { row: before, created: false, changed: false };
    await client.query(
      `UPDATE hd_ticket_events
          SET starts_at = $2, ends_at = $3, all_day = $4, start_date = $5, end_date = $6, timezone = $7, place = $8, place_key = $9,
              setup_minutes = $10, ready_at = $11, time_rev = time_rev + $12, updated_at = $13,
              cancelled_at = CASE WHEN $14 THEN NULL ELSE cancelled_at END,
              ics_uid = COALESCE($15, ics_uid), ics_sequence = COALESCE($16, ics_sequence), repeats = COALESCE($17, repeats)
        WHERE ticket_id = $1`,
      [ticket.id, v.starts_at, v.ends_at, v.all_day ? 1 : 0, v.start_date, v.end_date, v.timezone, v.place, placeKey(v.place), v.setup_minutes, ready,
       timeMoved || revived ? 1 : 0, now, revived, opts.ics?.uid ?? null, opts.ics?.sequence ?? null, opts.ics ? (opts.ics.repeats ? 1 : 0) : null]
    );
    const row = (await eventRow(ticket.id, client))!;
    if (timeMoved || placeMoved || revived) {
      await line(client, ticket.id, actor, `${opts.lead?.changed ?? `${who} changed the event`}: ${describe(toEvent(row), tz)}`, now);
    }
    return { row, created: false, changed: true };
  });
  if (res.changed) await afterEventChange(ticket.id, actor, opts.origin);
  return { event: toEvent(res.row), created: res.created, changed: res.changed };
}

/** Take the event off the ticket. Its reminders' records go with it. False when there was none. */
export async function removeTicketEvent(ticket: TicketRef, actor: EventActor, opts: { origin?: string; now?: Date } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const tz = await lineZone(ticket.team_id);
  const removed = await withTx(async (client) => {
    const t = await hqOne<{ status: HdStatus; merged_into: number | null }>("SELECT status, merged_into FROM hd_tickets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [ticket.id], client);
    if (!t) throw new EventError("That ticket no longer exists.", 404);
    if (!eventEditable(t)) throw new EventError(t.merged_into ? "This ticket was merged into another. Change the event there." : "A closed ticket's event can't be changed.", 409);
    const before = await eventRow(ticket.id, client, true);
    if (!before) return false;
    await client.query("DELETE FROM hd_ticket_events WHERE ticket_id = $1", [ticket.id]);
    await client.query("DELETE FROM hd_event_reminders WHERE ticket_id = $1", [ticket.id]);
    await line(client, ticket.id, actor, `${mdInline(actor.name) || "Someone"} removed the event (${mdInline(eventWhen(toEvent(before), tz))})`, now);
    return true;
  });
  if (removed) await afterEventChange(ticket.id, actor, opts.origin);
  return removed;
}

/**
 * Mark the event's setup complete (who and when), or take the mark back.
 * Taking it back is for an open ticket only: a solved ticket was solved on
 * the strength of it. Nothing changes when it already says so.
 */
export async function setSetupComplete(
  ticket: TicketRef,
  complete: boolean,
  actor: EventActor,
  opts: { origin?: string; now?: Date } = {}
): Promise<{ event: HdTicketEvent; changed: boolean }> {
  const now = opts.now ?? new Date();
  const res = await withTx(async (client) => {
    const t = await hqOne<{ status: HdStatus; merged_into: number | null }>("SELECT status, merged_into FROM hd_tickets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [ticket.id], client);
    if (!t) throw new EventError("That ticket no longer exists.", 404);
    const before = await eventRow(ticket.id, client, true);
    if (!before) throw new EventError("This ticket has no event.", 404);
    if (t.merged_into) throw new EventError("This ticket was merged into another. Change the event there.", 409);
    if ((before.setup_done_at !== null) === complete) return { row: before, changed: false };
    if (complete && before.cancelled_at) throw new EventError("The event was cancelled, so there is no setup to mark.", 409);
    if (!complete && !HD_OPEN_STATUSES.includes(t.status)) throw new EventError("Reopen the ticket before you take back Setup complete.", 409);
    const who = mdInline(actor.name) || "Someone";
    if (complete) {
      await client.query("UPDATE hd_ticket_events SET setup_done_at = $2, setup_done_by = $3, setup_done_by_name = $4, updated_at = $2 WHERE ticket_id = $1", [ticket.id, now, actor.id, actor.name.slice(0, 200)]);
      await line(client, ticket.id, actor, `${who} marked the event setup complete`, now);
    } else {
      // The reminders start again for this revision: setup is open once more.
      await client.query("UPDATE hd_ticket_events SET setup_done_at = NULL, setup_done_by = NULL, setup_done_by_name = '', time_rev = time_rev + 1, updated_at = $2 WHERE ticket_id = $1", [ticket.id, now]);
      await line(client, ticket.id, actor, `${who} marked the event setup as not complete`, now);
    }
    return { row: (await eventRow(ticket.id, client))!, changed: true };
  });
  if (res.changed) await afterEventChange(ticket.id, actor, opts.origin, complete);
  return { event: toEvent(res.row), changed: res.changed };
}

/**
 * Mark the event cancelled (a meeting invite's cancellation, or by hand). It
 * stays on the ticket and the calendar, struck through; it blocks nothing and
 * is reminded of no more. `note` is the agents-only timeline line. False when
 * there is no event or it already was.
 */
export async function cancelTicketEvent(ticketId: number, actor: EventActor, note: string, opts: { origin?: string; now?: Date; ics?: { sequence: number } } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const done = await withTx(async (client) => {
    const before = await eventRow(ticketId, client, true);
    if (!before || before.cancelled_at) return false;
    await client.query("UPDATE hd_ticket_events SET cancelled_at = $2, updated_at = $2, ics_sequence = COALESCE($3, ics_sequence) WHERE ticket_id = $1", [ticketId, now, opts.ics?.sequence ?? null]);
    await line(client, ticketId, actor, note, now);
    return true;
  });
  if (done) await afterEventChange(ticketId, actor, opts.origin);
  return done;
}

// --- Not closed until setup is complete ----------------------------------------------

/** Is there an event on the ticket whose setup still holds it open (not cancelled, not marked complete)? One indexed read. */
export async function eventSetupOpen(ticketId: number, client?: HdQueryable): Promise<boolean> {
  return !!(await hqOne("SELECT 1 AS x FROM hd_ticket_events WHERE ticket_id = $1 AND cancelled_at IS NULL AND setup_done_at IS NULL", [ticketId], client));
}

/** The same, with the event (the "Before you solve" dialog names it). */
export async function openSetupEvent(ticketId: number, client?: HdQueryable): Promise<HdTicketEvent | null> {
  const r = await eventRow(ticketId, client);
  return r && !r.cancelled_at && !r.setup_done_at ? toEvent(r) : null;
}

/** Does moving `from` → `to` need the event's setup complete? Any move to solved or closed, solved → closed included. */
export function closesForEvent(from: string, to: string | null | undefined): boolean {
  return (to === "solved" || to === "closed") && from !== to && !(from === "closed" && to === "solved");
}

/**
 * lib/helpdesk/tickets updateTicket, inside its transaction, on a status
 * change. `open`: an event's setup still holds the ticket (the caller
 * refuses with the "Before you solve" sentence). With `complete` (the desk's
 * dialog ticked "Setup complete", the API sent event.setup_complete with the
 * solve) the mark is made here, in the solve's own transaction, so it is
 * kept only if the ticket is solved; `line` is its timeline line.
 */
export async function eventSetupOnCloseTx(
  client: HdQueryable,
  ticketId: number,
  from: HdStatus,
  to: HdStatus,
  opts: { complete: boolean; actor: { id: number | null; name: string }; now: Date }
): Promise<{ open: boolean; line: string | null; completed: boolean }> {
  if (!closesForEvent(from, to)) return { open: false, line: null, completed: false };
  const e = await hqOne<{ x: number }>("SELECT 1 AS x FROM hd_ticket_events WHERE ticket_id = $1 AND cancelled_at IS NULL AND setup_done_at IS NULL FOR UPDATE", [ticketId], client);
  if (!e) return { open: false, line: null, completed: false };
  if (!opts.complete) return { open: true, line: null, completed: false };
  await client.query("UPDATE hd_ticket_events SET setup_done_at = $2, setup_done_by = $3, setup_done_by_name = $4, updated_at = $2 WHERE ticket_id = $1", [ticketId, opts.now, opts.actor.id, opts.actor.name.slice(0, 200)]);
  return { open: false, line: `${mdInline(opts.actor.name) || "Someone"} marked the event setup complete`, completed: true };
}

/**
 * lib/helpdesk/engine, inside its transaction: a request closed because an
 * approval was declined. The event is not going to happen through this
 * request, so it is marked cancelled (it would otherwise hold a declined
 * request open for a setup nobody will do).
 */
export async function cancelEventForDeclineTx(client: HdQueryable, ticketId: number, now: Date): Promise<void> {
  const r = await client.query("UPDATE hd_ticket_events SET cancelled_at = $2, updated_at = $2 WHERE ticket_id = $1 AND cancelled_at IS NULL AND setup_done_at IS NULL", [ticketId, now]);
  if (r.rowCount) {
    await client.query(
      `INSERT INTO hd_messages (ticket_id, author_name, kind, body, via, created_at) VALUES ($1, 'Helpdesk', 'internal', $2, 'system', $3)`,
      [ticketId, "The event was cancelled because the request was declined.", now]
    );
  }
}

// --- Merge and retention --------------------------------------------------------------

/**
 * lib/helpdesk/merge, inside its transaction: the merged ticket's event
 * carries on on the kept ticket when that one has none. When the kept ticket
 * has its own, the merged ticket's stays where it is (a merged ticket's event
 * is on no calendar and blocks nothing). Answers whether it moved.
 */
export async function moveEventOnMergeTx(client: HdQueryable, fromId: number, toId: number): Promise<boolean> {
  const has = await hqOne("SELECT 1 AS x FROM hd_ticket_events WHERE ticket_id = $1", [toId], client);
  if (has) return false;
  const moved = await client.query("UPDATE hd_ticket_events SET ticket_id = $2, updated_at = now() WHERE ticket_id = $1", [fromId, toId]);
  if (!moved.rowCount) return false;
  await client.query("DELETE FROM hd_event_reminders WHERE ticket_id = $1", [fromId]);
  return true;
}

/** lib/helpdesk/retention anonymiseTicketTx: a place is free text and may name a person; the invite's id goes too. The times stay. */
export async function anonymiseEventTx(client: HdQueryable, ticketId: number): Promise<void> {
  await client.query("UPDATE hd_ticket_events SET place = '', place_key = '', ics_uid = '' WHERE ticket_id = $1", [ticketId]);
}

// --- Overlap ------------------------------------------------------------------------

interface ConflictRow extends EventRow {
  number: number;
  subject: string;
  team_id: number | null;
  team_name: string | null;
  assignee_id: number | null;
}

/** Other events at the same place whose time (setup included) overlaps this ticket's event. */
export async function eventConflicts(user: U, ticketId: number): Promise<HdEventConflict[]> {
  const e = await eventRow(ticketId);
  if (!e || !e.place_key || e.cancelled_at) return [];
  const rows = await hq<ConflictRow>(
    `SELECT ${COLS}, t.number, t.subject, t.team_id, tm.name AS team_name, t.assignee_id
       FROM hd_ticket_events e JOIN hd_tickets t ON t.id = e.ticket_id LEFT JOIN hd_teams tm ON tm.id = t.team_id
      WHERE e.place_key = $1 AND e.ticket_id <> $2 AND e.cancelled_at IS NULL AND t.deleted_at IS NULL AND t.merged_into IS NULL
        AND e.ready_at < $3 AND e.ends_at > $4
      ORDER BY e.starts_at, t.number LIMIT 10`,
    [e.place_key, ticketId, e.ends_at, e.ready_at]
  );
  if (!rows.length) return [];
  const teams = await agentTeamIds(user);
  return rows.map((r) => {
    const visible = teams === "all" || r.assignee_id === user.id || (r.team_id !== null && teams.includes(r.team_id));
    return {
      number: visible ? r.number : null,
      subject: visible ? r.subject : null,
      team_name: r.team_name,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      all_day: r.all_day === 1,
      start_date: r.all_day === 1 ? r.start_date : null,
      end_date: r.all_day === 1 ? r.end_date : null,
      place: r.place,
    };
  });
}

/** GET /api/helpdesk/tickets/[number]/event. */
export async function ticketEventView(user: U, ticket: TicketRef, canWork: boolean): Promise<HdTicketEventView> {
  const [event, conflicts, settings] = await Promise.all([getTicketEvent(ticket.id), eventConflicts(user, ticket.id), getCalendarSettings()]);
  return { event, conflicts, can_edit: canWork && eventEditable(ticket), default_setup_minutes: settings.default_setup_minutes };
}

/** Places used before on tickets the person may see, most recent first (the Event block's suggestions). */
export async function placeSuggestions(user: U, q: string): Promise<string[]> {
  const teams = await agentTeamIds(user);
  const params: unknown[] = [];
  const scope = scopeSql(teams, user.id, params);
  const needle = placeKey(q).slice(0, EVENT_LIMITS.place);
  params.push(`%${needle.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
  const rows = await hq<{ place: string }>(
    `SELECT (array_agg(e.place ORDER BY e.updated_at DESC))[1] AS place
       FROM hd_ticket_events e JOIN hd_tickets t ON t.id = e.ticket_id
      WHERE ${scope} AND e.place_key <> '' AND e.place_key LIKE $${params.length}
      GROUP BY e.place_key ORDER BY max(e.updated_at) DESC LIMIT 8`,
    params
  );
  return rows.map((r) => r.place);
}

// --- Settings and prefs ---------------------------------------------------------------

export const HD_CALENDAR_SETTINGS_KEY = "helpdesk_calendar";

export async function getCalendarSettings(): Promise<HdCalendarSettings> {
  const raw = await getSetting(HD_CALENDAR_SETTINGS_KEY);
  let stored: unknown = null;
  if (raw) {
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
  }
  return resolveCalendarSettings(stored);
}

/** Save the settings; answers what changed (for the audit row). Throws EventError on a bad value. */
export async function saveCalendarSettings(raw: unknown): Promise<{ settings: HdCalendarSettings; changed: (keyof HdCalendarSettings)[] }> {
  const before = await getCalendarSettings();
  const c = checkCalendarSettings(raw, before);
  if (!c.ok) throw new EventError(c.error);
  const changed = (Object.keys(c.value) as (keyof HdCalendarSettings)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(c.value[k]));
  if (changed.length) await setSetting(HD_CALENDAR_SETTINGS_KEY, JSON.stringify(c.value));
  return { settings: c.value, changed };
}

export async function getCalendarPrefs(userId: number): Promise<HdCalendarPrefs> {
  const r = await hqOne<{ prefs: unknown }>("SELECT prefs FROM hd_calendar_prefs WHERE user_id = $1", [userId]);
  return r ? resolveCalendarPrefs(r.prefs) : { ...CALENDAR_PREFS_DEFAULTS };
}

export async function saveCalendarPrefs(userId: number, raw: unknown): Promise<HdCalendarPrefs> {
  const base = await getCalendarPrefs(userId);
  const next = resolveCalendarPrefs({ ...base, ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) });
  await hq(
    `INSERT INTO hd_calendar_prefs (user_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
    [userId, JSON.stringify(next)]
  );
  return next;
}

// --- The Calendar page ----------------------------------------------------------------

/** The agent's scope, as lib/helpdesk/tickets scopeSql: their teams' tickets and the ones assigned to them; never a binned or merged one. */
function scopeSql(teams: number[] | "all", userId: number, params: unknown[]): string {
  if (teams === "all") return "(t.deleted_at IS NULL AND t.merged_into IS NULL)";
  params.push(teams, userId);
  return `(t.deleted_at IS NULL AND t.merged_into IS NULL AND (t.team_id = ANY($${params.length - 1}::int[]) OR t.assignee_id = $${params.length}))`;
}

const CAL_LIMIT = 500;

interface CalRow extends EventRow {
  number: number;
  subject: string;
  status: HdStatus;
  team_id: number | null;
  team_name: string | null;
  assignee_name: string | null;
  conflicts: { number: number; team_id: number | null; assignee_id: number | null }[] | null;
}

/**
 * What the Calendar page shows between two calendar days (inclusive) in the
 * viewer's zone: the events of tickets the viewer may see, and the layers
 * asked for. A timed event is in the range when it (or its setup block)
 * touches it; an all-day event when one of its days is in it.
 */
export async function calendarData(
  user: U,
  opts: { from: string; to: string; tz: string; teamId?: number; layers?: HdCalendarLayer[]; now?: Date }
): Promise<HdCalendarData> {
  if (!parseDay(opts.from) || !parseDay(opts.to)) throw new EventError("Give the range as from=YYYY-MM-DD&to=YYYY-MM-DD.");
  const span = daysBetween(opts.from, opts.to);
  if (span < 0) throw new EventError("The range ends before it starts.");
  if (span >= EVENT_LIMITS.rangeDays) throw new EventError(`Ask for at most ${EVENT_LIMITS.rangeDays} days at a time.`);
  const tz = validZone(opts.tz) ? opts.tz : "UTC";
  const now = opts.now ?? new Date();
  const fromAt = new Date(dayStart(opts.from, tz));
  const toAt = new Date(dayStart(addDays(opts.to, 1), tz));
  const teams = await agentTeamIds(user);
  const teamList = await hq<{ id: number; name: string }>(
    teams === "all" ? "SELECT id, name FROM hd_teams ORDER BY position, name, id" : "SELECT id, name FROM hd_teams WHERE id = ANY($1::int[]) ORDER BY position, name, id",
    teams === "all" ? [] : [teams]
  );
  const teamId = opts.teamId && teamList.some((t) => t.id === opts.teamId) ? opts.teamId : 0;
  const layers = opts.layers ?? [];
  const sees = (r: { team_id: number | null; assignee_id: number | null }) => teams === "all" || r.assignee_id === user.id || (r.team_id !== null && teams.includes(r.team_id));

  const params: unknown[] = [];
  const scope = scopeSql(teams, user.id, params);
  params.push(fromAt, toAt, opts.from, opts.to);
  const [pf, pt, df, dt] = [params.length - 3, params.length - 2, params.length - 1, params.length];
  let teamSql = "";
  if (teamId) {
    params.push(teamId);
    teamSql = ` AND t.team_id = $${params.length}`;
  }
  const rows = await hq<CalRow>(
    `SELECT ${COLS}, t.number, t.subject, t.status, t.team_id, tm.name AS team_name, NULLIF(COALESCE(NULLIF(a.name, ''), a.username), '') AS assignee_name,
            (SELECT json_agg(json_build_object('number', t2.number, 'team_id', t2.team_id, 'assignee_id', t2.assignee_id) ORDER BY t2.number)
               FROM hd_ticket_events o JOIN hd_tickets t2 ON t2.id = o.ticket_id
              WHERE e.place_key <> '' AND e.cancelled_at IS NULL AND o.place_key = e.place_key AND o.ticket_id <> e.ticket_id
                AND o.cancelled_at IS NULL AND t2.deleted_at IS NULL AND t2.merged_into IS NULL
                AND o.ready_at < e.ends_at AND o.ends_at > e.ready_at) AS conflicts
       FROM hd_ticket_events e JOIN hd_tickets t ON t.id = e.ticket_id
       LEFT JOIN hd_teams tm ON tm.id = t.team_id LEFT JOIN users a ON a.id = t.assignee_id
      WHERE ${scope}${teamSql}
        AND ((e.all_day = 1 AND e.start_date <= $${dt}::date AND e.end_date >= $${df}::date)
          OR (e.ready_at < $${pt} AND e.ends_at > $${pf}))
      ORDER BY e.starts_at, t.number LIMIT ${CAL_LIMIT + 1}`,
    params
  );
  let truncated = rows.length > CAL_LIMIT;
  const events: HdCalendarEvent[] = rows.slice(0, CAL_LIMIT).map((r) => ({
    number: r.number,
    subject: r.subject,
    status: r.status,
    status_label: HD_STATUS_LABEL[r.status] ?? r.status,
    team_id: r.team_id,
    team_name: r.team_name,
    assignee_name: r.assignee_name,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    all_day: r.all_day === 1,
    start_date: r.all_day === 1 ? r.start_date : null,
    end_date: r.all_day === 1 ? r.end_date : null,
    place: r.place,
    setup_minutes: r.setup_minutes,
    ready_at: r.ready_at,
    setup_complete: r.setup_done_at !== null,
    cancelled: r.cancelled_at !== null,
    repeats: r.repeats === 1,
    conflicts: (r.conflicts ?? []).slice(0, 10).map((c) => (sees(c) ? c.number : null)),
  }));

  let due: HdCalendarDue[] = [];
  if (layers.includes("due")) {
    const p: unknown[] = [];
    const sc = scopeSql(teams, user.id, p);
    p.push(fromAt, toAt);
    const [a, b] = [p.length - 1, p.length];
    let ts = "";
    if (teamId) {
      p.push(teamId);
      ts = ` AND t.team_id = $${p.length}`;
    }
    // The next target that is still running, as the queue's "due" sort reads it; a paused clock has no due time.
    const DUE = "(CASE WHEN t.first_replied_at IS NULL AND t.first_reply_due IS NOT NULL THEN t.first_reply_due ELSE t.resolve_due END)";
    const dueRows = await hq<{ number: number; subject: string; at: string; kind: "first_reply" | "resolve"; team_id: number | null; team_name: string | null; assignee_name: string | null }>(
      `SELECT t.number, t.subject, ${DUE} AS at,
              CASE WHEN t.first_replied_at IS NULL AND t.first_reply_due IS NOT NULL THEN 'first_reply' ELSE 'resolve' END AS kind,
              t.team_id, tm.name AS team_name, NULLIF(COALESCE(NULLIF(a.name, ''), a.username), '') AS assignee_name
         FROM hd_tickets t LEFT JOIN hd_teams tm ON tm.id = t.team_id LEFT JOIN users a ON a.id = t.assignee_id
        WHERE ${sc}${ts} AND t.status IN ('new', 'open', 'pending', 'on_hold') AND t.sla_paused_at IS NULL
          AND ${DUE} >= $${a} AND ${DUE} < $${b}
        ORDER BY at, t.number LIMIT ${CAL_LIMIT + 1}`,
      p
    );
    truncated = truncated || dueRows.length > CAL_LIMIT;
    due = dueRows.slice(0, CAL_LIMIT).map((r) => ({ ...r, overdue: new Date(r.at).getTime() < now.getTime() }));
  }

  let recurring: HdCalendarRecurring[] = [];
  if (layers.includes("recurring")) recurring = await recurringInRange(teams, teamId, Math.max(fromAt.getTime(), now.getTime()), toAt.getTime());

  return { timezone: tz, from: opts.from, to: opts.to, events, due, recurring, teams: teamList, truncated };
}

/** The tickets the recurring schedules of these teams will open in (after, before): each schedule's own next occurrences. */
async function recurringInRange(teams: number[] | "all", teamId: number, after: number, before: number): Promise<HdCalendarRecurring[]> {
  if (before <= after) return [];
  const { listRecurring } = await import("./recurring");
  const { nextOccurrences, occurrenceNote, scheduleTitle } = await import("./recurring-shared");
  const schedules = (await listRecurring(teams)).filter((s) => s.enabled && (!teamId || s.team_id === teamId)).slice(0, 200);
  const out: HdCalendarRecurring[] = [];
  for (const s of schedules) {
    let hours = null;
    try {
      hours = await hoursForTeam(s.team_id);
    } catch {
      hours = null;
    }
    // A schedule opens at most one ticket a day, so the range's length bounds the count.
    const count = Math.min(46, Math.ceil((before - after) / 86_400_000) + 1);
    const occ = nextOccurrences(s.pattern, { tz: s.timezone, rule: s.holiday_rule, hours, after: after - 1, count });
    for (const o of occ) {
      if (o.at >= before) break;
      out.push({ recurring_id: s.id, title: scheduleTitle(s.subject), at: new Date(o.at).toISOString(), team_id: s.team_id, team_name: s.team_name, note: occurrenceNote(o) });
      if (out.length >= CAL_LIMIT) return out.sort((a, b) => a.at.localeCompare(b.at));
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Events in the past whose setup was never marked complete (Desk settings →
 * Event calendar). They still hold their tickets open: someone marks the
 * setup, or removes the event.
 */
export async function setupOverdueList(now: Date = new Date()): Promise<{ number: number; subject: string; team_name: string | null; assignee_name: string | null; starts_at: string; ends_at: string; all_day: boolean; start_date: string | null; end_date: string | null; place: string; status: string }[]> {
  const rows = await hq<CalRow>(
    `SELECT ${COLS}, t.number, t.subject, t.status, t.team_id, tm.name AS team_name, NULLIF(COALESCE(NULLIF(a.name, ''), a.username), '') AS assignee_name, NULL::json AS conflicts
       FROM hd_ticket_events e JOIN hd_tickets t ON t.id = e.ticket_id
       LEFT JOIN hd_teams tm ON tm.id = t.team_id LEFT JOIN users a ON a.id = t.assignee_id
      WHERE e.cancelled_at IS NULL AND e.setup_done_at IS NULL AND e.ends_at < $1 AND t.deleted_at IS NULL AND t.merged_into IS NULL AND t.status <> 'closed'
      ORDER BY e.starts_at LIMIT 100`,
    [now]
  );
  return rows.map((r) => ({
    number: r.number,
    subject: r.subject,
    team_name: r.team_name,
    assignee_name: r.assignee_name,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    all_day: r.all_day === 1,
    start_date: r.all_day === 1 ? r.start_date : null,
    end_date: r.all_day === 1 ? r.end_date : null,
    place: r.place,
    status: HD_STATUS_LABEL[r.status] ?? r.status,
  }));
}

// --- Request types that go on the calendar ---------------------------------------------

/** lib/helpdesk/request-types, inside its transaction: store a request type's "Goes on the calendar". */
export async function writeRequestTypeCalendarTx(client: HdQueryable, id: number, calendar: unknown): Promise<void> {
  await client.query("UPDATE hd_request_types SET calendar = $2::jsonb WHERE id = $1", [id, JSON.stringify(resolveRequestTypeCalendar(calendar))]);
}

/** A form's answers → what setTicketEvent takes, or why not. Pure: the request hook and the tests share it. */
export function eventFromAnswers(
  calendar: unknown,
  form: HdFormField[],
  answers: HdFormAnswers,
  zone: string
): { input: Record<string, unknown>; note: string | null } | null {
  const cal = resolveRequestTypeCalendar(calendar);
  if (!cal.enabled || !cal.start_field) return null;
  const start = form.find((f) => f.key === cal.start_field);
  const raw = answers?.[cal.start_field];
  if (!start || typeof raw !== "string" || !raw) return null;
  const endRaw = cal.end_field ? answers?.[cal.end_field] : undefined;
  let place = "";
  if (cal.place_field) {
    const pf = form.find((f) => f.key === cal.place_field);
    const pv = answers?.[cal.place_field];
    if (pf && (typeof pv === "string" || typeof pv === "number")) place = (pf.options?.find((o) => o.value === String(pv))?.label ?? String(pv)).slice(0, EVENT_LIMITS.place);
  }
  let note: string | null = null;
  if (start.type === "date") {
    if (!parseDay(raw)) return null;
    let end = typeof endRaw === "string" && parseDay(endRaw) ? endRaw : raw;
    if (daysBetween(raw, end) < 0) {
      end = raw;
      note = "The last day given on the form is before the first, so the event is on the first day only. Check it.";
    } else if (daysBetween(raw, end) >= EVENT_LIMITS.maxDays) {
      end = addDays(raw, EVENT_LIMITS.maxDays - 1);
      note = `The dates given on the form are more than ${EVENT_LIMITS.maxDays} days apart, so the event stops after ${EVENT_LIMITS.maxDays} days. Check it.`;
    }
    return { input: { all_day: true, start_date: raw, end_date: end, timezone: zone, place, setup_minutes: cal.lead_minutes }, note };
  }
  const s = wallToInstant(raw, zone);
  if (s === null) return null;
  let e = typeof endRaw === "string" && endRaw ? wallToInstant(endRaw, zone) : null;
  if (e !== null && e <= s) {
    e = null;
    note = "The end given on the form is not after the start, so the event is one hour long. Check it.";
  } else if (e !== null && e - s > EVENT_LIMITS.maxDays * 86_400_000) {
    e = s + EVENT_LIMITS.maxDays * 86_400_000;
    note = `The times given on the form are more than ${EVENT_LIMITS.maxDays} days apart, so the event stops after ${EVENT_LIMITS.maxDays} days. Check it.`;
  }
  return { input: { starts_at: new Date(s).toISOString(), ends_at: new Date(e ?? s + 3_600_000).toISOString(), timezone: zone, place, setup_minutes: cal.lead_minutes }, note };
}

/**
 * lib/helpdesk/events afterTicketCreated: a request raised through a type
 * that goes on the calendar gets its event from the form's answers. A date
 * and time on the form is the requester's wall clock: it is read in their own
 * time zone (their account's, else the workspace's). Nothing happens when
 * the type is not on the calendar or the start was left empty.
 */
export async function eventFromRequestType(ticketId: number, ctx: { origin?: string } = {}): Promise<boolean> {
  const t = await hqOne<{ id: number; number: number; team_id: number | null; status: HdStatus; merged_into: number | null; form_answers: HdFormAnswers; requester_id: number | null; calendar: unknown; form: HdFormField[] }>(
    `SELECT t.id, t.number, t.team_id, t.status, t.merged_into, t.form_answers, t.requester_id, rt.calendar, rt.form
       FROM hd_tickets t JOIN hd_request_types rt ON rt.id = t.request_type_id WHERE t.id = $1`,
    [ticketId]
  );
  if (!t || !resolveRequestTypeCalendar(t.calendar).enabled) return false;
  if (await eventRow(ticketId)) return false;
  const requester = t.requester_id ? await hqOne<{ timezone: string }>("SELECT COALESCE(timezone, '') AS timezone FROM users WHERE id = $1", [t.requester_id]) : undefined;
  const zone = await viewerZone(requester);
  const built = eventFromAnswers(t.calendar, Array.isArray(t.form) ? t.form : [], t.form_answers ?? {}, zone);
  if (!built) return false;
  const system: EventActor = { id: null, name: "Helpdesk" };
  await setTicketEvent(t, built.input, system, { source: "request", zone, origin: ctx.origin, lead: { added: "Event added from the request", changed: "Event changed from the request" } });
  if (built.note) await (await import("./messages")).addSystemMessage(ticketId, built.note, { internal: true });
  return true;
}

// --- Meeting invites by email -----------------------------------------------------------


/**
 * The meeting invite an inbound email carries: its first calendar file (a
 * text/calendar part or an .ics attachment) that reads as an invite. Times
 * with no zone of their own are read in the desk's default calendar's zone.
 * The calendar files of an invite that was read are taken off the email, so
 * they are not listed as attachments that could not be added. Never throws.
 */
export async function inviteFromEmail(email: { files: { name: string; type: string; data: Buffer }[] }): Promise<ParsedInvite | null> {
  try {
    const { isCalendarFile, parseInvite, ICS_LIMITS } = await import("./desk-calendar-ics");
    const candidates = email.files.filter((f) => isCalendarFile(f));
    if (!candidates.length) return null;
    const zone = await lineZone(null);
    for (const f of candidates.slice(0, 3)) {
      if (!f.data || f.data.length === 0 || f.data.length > ICS_LIMITS.bytes) continue;
      const invite = parseInvite(f.data, zone);
      if (invite) {
        email.files = email.files.filter((x) => !isCalendarFile(x));
        return invite;
      }
    }
    return null;
  } catch (e) {
    logEvent("error", "helpdesk.invite_failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** The open ticket whose event came from the invite with this UID and whose requester is this sender; null when there is none. */
export async function ticketForInviteUid(uid: string, sender: { id: number | null; email: string }): Promise<number | null> {
  if (!uid) return null;
  const r = await hqOne<{ id: number }>(
    `SELECT t.id FROM hd_ticket_events e JOIN hd_tickets t ON t.id = e.ticket_id
      WHERE e.ics_uid = $1 AND t.deleted_at IS NULL AND t.merged_into IS NULL AND t.status <> 'closed'
        AND (($2::int IS NOT NULL AND t.requester_id = $2) OR ($2::int IS NULL AND t.requester_id IS NULL AND lower(t.requester_email) = lower($3)))
      ORDER BY t.id DESC LIMIT 1`,
    [uid.slice(0, 255), sender.id, sender.email]
  );
  return r?.id ?? null;
}

/**
 * lib/helpdesk/inbound, after the email became a ticket or a message on one:
 * act on the invite it carried.
 *   request   the ticket has no event: the event is filled in. It has the
 *             event of this same meeting (the same UID): it is updated,
 *             unless the invite is older than what the ticket has (a lower
 *             SEQUENCE). It has another event: nothing changes, and a note
 *             says the email carried a different invite.
 *   cancel    the same meeting's event is marked cancelled with an
 *             agents-only note; the ticket stays open. A cancellation for
 *             another meeting changes nothing.
 * Never throws: a failing invite must not fail the email.
 */
export async function applyInviteToTicket(ticketId: number, invite: ParsedInvite, from: { name: string }, ctx: { origin?: string } = {}): Promise<"added" | "updated" | "cancelled" | "ignored"> {
  try {
    const t = await hqOne<TicketRef & { deleted_at: string | null }>("SELECT id, number, team_id, status, merged_into, deleted_at FROM hd_tickets WHERE id = $1", [ticketId]);
    if (!t || t.deleted_at || !eventEditable(t)) return "ignored";
    const system: EventActor = { id: null, name: "Helpdesk" };
    const { addSystemMessage } = await import("./messages");
    const before = await eventRow(ticketId);
    const sameMeeting = !!before && !!invite.uid && before.ics_uid === invite.uid;
    const sender = mdInline(from.name) || "the sender";
    if (invite.method === "cancel") {
      if (!before || !sameMeeting) return "ignored";
      if (invite.sequence < before.ics_sequence) return "ignored";
      const done = await cancelTicketEvent(ticketId, system, `The meeting was cancelled by ${sender} (a cancellation came by email). The event is marked cancelled and no longer holds this ticket open. The ticket was not closed.`, { origin: ctx.origin, ics: { sequence: invite.sequence } });
      return done ? "cancelled" : "ignored";
    }
    if (before && !sameMeeting) {
      await addSystemMessage(ticketId, "This email carried a meeting invite for a different meeting. The ticket's event was not changed.", { internal: true });
      return "ignored";
    }
    if (before && invite.sequence < before.ics_sequence) return "ignored";
    const input = invite.all_day
      ? { all_day: true, start_date: invite.start_date, end_date: invite.end_date, timezone: invite.timezone, place: invite.location }
      : { starts_at: new Date(invite.starts_at).toISOString(), ends_at: new Date(invite.ends_at).toISOString(), timezone: invite.timezone, place: invite.location };
    const settings = before ? null : await getCalendarSettings();
    const r = await setTicketEvent(t, settings ? { ...input, setup_minutes: settings.default_setup_minutes } : input, system, {
      source: "invite",
      zone: invite.timezone,
      ics: { uid: invite.uid, sequence: invite.sequence, repeats: invite.repeats },
      origin: ctx.origin,
      lead: { added: `Event added from the meeting invite ${sender} sent`, changed: `Event updated from the meeting invite ${sender} sent` },
    });
    const notes = [...invite.notes];
    if (invite.repeats && r.created) notes.push("The invite is for a meeting that repeats. Only its first date is on the calendar: add the other dates as tickets of their own if they need setting up.");
    for (const n of notes.slice(0, 4)) await addSystemMessage(ticketId, n, { internal: true });
    return r.created ? "added" : r.changed ? "updated" : "ignored";
  } catch (e) {
    logEvent("error", "helpdesk.invite_failed", { ticket_id: ticketId, error: e instanceof Error ? e.message : String(e) });
    return "ignored";
  }
}

// --- What integrations read -------------------------------------------------------------

/** The event as the API, webhooks and the Claude connector carry it: `event` on a ticket; null when it has none. */
export function eventOut(e: HdTicketEvent | null) {
  if (!e) return null;
  return {
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    all_day: e.all_day,
    ...(e.all_day ? { start_date: e.start_date, end_date: e.end_date } : {}),
    timezone: e.timezone,
    place: e.place || null,
    setup_minutes: e.setup_minutes,
    ready_by: e.ready_at,
    setup_complete: e.setup_complete,
    setup_completed_at: e.setup_completed_at,
    setup_completed_by: e.setup_completed_by,
    cancelled: e.cancelled,
    ...(e.repeats ? { repeats: true } : {}),
  };
}

/** `event` for a ticket id (API v1, webhooks, hd_read_ticket). Never throws: null when it cannot be read. */
export async function ticketEventOut(ticketId: number): Promise<ReturnType<typeof eventOut>> {
  try {
    return eventOut(await getTicketEvent(ticketId));
  } catch {
    return null;
  }
}

/**
 * `event` in a PATCH body (API v1) or a tool call (hd_update_ticket): null
 * removes the event; an object sets or changes it, and `setup_complete`
 * (true or false) marks the setup. Returns what was done. With
 * `deferSetup`, a `setup_complete: true` is not applied here: the caller
 * sends it with a status change so both are saved together.
 */
export async function applyEventPatch(
  ticket: TicketRef,
  raw: unknown,
  actor: EventActor,
  opts: { origin?: string; deferSetup?: boolean } = {}
): Promise<{ changed: boolean; setupDeferred: boolean }> {
  if (raw === null) return { changed: await removeTicketEvent(ticket, actor, opts), setupDeferred: false };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new EventError("Send event as an object, or null to remove it.");
  const { setup_complete: setup, ...rest } = raw as Record<string, unknown>;
  if (setup !== undefined && typeof setup !== "boolean") throw new EventError("setup_complete is true or false.");
  const allowed = new Set(["starts_at", "ends_at", "all_day", "start_date", "end_date", "timezone", "place", "setup_minutes"]);
  const unknown = Object.keys(rest).filter((k) => !allowed.has(k));
  if (unknown.length) throw new EventError(`An event has starts_at, ends_at, all_day, start_date, end_date, timezone, place, setup_minutes and setup_complete (not ${unknown.join(", ")}).`);
  let changed = false;
  if (Object.keys(rest).length) changed = (await setTicketEvent(ticket, rest, actor, { origin: opts.origin, source: actor.via === "api" || actor.via === "mcp" ? "api" : "agent" })).changed;
  else if (setup === undefined) throw new EventError("Say what to change on the event.");
  if (setup === true && opts.deferSetup) {
    if (!(await eventRow(ticket.id))) throw new EventError("This ticket has no event.", 404);
    return { changed, setupDeferred: true };
  }
  if (setup !== undefined) changed = (await setSetupComplete(ticket, setup, actor, opts)).changed || changed;
  return { changed, setupDeferred: false };
}

/** Audit a settings change (Desk settings → Event calendar). */
export async function auditCalendarSettings(actor: AuditActor, changed: string[], settings: HdCalendarSettings, ip: string | null): Promise<void> {
  await audit({
    actor,
    action: "helpdesk.calendar.settings_updated",
    targetType: "helpdesk_settings",
    targetLabel: "Event calendar",
    details: { changed, reminder_minutes: settings.reminder_minutes, late_reminder: settings.late_reminder, recipients: settings.recipients, chat: settings.chat, default_setup_minutes: settings.default_setup_minutes },
    ip,
  });
}

/** The instants of whole days, for callers that hold only the dates. */
export { allDayInstants };
