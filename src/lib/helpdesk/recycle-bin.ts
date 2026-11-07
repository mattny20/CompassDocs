// Helpdesk 1.19.4 (area C7, mock-ups v1-v4): the recycle bin for deleted
// tickets. Schema in ./recycle-bin-schema, shapes in ./recycle-bin-shared.
//
//   Bin       "Delete ticket…" (one) or the bulk bar's Delete (up to
//             BIN_BULK_MAX) sets hd_tickets.deleted_at / deleted_by /
//             deleted_by_name. Each ticket is checked on its own: the agent
//             works it and holds tickets.delete in its team (team-scoped,
//             lifted by tickets.view_all, like every ticket change); a
//             ticket on legal hold stays (with the reason). An open major
//             incident's own ticket ends the incident in the same
//             transaction (its Status page incident after the commit), as a
//             delete did in 1.19.2. A workflow request's open task tickets
//             go with it only when the agent could delete each one too;
//             the others stay, and the result says which (a task left
//             behind keeps its own queue). A system delete (retention)
//             never takes tasks: it bins only what its own rule selected.
//             An agent-only timeline line records it, and unsent digest
//             items about it are dropped. Nothing else changes: status,
//             owner, SLA dues and history stay as they were.
//   Hidden    A binned ticket is not found by getTicketById/ByNumber/Row
//             (lib/helpdesk/tickets), so every route, Claude connector tool,
//             portal and Get help page answers 404, and inbound email that
//             replies to it opens a new ticket (lib/helpdesk/inbound). The
//             queues, counts, search, reports, approvals, assignment, SLA,
//             auto-close, workflow and reminder sweeps all read
//             `deleted_at IS NULL`; notify.loadTicket, sendHelpdeskTemplate
//             and deliverAgentNotification refuse to send about one
//             (./recycle-bin-guard).
//   Workflow  A binned request's run is held: lib/helpdesk/engine advanceRun
//             drives nothing for it (no task tickets, approvals or waits);
//             a restore advances it at once; a purge deletes it with the
//             request. A task can't be restored on its own while its
//             request is in the bin.
//   Restore   tickets.delete again. Clears the columns and puts it back as it
//             was (updated_at unchanged, so it sorts where it did). The SLA
//             clocks of an open ticket that was running are shifted by the
//             time in the bin, the same way a pending → open resume shifts
//             them (business time banked; an already-missed due stays
//             missed); a ticket that was pending or on hold keeps its pause.
//             What resumes: the SLA clocks (as above), auto-close (counts
//             from solved_at as before, so a solved ticket past its
//             auto-close days closes at the next nightly run), workflow
//             waits and task dues (a wait that came due while binned
//             fires at the next minute's sweep), approval reminders,
//             assignment retries and notifications for whatever happens
//             next. Nothing missed while binned is sent afterwards.
//   Purge     tickets.purge ("Delete for good", Admin by default) from the
//             bin, or the daily purge sweep for tickets binned BIN_DAYS ago
//             (the database's clock), through retention's deleteTicketTx
//             (rows cascade; files removed after the commit), skipping a
//             ticket placed on legal hold while binned.
//   Audit     helpdesk.ticket.binned / restored / purged per ticket (the
//             label keeps "#N subject" after the purge), plus
//             helpdesk.ticket.bulk_binned / bulk_restored / bulk_purged for
//             a bulk request and helpdesk.ticket.purged_by_sweep per sweep.
//
//   Webhooks  ticket.deleted / ticket.restored (C2's lib/helpdesk/webhooks)
//             after each bin or restore commits, once per ticket (task
//             tickets that went or came back with it included); retention's
//             delete emits ticket.deleted too. A purge emits nothing: the
//             receiver already had ticket.deleted.
//
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { audit, actorFrom } from "../audit";
import type { AuditActor } from "../audit";
import { claimPeriod } from "../db";
import { logEvent } from "../log";
import type { SessionUser } from "../types";
import { hq, hqOne, withTx } from "./db-core";
import { mdInline } from "./md-inline";
import { agentTeamIds, canWorkTicket } from "./access";
import { hdCan } from "./roles";
import { deleteFiles, deleteTicketTx } from "./retention";
import { getTicketByNumber, getTicketIncludingBinned } from "./tickets";
import { HD_OPEN_STATUSES } from "./types";
import type { HdTicket, HdTicketRow } from "./types";
import { BIN_BULK_MAX, BIN_DAYS, binDaysLeft, binPurgeAt } from "./recycle-bin-shared";
import { TIME_LIMITS } from "./time-shared";
import type { HdBinnedInfo, HdBinResult, HdBinRow } from "./recycle-bin-shared";

export { BIN_BULK_MAX, BIN_DAYS };

/**
 * The purge sweep's advisory lock (one instance purges at a time). Listed
 * with the other helpdesk lock keys in lib/helpdesk/recurring.
 */
export const BIN_PURGE_LOCK = 7_281_947;
const BATCH = 200;

type User = Pick<SessionUser, "id" | "role" | "name" | "username">;
/** Who binned, restored or purged: a person, or a system actor (id null). */
export interface BinActor {
  id: number | null;
  name: string;
}

export class HdBinError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function actorOf(user: User): BinActor {
  return { id: user.id, name: user.name || user.username };
}

/** Ticket numbers from a body: 1 to BIN_BULK_MAX, distinct, positive integers. Throws HdBinError(400). */
export function parseBinNumbers(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new HdBinError("Choose at least one ticket.");
  if (raw.length > BIN_BULK_MAX) throw new HdBinError(`Up to ${BIN_BULK_MAX} tickets at a time.`);
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) throw new HdBinError("Ticket numbers only, like 1051.");
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

const NOT_FOUND = "Not found in your queues.";

/** C2's webhook events (lib/helpdesk/webhooks), after the commit. Never throws. */
export async function emitBinEvents(event: "ticket.deleted" | "ticket.restored", ticketIds: number[], actor: BinActor, origin?: string): Promise<void> {
  try {
    const { emitHelpdeskWebhookEvent } = await import("./webhooks");
    for (const ticketId of ticketIds) await emitHelpdeskWebhookEvent(event, { ticketId, actor: { id: actor.id, name: actor.name }, origin });
  } catch (e) {
    console.error("[helpdesk] recycle bin webhook:", e);
  }
}

/** hd_tickets.legal_hold (lib/helpdesk/retention-schema), read off the row. */
function onHold(t: unknown): boolean {
  return Number((t as { legal_hold?: number | null }).legal_hold ?? 0) === 1;
}

/** Why this agent may not move `t` to the bin, or null. */
async function binRefusal(user: User, t: HdTicket | undefined, number: number): Promise<HdBinResult | null> {
  if (!t || !(await canWorkTicket(user, t))) return { number, ok: false, error: NOT_FOUND };
  if (!(await hdCan(user, "tickets.delete", { teamId: t.team_id }))) {
    return { number, subject: t.subject, ok: false, error: t.team_name ? `You can't delete tickets in ${t.team_name}.` : "You can't delete this ticket.", chip: "Not allowed" };
  }
  if (onHold(t)) {
    return { number, subject: t.subject, ok: false, error: "On legal hold. Take it off hold before deleting it.", chip: "Legal hold, stays" };
  }
  return null;
}

interface TaskPlan {
  /** Open task tickets this agent may delete: they go with the request. */
  go: { id: number; number: number }[];
  /** Open task tickets that stay, with why. */
  stay: { number: number; reason: string }[];
}

/** A request's open task tickets: the ones this agent could delete themselves go with it; the rest stay. */
async function taskPlan(user: User, parentId: number): Promise<TaskPlan> {
  const kids = await hq<HdTicketRow & { team_name: string | null }>(
    `SELECT t.*, tm.name AS team_name FROM hd_tickets t LEFT JOIN hd_teams tm ON tm.id = t.team_id
      WHERE t.parent_ticket_id = $1 AND t.deleted_at IS NULL AND t.status IN ('new', 'open', 'pending', 'on_hold') ORDER BY t.number`,
    [parentId]
  );
  const plan: TaskPlan = { go: [], stay: [] };
  for (const k of kids) {
    if (onHold(k)) plan.stay.push({ number: k.number, reason: "it's on legal hold" });
    else if (!(await canWorkTicket(user, k)) || !(await hdCan(user, "tickets.delete", { teamId: k.team_id }))) {
      plan.stay.push({ number: k.number, reason: k.team_name ? `you can't delete tickets in ${k.team_name}` : "you can't delete it" });
    } else plan.go.push({ id: k.id, number: k.number });
  }
  return plan;
}

const list = (ns: number[]) => ns.map((n) => `#${n}`).join(", ");

/** "Its task #1101 goes with it. Task #1102 stays open: you can't delete tickets in HR." or undefined. */
function planNote(plan: TaskPlan): string | undefined {
  const parts: string[] = [];
  if (plan.go.length) parts.push(`${plan.go.length === 1 ? "Its task" : "Its tasks"} ${list(plan.go.map((g) => g.number))} ${plan.go.length === 1 ? "goes" : "go"} with it.`);
  for (const s of plan.stay) parts.push(`Task #${s.number} stays open: ${s.reason}.`);
  return parts.length ? parts.join(" ") : undefined;
}

/** The delete dialog's preview (v1): each ticket, and whether it would go or stay. Changes nothing. */
export async function previewBin(user: User, numbers: number[]): Promise<HdBinResult[]> {
  const out: HdBinResult[] = [];
  const withParent = new Map<number, number>();
  for (const number of numbers) {
    const parent = withParent.get(number);
    const t = await getTicketByNumber(number);
    if (parent && t) {
      out.push({ number, subject: t.subject, ok: true, note: `Goes with #${parent}.` });
      continue;
    }
    const refused = await binRefusal(user, t, number);
    if (refused) {
      out.push(refused);
      continue;
    }
    const plan = await taskPlan(user, t!.id);
    for (const g of plan.go) withParent.set(g.number, number);
    out.push({ number, subject: t!.subject, ok: true, note: planNote(plan) });
  }
  return out;
}

/**
 * Move one live ticket to the bin inside the caller's transaction (locks
 * it), with the open task tickets in `taskIds` (still open, live, not held
 * and its own: re-checked here). Returns undefined when it is already
 * binned, gone, or on legal hold (re-checked under the lock). An open major
 * incident on it is solved in this transaction (`incident_ended`; the
 * caller ends its Status page incident after the commit).
 */
export async function binTicketTx(
  client: PoolClient,
  ticketId: number,
  actor: BinActor,
  now: Date = new Date(),
  opts: { taskIds?: number[] } = {}
): Promise<
  | { id: number; number: number; subject: string; team_id: number | null; status: string; requester_id: number | null; tasks: number[]; task_ids: number[]; incident_ended: boolean }
  | undefined
> {
  const r = await client.query<HdTicketRow>("SELECT * FROM hd_tickets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [ticketId]);
  const t = r.rows[0];
  if (!t || onHold(t)) return undefined;
  const name = actor.name.slice(0, 200) || "Someone";
  await client.query("UPDATE hd_tickets SET deleted_at = $2, deleted_by = $3, deleted_by_name = $4 WHERE id = $1", [ticketId, now, actor.id, name]);
  // Only the task tickets the caller chose (taskPlan); a system delete passes none.
  const tasks = opts.taskIds?.length
    ? await client.query<{ id: number; number: number }>(
        `UPDATE hd_tickets SET deleted_at = $2, deleted_by = $3, deleted_by_name = $4
          WHERE parent_ticket_id = $1 AND id = ANY($5::int[]) AND deleted_at IS NULL AND legal_hold = 0 AND status IN ('new', 'open', 'pending', 'on_hold')
          RETURNING id, number`,
        [ticketId, now, actor.id, name, opts.taskIds]
      )
    : { rows: [] as { id: number; number: number }[] };
  const ids = [ticketId, ...tasks.rows.map((x) => x.id)];
  const numbers = [t.number, ...tasks.rows.map((x) => x.number)];
  await client.query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at)
     SELECT x, $2, $3, 'internal', $4, 'system', $5 FROM unnest($1::int[]) x`,
    [ids, actor.id, name, `${mdInline(name)} moved this ticket to the recycle bin.`, now]
  );
  // Timers running on it stop and log their time, as Stop does (lib/helpdesk/time stopTimer).
  await client.query(
    `WITH stopped AS (DELETE FROM hd_timers WHERE ticket_id = ANY($1::int[]) RETURNING user_id, ticket_id, started_at)
     INSERT INTO hd_time_entries (ticket_id, user_id, minutes, note, started_at, logged_at, source)
     SELECT ticket_id, user_id, LEAST($3::int, GREATEST(1, round(extract(epoch FROM ($2::timestamptz - started_at)) / 60)::int)), '', started_at, $2, 'timer'
       FROM stopped`,
    [ids, now, TIME_LIMITS.maxMinutes]
  );
  // Nothing is sent about it: digest items queued about it and not yet sent go (lib/notify-policy).
  if ((await client.query<{ t: string | null }>("SELECT to_regclass('notify_digest_queue')::text AS t")).rows[0]?.t) {
    await client.query(
      `DELETE FROM notify_digest_queue
        WHERE claimed_at IS NULL AND link ~ ('/(desk/tickets|help/requests|support/requests)/(' || array_to_string($1::int[], '|') || ')([?#/].*)?$')`,
      [numbers]
    );
  }
  // A major incident's own ticket ends the incident, in this transaction.
  const ended = await client.query("UPDATE hd_incidents SET solved_at = now(), updated_at = now() WHERE ticket_id = $1 AND solved_at IS NULL RETURNING id", [ticketId]);
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    team_id: t.team_id,
    status: t.status,
    requester_id: t.requester_id,
    tasks: tasks.rows.map((x) => x.number),
    task_ids: tasks.rows.map((x) => x.id),
    incident_ended: (ended.rowCount ?? 0) > 0,
  };
}

/**
 * Move tickets to the bin, each checked on its own (binRefusal), in the order
 * given. Audited per ticket, and once more for a bulk request (`bulk`).
 */
export async function binTickets(
  user: User,
  numbers: number[],
  ctx: { ip?: string | null; bulk?: boolean; origin?: string } = {}
): Promise<HdBinResult[]> {
  const out: HdBinResult[] = [];
  const actor = actorOf(user);
  /** Task numbers that already went with their request in this call → the request's number. */
  const wentWith = new Map<number, number>();
  for (const number of numbers) {
    const parent = wentWith.get(number);
    if (parent) {
      out.push({ number, ok: true, note: `Binned with #${parent}.` });
      continue;
    }
    const t = await getTicketByNumber(number);
    const refused = await binRefusal(user, t, number);
    if (refused) {
      out.push(refused);
      continue;
    }
    try {
      const plan = await taskPlan(user, t!.id);
      const done = await withTx((client) => binTicketTx(client, t!.id, actor, new Date(), { taskIds: plan.go.map((g) => g.id) }));
      if (!done) {
        out.push({ number, subject: t!.subject, ok: false, error: "It changed meanwhile (put on legal hold, or already deleted). Reload and try again." });
        continue;
      }
      for (const n of done.tasks) wentWith.set(n, number);
      const went = new Set(done.tasks);
      const note = planNote({ go: plan.go.filter((g) => went.has(g.number)), stay: plan.stay });
      out.push({ number, subject: done.subject, ok: true, note });
      // The incident row was solved with the bin; its Status page incident is resolved now (lib/helpdesk/incidents).
      if (done.incident_ended) await (await import("./incidents")).onIncidentTicketEnded(done.id, actor.name);
      await audit({
        actor: actorFrom(user),
        action: "helpdesk.ticket.binned",
        targetType: "helpdesk_ticket",
        targetId: done.id,
        targetLabel: `#${done.number} ${done.subject}`.slice(0, 200),
        details: {
          number: done.number,
          team_id: done.team_id,
          status: done.status,
          requester_id: done.requester_id,
          task_tickets: done.tasks,
          tasks_left: plan.stay.map((x) => x.number),
          bulk: !!ctx.bulk,
        },
        ip: ctx.ip ?? null,
      });
      await emitBinEvents("ticket.deleted", [done.id, ...done.task_ids], actor, ctx.origin);
    } catch (e) {
      console.error("[helpdesk] recycle bin:", e);
      out.push({ number, subject: t!.subject, ok: false, error: "Couldn't delete this ticket. Try again." });
    }
  }
  if (ctx.bulk) await bulkAudit(user, "helpdesk.ticket.bulk_binned", out, ctx.ip);
  return out;
}

async function bulkAudit(user: User, action: string, results: HdBinResult[], ip?: string | null): Promise<void> {
  const ok = results.filter((r) => r.ok);
  const skipped = results.filter((r) => !r.ok);
  await audit({
    actor: actorFrom(user),
    action,
    targetType: "helpdesk_ticket",
    targetLabel: `${results.length} tickets`,
    details: { requested: results.length, done: ok.length, skipped: skipped.length, numbers: ok.map((r) => r.number), skipped_numbers: skipped.map((r) => r.number) },
    ip: ip ?? null,
  });
}

// --- Reading the bin ---------------------------------------------------------------

/**
 * The bin's scope for this person: binned tickets of the teams they may
 * delete in (tickets.delete is team-scoped; tickets.view_all lifts it).
 * Null = none.
 */
async function binScope(user: User, params: unknown[]): Promise<string | null> {
  if (!(await hdCan(user, "tickets.delete"))) return null;
  const teams = await agentTeamIds(user);
  if (teams === "all") return "t.deleted_at IS NOT NULL";
  const mine: number[] = [];
  for (const id of teams) if (await hdCan(user, "tickets.delete", { teamId: id })) mine.push(id);
  params.push(mine);
  return `(t.deleted_at IS NOT NULL AND t.team_id = ANY($${params.length}::int[]))`;
}

/** The recycle bin view (v2): binned tickets of the teams this person may delete in, newest first. */
export async function listBin(
  user: User,
  f: { q?: string; team_id?: number | null; limit?: number; offset?: number } = {},
  now = Date.now()
): Promise<{ rows: HdBinRow[]; total: number }> {
  const params: unknown[] = [];
  const scope = await binScope(user, params);
  if (!scope) return { rows: [], total: 0 };
  const where = [scope];
  if (f.team_id) {
    params.push(f.team_id);
    where.push(`t.team_id = $${params.length}`);
  }
  const q = (f.q ?? "").trim().slice(0, 200);
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    const like = `$${params.length}`;
    let clause = `(t.subject ILIKE ${like} OR t.requester_name ILIKE ${like} OR t.requester_email ILIKE ${like} OR t.deleted_by_name ILIKE ${like}`;
    const num = /^#?(\d{1,9})$/.exec(q);
    if (num) {
      params.push(Number(num[1]));
      clause += ` OR t.number = $${params.length}`;
    }
    where.push(clause + ")");
  }
  const whereSql = where.join(" AND ");
  const total = (await hqOne<{ n: number }>(`SELECT count(*)::int AS n FROM hd_tickets t WHERE ${whereSql}`, params))?.n ?? 0;
  const limit = Math.min(Math.max(1, f.limit ?? 100), BIN_BULK_MAX);
  const offset = Math.max(0, f.offset ?? 0);
  params.push(limit, offset);
  const rows = await hq<{
    number: number;
    subject: string;
    team_id: number | null;
    team_name: string | null;
    status: string;
    requester_name: string;
    deleted_at: string;
    deleted_by_name: string;
    legal_hold: number;
  }>(
    `SELECT t.number, t.subject, t.team_id, tm.name AS team_name, t.status, t.requester_name, t.deleted_at, t.deleted_by_name, t.legal_hold
       FROM hd_tickets t LEFT JOIN hd_teams tm ON tm.id = t.team_id
      WHERE ${whereSql}
      ORDER BY t.deleted_at DESC, t.number DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    total,
    rows: rows.map((r) => ({
      number: r.number,
      subject: r.subject,
      team_id: r.team_id,
      team_name: r.team_name,
      status: r.status,
      requester_name: r.requester_name,
      deleted_at: new Date(r.deleted_at).toISOString(),
      deleted_by_name: r.deleted_by_name || "Someone",
      purge_at: binPurgeAt(r.deleted_at).toISOString(),
      days_left: binDaysLeft(r.deleted_at, now),
      legal_hold: Number(r.legal_hold) === 1,
    })),
  };
}

/** How many tickets this person sees in the bin (the Views nav count); null without tickets.delete. */
export async function countBin(user: User): Promise<number | null> {
  const params: unknown[] = [];
  const scope = await binScope(user, params);
  if (!scope) return null;
  return (await hqOne<{ n: number }>(`SELECT count(*)::int AS n FROM hd_tickets t WHERE ${scope}`, params))?.n ?? 0;
}

/**
 * A binned ticket opened by link (v3): the ticket and its banner, for an
 * agent who works it; undefined when it is not binned or not theirs (the
 * caller answers 404, as for any ticket outside their queues).
 */
export async function binnedTicketFor(user: User, number: number): Promise<{ ticket: HdTicket; info: HdBinnedInfo } | undefined> {
  const t = await getTicketIncludingBinned(number);
  if (!t?.deleted_at || !(await canWorkTicket(user, t))) return undefined;
  const [restore, purge] = await Promise.all([hdCan(user, "tickets.delete", { teamId: t.team_id }), hdCan(user, "tickets.purge", { teamId: t.team_id })]);
  return {
    ticket: t,
    info: {
      number: t.number,
      deleted_at: new Date(t.deleted_at).toISOString(),
      deleted_by_name: t.deleted_by_name || "Someone",
      purge_at: binPurgeAt(t.deleted_at).toISOString(),
      days_left: binDaysLeft(t.deleted_at),
      can_restore: restore,
      can_purge: purge,
      legal_hold: onHold(t),
    },
  };
}

// --- Restore -------------------------------------------------------------------------

/**
 * Put one binned ticket back inside the caller's transaction (locks it),
 * with the task tickets binned at the same instant. Shifts a running SLA
 * clock by the time spent in the bin (see the header). Returns undefined
 * when it is not in the bin.
 */
export async function restoreTicketTx(
  client: PoolClient,
  ticketId: number,
  actor: BinActor,
  now: Date = new Date(),
  opts: { taskIds?: number[] } = {}
): Promise<{ id: number; number: number; subject: string; team_id: number | null; tasks: number[]; task_ids: number[] } | undefined> {
  const r = await client.query<HdTicketRow>("SELECT * FROM hd_tickets WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE", [ticketId]);
  const t = r.rows[0];
  if (!t) return undefined;
  const binnedAt = new Date(t.deleted_at!);
  await putBackTx(client, t, now);
  // Only the task tickets the caller may restore (restorePlan), binned with it at the same instant.
  const tasks = await client.query<HdTicketRow>(
    "SELECT * FROM hd_tickets WHERE parent_ticket_id = $1 AND deleted_at = $2 AND id = ANY($3::int[]) FOR UPDATE",
    [ticketId, binnedAt, opts.taskIds ?? []]
  );
  for (const c of tasks.rows) await putBackTx(client, c, now);
  const name = actor.name.slice(0, 200) || "Someone";
  await client.query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at)
     SELECT x, $2, $3, 'internal', $4, 'system', $5 FROM unnest($1::int[]) x`,
    [[ticketId, ...tasks.rows.map((c) => c.id)], actor.id, name, `${mdInline(name)} restored this ticket from the recycle bin.`, now]
  );
  return { id: t.id, number: t.number, subject: t.subject, team_id: t.team_id, tasks: tasks.rows.map((c) => c.number), task_ids: tasks.rows.map((c) => c.id) };
}

/** Clear the bin columns and resume a running SLA clock (shifted by the time binned). */
async function putBackTx(client: PoolClient, t: HdTicketRow, now: Date): Promise<void> {
  const binnedAt = Date.parse(t.deleted_at!);
  const running = HD_OPEN_STATUSES.includes(t.status) && !t.sla_paused_at && (t.first_reply_due || t.resolve_due);
  if (!running || now.getTime() <= binnedAt) {
    await client.query("UPDATE hd_tickets SET deleted_at = NULL, deleted_by = NULL, deleted_by_name = '' WHERE id = $1", [t.id]);
    return;
  }
  const [{ bankPausedBusiness, hoursForTeam, slaPolicyForTeam }, { resumedDues }] = await Promise.all([import("./calendars"), import("./sla")]);
  // Bank the binned span as paused business time, the way a pause that ends does.
  await client.query("UPDATE hd_tickets SET sla_paused_at = $2 WHERE id = $1", [t.id, new Date(binnedAt)]);
  await bankPausedBusiness(client, t.id, now);
  const policy = await slaPolicyForTeam(t.priority, t.team_id, client);
  let first = t.first_reply_due;
  let resolve = t.resolve_due;
  if (policy) {
    const d = resumedDues(t, binnedAt, now.getTime(), policy, await hoursForTeam(t.team_id, client));
    first = d.first_reply_due?.toISOString() ?? null;
    resolve = d.resolve_due?.toISOString() ?? null;
  } else {
    // No policy now (the team's target was removed meanwhile): shift by wall time.
    const span = now.getTime() - binnedAt;
    const shift = (due: string | null, live: boolean) => (due && live && Date.parse(due) > binnedAt ? new Date(Date.parse(due) + span).toISOString() : due);
    first = shift(first, !t.first_replied_at);
    resolve = shift(resolve, true);
  }
  await client.query(
    `UPDATE hd_tickets SET deleted_at = NULL, deleted_by = NULL, deleted_by_name = '', sla_paused_at = NULL,
            sla_paused_ms = sla_paused_ms + $2, first_reply_due = $3, resolve_due = $4,
            sla_warned_at = CASE WHEN $3::timestamptz IS DISTINCT FROM first_reply_due OR $4::timestamptz IS DISTINCT FROM resolve_due THEN NULL ELSE sla_warned_at END
      WHERE id = $1`,
    [t.id, Math.max(0, now.getTime() - binnedAt), first, resolve]
  );
}

/** Task tickets binned with `t` at the same instant: the ones this agent may restore come back with it. */
async function restorePlan(user: User, t: HdTicketRow): Promise<{ go: number[]; stay: { number: number; reason: string }[] }> {
  const kids = await hq<HdTicketRow & { team_name: string | null }>(
    `SELECT t.*, tm.name AS team_name FROM hd_tickets t LEFT JOIN hd_teams tm ON tm.id = t.team_id
      WHERE t.parent_ticket_id = $1 AND t.deleted_at = $2 ORDER BY t.number`,
    [t.id, t.deleted_at]
  );
  const out = { go: [] as number[], stay: [] as { number: number; reason: string }[] };
  for (const k of kids) {
    if ((await canWorkTicket(user, k)) && (await hdCan(user, "tickets.delete", { teamId: k.team_id }))) out.go.push(k.id);
    else out.stay.push({ number: k.number, reason: k.team_name ? `you can't restore tickets in ${k.team_name}` : "you can't restore it" });
  }
  return out;
}

/** A restored request's workflow run, held while it was binned, moves on (waits that came due fire). Never throws. */
async function resumeRun(t: HdTicketRow): Promise<void> {
  if (!t.workflow_run_id) return;
  try {
    await (await import("./engine")).advanceRun(t.workflow_run_id);
  } catch (e) {
    console.error("[helpdesk] resuming a restored request's run:", e);
  }
}

/** Restore tickets from the bin (tickets.delete in each one's team), one by one. */
export async function restoreTickets(user: User, numbers: number[], ctx: { ip?: string | null; bulk?: boolean; origin?: string } = {}): Promise<HdBinResult[]> {
  const out: HdBinResult[] = [];
  const actor = actorOf(user);
  for (const number of numbers) {
    const t = await getTicketIncludingBinned(number);
    if (!t?.deleted_at || !(await canWorkTicket(user, t))) {
      out.push({ number, ok: false, error: t && !t.deleted_at && (await canWorkTicket(user, t)) ? "It isn't in the recycle bin." : "Not found in the recycle bin." });
      continue;
    }
    if (!(await hdCan(user, "tickets.delete", { teamId: t.team_id }))) {
      out.push({ number, subject: t.subject, ok: false, error: "You can't restore this ticket." });
      continue;
    }
    // A task whose request is still in the bin comes back with the request, never alone (its run is held).
    const parent = t.parent_ticket_id
      ? await hqOne<{ number: number; deleted_at: string | null }>("SELECT number, deleted_at FROM hd_tickets WHERE id = $1", [t.parent_ticket_id])
      : undefined;
    if (parent?.deleted_at) {
      out.push({ number, subject: t.subject, ok: false, error: `Its request #${parent.number} is in the recycle bin. Restore #${parent.number} and its tasks come back with it.` });
      continue;
    }
    try {
      const plan = await restorePlan(user, t);
      const done = await withTx((client) => restoreTicketTx(client, t.id, actor, new Date(), { taskIds: plan.go }));
      if (!done) {
        out.push({ number, subject: t.subject, ok: false, error: "It isn't in the recycle bin." });
        continue;
      }
      const notes = [
        done.tasks.length ? `${done.tasks.length === 1 ? "Its task" : "Its tasks"} ${list(done.tasks)} came back with it.` : "",
        ...plan.stay.map((x) => `Task #${x.number} stays in the bin: ${x.reason}.`),
      ].filter(Boolean);
      out.push({ number, subject: done.subject, ok: true, note: notes.join(" ") || undefined });
      // Its held workflow run moves on now (lib/helpdesk/engine advanceRun skips binned requests).
      await resumeRun(t);
      await audit({
        actor: actorFrom(user),
        action: "helpdesk.ticket.restored",
        targetType: "helpdesk_ticket",
        targetId: done.id,
        targetLabel: `#${done.number} ${done.subject}`.slice(0, 200),
        details: { number: done.number, team_id: done.team_id, task_tickets: done.tasks, binned_at: new Date(t.deleted_at).toISOString(), binned_by: t.deleted_by_name, bulk: !!ctx.bulk },
        ip: ctx.ip ?? null,
      });
      await emitBinEvents("ticket.restored", [done.id, ...done.task_ids], actor, ctx.origin);
    } catch (e) {
      console.error("[helpdesk] recycle bin restore:", e);
      out.push({ number, subject: t.subject, ok: false, error: "Couldn't restore this ticket. Try again." });
    }
  }
  if (ctx.bulk) await bulkAudit(user, "helpdesk.ticket.bulk_restored", out, ctx.ip);
  return out;
}

// --- Delete for good ----------------------------------------------------------------

/** Delete one binned ticket for good inside the caller's transaction; returns its files (delete them after the commit). */
async function purgeTicketTx(client: PoolClient, ticketId: number): Promise<{ files: string[]; row: HdTicketRow } | undefined> {
  const r = await client.query<HdTicketRow>("SELECT * FROM hd_tickets WHERE id = $1 AND deleted_at IS NOT NULL AND legal_hold = 0 FOR UPDATE", [ticketId]);
  const row = r.rows[0];
  if (!row) return undefined;
  return { files: await deleteTicketTx(client, ticketId), row };
}

/** A workflow task ticket deleted for good: its run moves on now (the workflow sweep would within a minute). */
async function afterPurge(row: HdTicketRow): Promise<void> {
  if (row.source !== "workflow") return;
  try {
    await (await import("./engine")).onTaskTicketDeleted(row.source_ref);
  } catch (e) {
    console.error("[helpdesk] advancing a run after a task ticket was deleted for good:", e);
  }
}

/** "Delete for good…" from the bin: tickets.purge in each one's team. */
export async function purgeTickets(user: User, numbers: number[], ctx: { ip?: string | null; bulk?: boolean } = {}): Promise<HdBinResult[]> {
  const out: HdBinResult[] = [];
  for (const number of numbers) {
    const t = await getTicketIncludingBinned(number);
    if (!t?.deleted_at || !(await canWorkTicket(user, t))) {
      out.push({ number, ok: false, error: "Not found in the recycle bin." });
      continue;
    }
    if (!(await hdCan(user, "tickets.purge", { teamId: t.team_id }))) {
      out.push({ number, subject: t.subject, ok: false, error: "You can't delete tickets for good." });
      continue;
    }
    if (onHold(t)) {
      out.push({ number, subject: t.subject, ok: false, error: "On legal hold. It can't be deleted for good.", chip: "Legal hold, stays" });
      continue;
    }
    try {
      const done = await withTx((client) => purgeTicketTx(client, t.id));
      if (!done) {
        out.push({ number, subject: t.subject, ok: false, error: "It changed meanwhile. Reload and try again." });
        continue;
      }
      await deleteFiles(done.files);
      await afterPurge(done.row);
      out.push({ number, subject: t.subject, ok: true });
      await audit({
        actor: actorFrom(user),
        action: "helpdesk.ticket.purged",
        targetType: "helpdesk_ticket",
        targetId: t.id,
        targetLabel: `#${t.number} ${t.subject}`.slice(0, 200),
        details: { number: t.number, team_id: t.team_id, requester_id: t.requester_id, binned_at: new Date(t.deleted_at).toISOString(), binned_by: t.deleted_by_name, files: done.files.length, bulk: !!ctx.bulk },
        ip: ctx.ip ?? null,
      });
    } catch (e) {
      console.error("[helpdesk] recycle bin purge:", e);
      out.push({ number, subject: t.subject, ok: false, error: "Couldn't delete this ticket. Try again." });
    }
  }
  if (ctx.bulk) await bulkAudit(user, "helpdesk.ticket.bulk_purged", out, ctx.ip);
  return out;
}

// --- The daily purge sweep ----------------------------------------------------------

export interface BinPurgeResult {
  purged: number[];
  failed: number[];
  /** Another instance held the lock. */
  busy: boolean;
}

/**
 * Delete for good every ticket binned more than BIN_DAYS ago (by the
 * database's clock), not on legal hold, in batches under BIN_PURGE_LOCK.
 * `only` limits it to those ticket ids (tests). Audited per ticket
 * (helpdesk.ticket.purged, actor the system) and once with the count.
 */
export async function purgeExpired(opts: { only?: number[] | null; actor?: AuditActor | null } = {}): Promise<BinPurgeResult> {
  const only = opts.only ?? null;
  const out: BinPurgeResult = { purged: [], failed: [], busy: false };
  for (;;) {
    const files: string[] = [];
    const rows: HdTicketRow[] = [];
    const n = await withTx(async (client) => {
      const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [BIN_PURGE_LOCK]);
      if (!lock.rows[0]?.ok) return -1;
      const due = await client.query<{ id: number }>(
        `SELECT id FROM hd_tickets
          WHERE deleted_at IS NOT NULL AND deleted_at <= now() - make_interval(days => $1) AND legal_hold = 0
            AND ($2::int[] IS NULL OR id = ANY($2::int[])) AND NOT (id = ANY($3::int[]))
          ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
        [BIN_DAYS, only, out.failed]
      );
      for (const { id } of due.rows) {
        await client.query("SAVEPOINT hd_bin_purge_one");
        try {
          const done = await purgeTicketTx(client, id);
          await client.query("RELEASE SAVEPOINT hd_bin_purge_one");
          if (done) {
            files.push(...done.files);
            rows.push(done.row);
          }
        } catch (e) {
          await client.query("ROLLBACK TO SAVEPOINT hd_bin_purge_one");
          out.failed.push(id);
          logEvent("error", "helpdesk.recycle_bin_purge_failed", { ticket_id: id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return due.rows.length;
    });
    if (n < 0) {
      out.busy = true;
      break;
    }
    await deleteFiles(files);
    for (const row of rows) {
      out.purged.push(row.id);
      await afterPurge(row);
      await audit({
        actor: opts.actor ?? null,
        action: "helpdesk.ticket.purged",
        targetType: "helpdesk_ticket",
        targetId: row.id,
        targetLabel: `#${row.number} ${row.subject}`.slice(0, 200),
        details: { number: row.number, team_id: row.team_id, requester_id: row.requester_id, binned_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null, binned_by: row.deleted_by_name, reason: "recycle_bin_expired" },
      });
    }
    if (n < BATCH) break;
  }
  if (out.purged.length) {
    await audit({
      actor: opts.actor ?? null,
      action: "helpdesk.ticket.purged_by_sweep",
      targetType: "helpdesk_ticket",
      targetLabel: "Recycle bin",
      details: { count: out.purged.length, days: BIN_DAYS },
    });
  }
  if (out.failed.length) logEvent("warn", "helpdesk.recycle_bin_purge_failures", { count: out.failed.length });
  return out;
}

/** The daily sweep (HELPDESK_SWEEPS "hd_recycle_bin"): once per UTC day. */
export async function recycleBinSweep(now: Date = new Date()): Promise<BinPurgeResult | null> {
  if (!(await claimPeriod("hd_recycle_bin_purge", now.toISOString().slice(0, 10)))) return null;
  return purgeExpired();
}
