// Helpdesk 1.19.1: time tracking on tickets (agent V8). Agents log time by
// hand or with a timer; each entry is minutes, a note and when it counts.
// Agents only: no requester route ever reads these tables.
//
//   Timer      one per agent (hd_timers keyed by user_id). Starting it on
//              another ticket stops the running one first and logs its
//              time there, in one transaction. Stopping logs the elapsed
//              minutes (at least 1, at most 24 hours) as a 'timer' entry.
//   Entries    anyone who can work the ticket logs time; people edit and
//              delete their own, and a team lead (agents.manage_team in
//              the ticket's team; teams.manage for every team) edits the
//              team's.
//   Reports    the measures "Time logged" and "Time per ticket" in K's
//              analytics registry (analytics/shared + engine), and the CSV
//              export below, for people with tickets.export, in their
//              queue scope (every team, or their teams plus their own).
//
// Server-only.

import "server-only";
import { csvCell } from "../csv";
import { hq, hqOne, withTx } from "./db-core";
import { agentTeamIds, canWorkTicket } from "./access";
import { hdCan } from "./roles";
import type { SessionUser } from "../types";
import type { HdTicket } from "./types";
import { TIME_LIMITS, type HdTimeEntry, type HdTicketTime, type HdTimer } from "./time-shared";

const MAX_TIMER_MINUTES = TIME_LIMITS.maxMinutes;

interface EntryRow {
  id: number;
  ticket_id: number;
  user_id: number | null;
  user_name: string | null;
  minutes: number;
  note: string;
  started_at: string | null;
  logged_at: string;
  source: string;
  team_id: number | null;
}

const ENTRY_SELECT = `SELECT e.id, e.ticket_id, e.user_id, COALESCE(NULLIF(u.name, ''), u.username) AS user_name, e.minutes, e.note,
       e.started_at, e.logged_at, e.source, t.team_id
  FROM hd_time_entries e JOIN hd_tickets t ON t.id = e.ticket_id LEFT JOIN users u ON u.id = e.user_id`;

/** May this person change this entry: their own (on a ticket they can work), or as a lead of the ticket's team. */
export async function canEditTimeEntry(user: SessionUser, e: Pick<EntryRow, "user_id" | "team_id" | "ticket_id">): Promise<boolean> {
  if (e.team_id != null && (await hdCan(user, "agents.manage_team", { teamId: e.team_id }))) return true;
  if (e.team_id == null && (await hdCan(user, "teams.manage"))) return true;
  if (e.user_id !== user.id) return false;
  const t = await hqOne<{ id: number; requester_id: number | null; team_id: number | null; assignee_id: number | null }>(
    "SELECT id, requester_id, team_id, assignee_id FROM hd_tickets WHERE id = $1",
    [e.ticket_id]
  );
  return !!t && (await canWorkTicket(user, t));
}

function toEntry(r: EntryRow, canEdit: boolean): HdTimeEntry {
  return {
    id: r.id,
    ticket_id: r.ticket_id,
    user_id: r.user_id,
    user_name: r.user_name ?? "Former agent",
    minutes: r.minutes,
    note: r.note,
    started_at: r.started_at,
    logged_at: r.logged_at,
    source: r.source === "timer" ? "timer" : "manual",
    can_edit: canEdit,
  };
}

export async function getTimeEntry(id: number): Promise<EntryRow | undefined> {
  // 1.19.4 (C7): a binned ticket's time is read-only (its routes answer 404 until it is restored).
  return hqOne<EntryRow>(`${ENTRY_SELECT} WHERE e.id = $1 AND t.deleted_at IS NULL`, [id]);
}

/** The viewer's running timer, wherever it is. */
export async function getTimer(userId: number): Promise<HdTimer | null> {
  const r = await hqOne<{ ticket_id: number; ticket_number: number; started_at: string }>(
    "SELECT tm.ticket_id, t.number AS ticket_number, tm.started_at FROM hd_timers tm JOIN hd_tickets t ON t.id = tm.ticket_id WHERE tm.user_id = $1",
    [userId]
  );
  return r ?? null;
}

/** A ticket's time for an agent who can work it: entries (newest first), the total, the viewer's timer, the team's ask-on-solve setting. */
export async function ticketTime(user: SessionUser, ticket: Pick<HdTicket, "id" | "team_id">): Promise<HdTicketTime> {
  const [rows, timer, team] = await Promise.all([
    hq<EntryRow>(`${ENTRY_SELECT} WHERE e.ticket_id = $1 ORDER BY e.logged_at DESC, e.id DESC`, [ticket.id]),
    getTimer(user.id),
    ticket.team_id ? hqOne<{ ask_time_on_solve: number }>("SELECT ask_time_on_solve FROM hd_teams WHERE id = $1", [ticket.team_id]) : Promise.resolve(undefined),
  ]);
  const lead = ticket.team_id != null ? await hdCan(user, "agents.manage_team", { teamId: ticket.team_id }) : await hdCan(user, "teams.manage");
  return {
    entries: rows.map((r) => toEntry(r, lead || r.user_id === user.id)),
    total_minutes: rows.reduce((s, r) => s + r.minutes, 0),
    timer,
    ask_on_solve: team?.ask_time_on_solve === 1,
  };
}

export class TimeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Minutes from a request body: a whole number from 1 to 24 hours. */
export function cleanMinutes(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= TIME_LIMITS.maxMinutes ? v : null;
}

/** A note from a request body: trimmed, at most TIME_LIMITS.note characters; null when invalid. */
export function cleanNote(v: unknown): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length <= TIME_LIMITS.note ? s : null;
}

/** Log time by hand. */
export async function logTime(userId: number, ticketId: number, minutes: number, note: string, loggedAt?: Date): Promise<EntryRow> {
  const r = await hqOne<{ id: number }>(
    "INSERT INTO hd_time_entries (ticket_id, user_id, minutes, note, logged_at, source) VALUES ($1, $2, $3, $4, COALESCE($5, now()), 'manual') RETURNING id",
    [ticketId, userId, minutes, note, loggedAt ?? null]
  );
  return (await getTimeEntry(r!.id))!;
}

function elapsedMinutes(startedAt: string | Date, now: number): number {
  const ms = Math.max(0, now - new Date(startedAt).getTime());
  return Math.min(MAX_TIMER_MINUTES, Math.max(1, Math.round(ms / 60_000)));
}

export interface TimerResult {
  timer: HdTimer | null;
  /** The entry a stop (or a start elsewhere) logged. */
  logged: (EntryRow & { ticket_number: number }) | null;
}

/**
 * Start the agent's timer on a ticket. Already running there: unchanged.
 * Running on another ticket: stopped and logged there first.
 */
export async function startTimer(userId: number, ticketId: number, now = Date.now()): Promise<TimerResult> {
  const loggedId = await withTx(async (c) => {
    // Serialise this agent's timer writes (two tabs clicking Start at once).
    await c.query("SELECT pg_advisory_xact_lock(hashtext('hd_timer:' || $1::text))", [userId]);
    const cur = (await c.query<{ ticket_id: number; started_at: Date }>("SELECT ticket_id, started_at FROM hd_timers WHERE user_id = $1", [userId])).rows[0];
    if (cur?.ticket_id === ticketId) return null;
    let id: number | null = null;
    if (cur) {
      const r = await c.query<{ id: number }>(
        "INSERT INTO hd_time_entries (ticket_id, user_id, minutes, note, started_at, logged_at, source) VALUES ($1, $2, $3, '', $4, $5, 'timer') RETURNING id",
        [cur.ticket_id, userId, elapsedMinutes(cur.started_at, now), cur.started_at, new Date(now)]
      );
      id = r.rows[0].id;
    }
    await c.query(
      `INSERT INTO hd_timers (user_id, ticket_id, started_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET ticket_id = EXCLUDED.ticket_id, started_at = EXCLUDED.started_at`,
      [userId, ticketId, new Date(now)]
    );
    return id;
  });
  return { timer: await getTimer(userId), logged: loggedId ? await entryWithNumber(loggedId) : null };
}

/** Stop the agent's timer (only when it runs on `ticketId`, if given) and log the time with `note`. */
export async function stopTimer(userId: number, opts: { ticketId?: number; note?: string } = {}, now = Date.now()): Promise<TimerResult> {
  const loggedId = await withTx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('hd_timer:' || $1::text))", [userId]);
    const cur = (
      await c.query<{ ticket_id: number; started_at: Date }>("DELETE FROM hd_timers WHERE user_id = $1 AND ($2::int IS NULL OR ticket_id = $2) RETURNING ticket_id, started_at", [
        userId,
        opts.ticketId ?? null,
      ])
    ).rows[0];
    if (!cur) return null;
    const r = await c.query<{ id: number }>(
      "INSERT INTO hd_time_entries (ticket_id, user_id, minutes, note, started_at, logged_at, source) VALUES ($1, $2, $3, $4, $5, $6, 'timer') RETURNING id",
      [cur.ticket_id, userId, elapsedMinutes(cur.started_at, now), opts.note ?? "", cur.started_at, new Date(now)]
    );
    return r.rows[0].id;
  });
  return { timer: null, logged: loggedId ? await entryWithNumber(loggedId) : null };
}

async function entryWithNumber(id: number): Promise<(EntryRow & { ticket_number: number }) | null> {
  const r = await hqOne<EntryRow & { ticket_number: number }>(
    `SELECT e.id, e.ticket_id, e.user_id, COALESCE(NULLIF(u.name, ''), u.username) AS user_name, e.minutes, e.note, e.started_at, e.logged_at, e.source,
            t.team_id, t.number AS ticket_number
       FROM hd_time_entries e JOIN hd_tickets t ON t.id = e.ticket_id LEFT JOIN users u ON u.id = e.user_id WHERE e.id = $1`,
    [id]
  );
  return r ?? null;
}

export async function updateTimeEntry(id: number, patch: { minutes?: number; note?: string }): Promise<EntryRow | undefined> {
  await hq(
    "UPDATE hd_time_entries SET minutes = COALESCE($2, minutes), note = COALESCE($3, note), updated_at = now() WHERE id = $1",
    [id, patch.minutes ?? null, patch.note ?? null]
  );
  return getTimeEntry(id);
}

export async function deleteTimeEntry(id: number): Promise<void> {
  await hq("DELETE FROM hd_time_entries WHERE id = $1", [id]);
}

// --- Team setting ---------------------------------------------------------------------------------

export async function setAskTimeOnSolve(teamId: number, on: boolean): Promise<boolean> {
  const r = await hqOne<{ id: number }>("UPDATE hd_teams SET ask_time_on_solve = $2 WHERE id = $1 RETURNING id", [teamId, on ? 1 : 0]);
  return !!r;
}

export async function getAskTimeOnSolve(teamId: number): Promise<boolean | undefined> {
  const r = await hqOne<{ ask_time_on_solve: number }>("SELECT ask_time_on_solve FROM hd_teams WHERE id = $1", [teamId]);
  return r ? r.ask_time_on_solve === 1 : undefined;
}

// --- Export ---------------------------------------------------------------------------------------------

export interface TimeExportFilters {
  /** YYYY-MM-DD in the helpdesk zone, inclusive. */
  from?: string;
  to?: string;
  team?: number[];
  agent?: number[];
  request_type?: number[];
  category?: string[];
}

export const TIME_EXPORT_MAX_ROWS = 50_000;

/**
 * The entries this person may export, as CSV: their queue scope (every
 * team, or their teams' tickets, tickets assigned to them and their own
 * entries). Newest first, capped at TIME_EXPORT_MAX_ROWS.
 */
export async function exportTimeCsv(user: SessionUser, f: TimeExportFilters, tz: string): Promise<{ csv: string; rows: number }> {
  const params: unknown[] = [tz];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  // 1.19.4 (C7): never a ticket in the recycle bin.
  const where: string[] = ["t.deleted_at IS NULL"];
  const scope = await agentTeamIds(user);
  if (scope !== "all") {
    const me = bind(user.id);
    where.push(`(t.team_id = ANY(${bind(scope)}::int[]) OR t.assignee_id = ${me} OR e.user_id = ${me})`);
  }
  if (f.from) where.push(`e.logged_at >= (${bind(f.from)}::date)::timestamp AT TIME ZONE $1`);
  if (f.to) where.push(`e.logged_at < ((${bind(f.to)}::date + 1)::timestamp AT TIME ZONE $1)`);
  if (f.team?.length) where.push(`t.team_id = ANY(${bind(f.team)}::int[])`);
  if (f.agent?.length) where.push(`e.user_id = ANY(${bind(f.agent)}::int[])`);
  if (f.request_type?.length) where.push(`t.request_type_id = ANY(${bind(f.request_type)}::int[])`);
  if (f.category?.length) where.push(`COALESCE(t.category, '') = ANY(${bind(f.category)}::text[])`);
  const rows = await hq<{
    logged: string;
    number: number;
    subject: string;
    team: string | null;
    request_type: string | null;
    category: string;
    agent: string | null;
    minutes: number;
    note: string;
    source: string;
  }>(
    `SELECT to_char(e.logged_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS logged, t.number, t.subject, tm.name AS team, rt.title AS request_type,
            COALESCE(t.category, '') AS category, COALESCE(NULLIF(u.name, ''), u.username) AS agent, e.minutes, e.note, e.source
       FROM hd_time_entries e JOIN hd_tickets t ON t.id = e.ticket_id
       LEFT JOIN hd_teams tm ON tm.id = t.team_id LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id LEFT JOIN users u ON u.id = e.user_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.logged_at DESC, e.id DESC LIMIT ${TIME_EXPORT_MAX_ROWS}`,
    params
  );
  const line = (cells: unknown[]) => cells.map((c) => (typeof c === "number" && Number.isFinite(c) ? String(c) : csvCell(c))).join(",");
  const out = [line(["Logged", "Ticket", "Subject", "Team", "Request type", "Category", "Agent", "Minutes", "Hours", "Note", "Source"])];
  for (const r of rows) {
    out.push(
      line([r.logged, r.number, r.subject, r.team ?? "", r.request_type ?? "", r.category, r.agent ?? "Former agent", r.minutes, Math.round((r.minutes / 60) * 100) / 100, r.note, r.source === "timer" ? "Timer" : "Manual"])
    );
  }
  return { csv: `${out.join("\r\n")}\r\n`, rows: rows.length };
}

// --- Audit ----------------------------------------------------------------------------------------------

export type TimeAuditAction = "helpdesk.time.logged" | "helpdesk.time.edited" | "helpdesk.time.deleted" | "helpdesk.time.exported";

export async function auditTime(
  req: Request,
  user: SessionUser,
  action: TimeAuditAction,
  target: { type: "helpdesk_ticket" | "helpdesk_time"; id?: number; label?: string },
  details: Record<string, unknown>
): Promise<void> {
  const { audit, actorFrom, ipFrom } = await import("../audit");
  await audit({ actor: actorFrom(user), action, targetType: target.type, targetId: target.id, targetLabel: target.label, details, ip: ipFrom(req) });
}
