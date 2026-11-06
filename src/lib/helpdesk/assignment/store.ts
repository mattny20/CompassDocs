// Helpdesk 1.19.0: ticket assignment's tables (agent N). Plain reads and
// writes of the settings, members, rules, on-call rotation and the log; the
// decisions are ./engine's. Every query goes through assignmentReady() first,
// which waits for lib/db's boot (its SCHEMA applies HD_ASSIGNMENT_SCHEMA).
// Server-only.

import "server-only";
import { dbReady } from "../../db";
import { hq, hqOne, withTx, type HdQueryable } from "../db-core";
import {
  ASSIGNMENT_LIMITS,
  defaultTeamAssignment,
  type HdAssignmentLogEntry,
  type HdAssignmentRule,
  type HdAssignMethod,
  type HdAssignRuleInput,
  type HdOnCallRotation,
  type HdOnCallShift,
  type HdTeamAssignment,
} from "./shared";

let ready: Promise<void> | null = null;

/**
 * The assignment tables exist: lib/db's boot applies HD_ASSIGNMENT_SCHEMA
 * (inside its own lock) as part of SCHEMA_SQL, so this only waits for that
 * boot. Runtime code never runs DDL.
 */
export function assignmentReady(): Promise<void> {
  if (!ready) {
    ready = dbReady().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = [], client?: HdQueryable): Promise<T[]> {
  if (!client) await assignmentReady();
  return hq<T>(sql, params, client);
}

async function q1<T = Record<string, unknown>>(sql: string, params: unknown[] = [], client?: HdQueryable): Promise<T | undefined> {
  return (await q<T>(sql, params, client))[0];
}

// --- Team settings ---------------------------------------------------------------------

export async function getTeamAssignment(teamId: number, client?: HdQueryable): Promise<HdTeamAssignment> {
  const row = await q1<HdTeamAssignment>("SELECT * FROM hd_team_assignment WHERE team_id = $1", [teamId], client);
  if (!row) return defaultTeamAssignment(teamId);
  return { ...row, include_roles: Array.isArray(row.include_roles) ? row.include_roles : defaultTeamAssignment(teamId).include_roles };
}

/** Every team's settings row (teams without one are manual). */
export async function listTeamAssignments(): Promise<HdTeamAssignment[]> {
  return q<HdTeamAssignment>("SELECT * FROM hd_team_assignment ORDER BY team_id");
}

export async function saveTeamAssignment(s: HdTeamAssignment, byId: number | null): Promise<HdTeamAssignment> {
  await q(
    `INSERT INTO hd_team_assignment (team_id, mode, eligible, include_roles, max_open_per_agent, respect_shift, sticky_requester,
        reassign_when_away, unanswered_minutes, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (team_id) DO UPDATE SET mode = EXCLUDED.mode, eligible = EXCLUDED.eligible, include_roles = EXCLUDED.include_roles,
        max_open_per_agent = EXCLUDED.max_open_per_agent, respect_shift = EXCLUDED.respect_shift,
        sticky_requester = EXCLUDED.sticky_requester, reassign_when_away = EXCLUDED.reassign_when_away,
        unanswered_minutes = EXCLUDED.unanswered_minutes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [
      s.team_id,
      s.mode,
      s.eligible,
      JSON.stringify(s.include_roles),
      s.max_open_per_agent,
      s.respect_shift,
      s.sticky_requester,
      s.reassign_when_away,
      s.unanswered_minutes,
      byId,
    ]
  );
  return getTeamAssignment(s.team_id);
}

// --- Members ------------------------------------------------------------------------------

export interface MemberRow {
  user_id: number;
  name: string;
  email: string;
  /** The workspace role (for the permission checks). */
  role: import("../../types").Role;
  team_role: "agent" | "lead";
  weight: number;
  paused: number;
  availability: "available" | "away" | "offline";
  availability_since: string | null;
}

/** The team's active members with their assignment settings and availability. */
export async function listMemberRows(teamId: number): Promise<MemberRow[]> {
  return q<MemberRow>(
    `SELECT u.id AS user_id, u.name, u.email, u.role, m.role AS team_role,
            COALESCE(am.weight, 1) AS weight, COALESCE(am.paused, 0) AS paused,
            COALESCE(p.availability, 'available') AS availability, p.updated_at AS availability_since
       FROM hd_team_members m
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
       LEFT JOIN hd_assignment_members am ON am.team_id = m.team_id AND am.user_id = m.user_id
       LEFT JOIN hd_agent_prefs p ON p.user_id = m.user_id
      WHERE m.team_id = $1
      ORDER BY u.id`,
    [teamId]
  );
}

/** Open tickets assigned to each person (every team) and when each was last auto- or hand-assigned. */
export async function loadOf(userIds: number[], client?: HdQueryable): Promise<Map<number, { open_count: number; last_assigned_at: string | null }>> {
  const out = new Map<number, { open_count: number; last_assigned_at: string | null }>();
  if (!userIds.length) return out;
  const rows = await q<{ user_id: number; open_count: number; last_assigned_at: string | null }>(
    `SELECT x.id AS user_id,
            (SELECT count(*)::int FROM hd_tickets t WHERE t.assignee_id = x.id AND t.status IN ('new', 'open', 'pending', 'on_hold')) AS open_count,
            (SELECT max(l.at) FROM hd_assignment_log l WHERE l.to_user_id = x.id) AS last_assigned_at
       FROM unnest($1::int[]) AS x(id)`,
    [userIds],
    client
  );
  for (const r of rows) out.set(r.user_id, { open_count: r.open_count, last_assigned_at: r.last_assigned_at });
  return out;
}

export async function isMember(teamId: number, userId: number): Promise<boolean> {
  return Boolean(await q1("SELECT 1 FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId]));
}

export async function setMember(teamId: number, userId: number, patch: { weight?: number; paused?: number }): Promise<void> {
  await q(
    `INSERT INTO hd_assignment_members (team_id, user_id, weight, paused, updated_at) VALUES ($1, $2, COALESCE($3, 1), COALESCE($4, 0), now())
     ON CONFLICT (team_id, user_id) DO UPDATE SET weight = COALESCE($3, hd_assignment_members.weight),
        paused = COALESCE($4, hd_assignment_members.paused), updated_at = now()`,
    [teamId, userId, patch.weight ?? null, patch.paused ?? null]
  );
}

/** Pause or resume a person's auto-assignment in every team they belong to. Returns the team ids. */
export async function setPausedEverywhere(userId: number, paused: number): Promise<number[]> {
  const rows = await q<{ team_id: number }>(
    `INSERT INTO hd_assignment_members (team_id, user_id, paused, updated_at)
     SELECT team_id, user_id, $2, now() FROM hd_team_members WHERE user_id = $1
     ON CONFLICT (team_id, user_id) DO UPDATE SET paused = EXCLUDED.paused, updated_at = now()
     RETURNING team_id`,
    [userId, paused]
  );
  return rows.map((r) => r.team_id).sort((a, b) => a - b);
}

export interface MyAutoAssign {
  /** Paused in every team they belong to (and in at least one). */
  paused: boolean;
  teams: { team_id: number; name: string; mode: string; paused: number }[];
}

export async function myAutoAssign(userId: number): Promise<MyAutoAssign> {
  const teams = await q<{ team_id: number; name: string; mode: string; paused: number }>(
    `SELECT m.team_id, t.name, COALESCE(a.mode, 'manual') AS mode, COALESCE(am.paused, 0) AS paused
       FROM hd_team_members m
       JOIN hd_teams t ON t.id = m.team_id
       LEFT JOIN hd_team_assignment a ON a.team_id = m.team_id
       LEFT JOIN hd_assignment_members am ON am.team_id = m.team_id AND am.user_id = m.user_id
      WHERE m.user_id = $1
      ORDER BY t.position, t.name`,
    [userId]
  );
  return { paused: teams.length > 0 && teams.every((t) => t.paused === 1), teams };
}

// --- Rules ----------------------------------------------------------------------------------

export class AssignmentLimitError extends Error {}

export async function listRules(opts: { enabledOnly?: boolean } = {}): Promise<HdAssignmentRule[]> {
  return q<HdAssignmentRule>(`SELECT * FROM hd_assignment_rules ${opts.enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY position, id`);
}

export async function getRule(id: number): Promise<HdAssignmentRule | undefined> {
  return q1<HdAssignmentRule>("SELECT * FROM hd_assignment_rules WHERE id = $1", [id]);
}

export async function createRule(input: HdAssignRuleInput, byId: number | null): Promise<HdAssignmentRule> {
  await assignmentReady();
  return withTx(async (client) => {
    await client.query("LOCK TABLE hd_assignment_rules IN SHARE ROW EXCLUSIVE MODE");
    const n = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM hd_assignment_rules")).rows[0].n;
    if (n >= ASSIGNMENT_LIMITS.rules) throw new AssignmentLimitError(`Up to ${ASSIGNMENT_LIMITS.rules} assignment rules.`);
    const row = await hqOne<HdAssignmentRule>(
      `INSERT INTO hd_assignment_rules (name, position, enabled, scope_team_id, conditions, action, stop, created_by)
       VALUES ($1, (SELECT COALESCE(max(position), -1) + 1 FROM hd_assignment_rules), $2, $3, $4, $5, $6, $7) RETURNING *`,
      [input.name, input.enabled, input.scope_team_id, JSON.stringify(input.conditions), JSON.stringify(input.action), input.stop, byId],
      client
    );
    return row!;
  });
}

export async function updateRule(id: number, patch: Partial<HdAssignRuleInput>): Promise<HdAssignmentRule | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.enabled !== undefined) set("enabled", patch.enabled);
  if (patch.stop !== undefined) set("stop", patch.stop);
  if (patch.scope_team_id !== undefined) set("scope_team_id", patch.scope_team_id);
  if (patch.conditions !== undefined) set("conditions", JSON.stringify(patch.conditions));
  if (patch.action !== undefined) set("action", JSON.stringify(patch.action));
  if (!sets.length) return getRule(id);
  return q1<HdAssignmentRule>(`UPDATE hd_assignment_rules SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, params);
}

export async function deleteRule(id: number): Promise<HdAssignmentRule | undefined> {
  return q1<HdAssignmentRule>("DELETE FROM hd_assignment_rules WHERE id = $1 RETURNING *", [id]);
}

/** Set the run order; `ids` must name every rule once. Returns false when it doesn't. */
export async function reorderRules(ids: number[]): Promise<boolean> {
  await assignmentReady();
  return withTx(async (client) => {
    await client.query("LOCK TABLE hd_assignment_rules IN SHARE ROW EXCLUSIVE MODE");
    const current = (await client.query<{ id: number }>("SELECT id FROM hd_assignment_rules")).rows.map((r) => r.id);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || !current.every((id) => ids.includes(id))) return false;
    await client.query(
      `UPDATE hd_assignment_rules r SET position = x.pos - 1, updated_at = now()
         FROM unnest($1::int[]) WITH ORDINALITY AS x(id, pos) WHERE r.id = x.id`,
      [ids]
    );
    return true;
  });
}

// --- On call ----------------------------------------------------------------------------------

export async function getRotation(teamId: number): Promise<HdOnCallRotation | null> {
  const row = await q1<HdOnCallRotation & { starts_on: string | Date }>(
    "SELECT team_id, user_ids, length_days, handover_time, timezone, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, updated_by, updated_at FROM hd_on_call_rotation WHERE team_id = $1",
    [teamId]
  );
  return row ? { ...row, starts_on: String(row.starts_on), user_ids: Array.isArray(row.user_ids) ? row.user_ids : [] } : null;
}

export async function saveRotation(r: HdOnCallRotation, byId: number | null): Promise<HdOnCallRotation> {
  await q(
    `INSERT INTO hd_on_call_rotation (team_id, user_ids, length_days, handover_time, timezone, starts_on, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (team_id) DO UPDATE SET user_ids = EXCLUDED.user_ids, length_days = EXCLUDED.length_days,
        handover_time = EXCLUDED.handover_time, timezone = EXCLUDED.timezone, starts_on = EXCLUDED.starts_on,
        updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [r.team_id, JSON.stringify(r.user_ids), r.length_days, r.handover_time, r.timezone, r.starts_on, byId]
  );
  return (await getRotation(r.team_id))!;
}

export async function deleteRotation(teamId: number): Promise<boolean> {
  return Boolean(await q1("DELETE FROM hd_on_call_rotation WHERE team_id = $1 RETURNING team_id", [teamId]));
}

/** One-off cover (hd_on_call rows) overlapping [from, to). */
export async function listOverrides(teamId: number, from: Date, to: Date): Promise<HdOnCallShift[]> {
  const rows = await q<{ id: number; user_id: number; starts_at: string; ends_at: string }>(
    `SELECT id, user_id, starts_at, ends_at FROM hd_on_call
      WHERE team_id = $1 AND source = 'override' AND starts_at < $3 AND ends_at > $2
      ORDER BY starts_at, id`,
    [teamId, from, to]
  );
  return rows.map((r) => ({ ...r, source: "override" as const }));
}

export async function addOverride(teamId: number, userId: number, startsAt: Date, endsAt: Date, byId: number | null): Promise<HdOnCallShift> {
  const n = await q1<{ n: number }>("SELECT count(*)::int AS n FROM hd_on_call WHERE team_id = $1 AND ends_at > now()", [teamId]);
  if ((n?.n ?? 0) >= ASSIGNMENT_LIMITS.overrides) throw new AssignmentLimitError(`Up to ${ASSIGNMENT_LIMITS.overrides} upcoming cover shifts per team.`);
  const row = await q1<{ id: number; user_id: number; starts_at: string; ends_at: string }>(
    `INSERT INTO hd_on_call (team_id, user_id, starts_at, ends_at, source, created_by) VALUES ($1, $2, $3, $4, 'override', $5)
     RETURNING id, user_id, starts_at, ends_at`,
    [teamId, userId, startsAt, endsAt, byId]
  );
  return { ...row!, source: "override" };
}

export async function deleteOverride(teamId: number, id: number): Promise<HdOnCallShift | undefined> {
  const row = await q1<{ id: number; user_id: number; starts_at: string; ends_at: string }>(
    "DELETE FROM hd_on_call WHERE team_id = $1 AND id = $2 AND source = 'override' RETURNING id, user_id, starts_at, ends_at",
    [teamId, id]
  );
  return row ? { ...row, source: "override" } : undefined;
}

// --- Log ------------------------------------------------------------------------------------------

export interface LogInput {
  ticket_id: number;
  method: HdAssignMethod;
  rule_id?: number | null;
  rule_name?: string;
  from_user_id?: number | null;
  to_user_id?: number | null;
  team_id?: number | null;
  actor_id?: number | null;
  reason?: string;
  at?: Date;
}

export async function insertLog(e: LogInput, client?: HdQueryable): Promise<void> {
  await q(
    `INSERT INTO hd_assignment_log (ticket_id, at, method, rule_id, rule_name, from_user_id, to_user_id, team_id, actor_id, reason)
     VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.ticket_id,
      e.at ?? null,
      e.method,
      e.rule_id ?? null,
      (e.rule_name ?? "").slice(0, 200),
      e.from_user_id ?? null,
      e.to_user_id ?? null,
      e.team_id ?? null,
      e.actor_id ?? null,
      (e.reason ?? "").slice(0, 500),
    ],
    client
  );
}

export async function listLog(ticketId: number): Promise<HdAssignmentLogEntry[]> {
  return q<HdAssignmentLogEntry>(
    `SELECT l.id, l.ticket_id, l.at, l.method, l.rule_id, l.rule_name, l.from_user_id, fu.name AS from_name,
            l.to_user_id, tu.name AS to_name, l.team_id, t.name AS team_name, l.actor_id, au.name AS actor_name, l.reason
       FROM hd_assignment_log l
       LEFT JOIN users fu ON fu.id = l.from_user_id
       LEFT JOIN users tu ON tu.id = l.to_user_id
       LEFT JOIN users au ON au.id = l.actor_id
       LEFT JOIN hd_teams t ON t.id = l.team_id
      WHERE l.ticket_id = $1
      ORDER BY l.at, l.id`,
    [ticketId]
  );
}

// --- Per-ticket state ------------------------------------------------------------------------------

export interface TicketState {
  ticket_id: number;
  queued_since: string | null;
  queued_reason: string;
  decision: PendingDecision;
  auto_reassigns: number;
  cap_noted: number;
}

/** What the engine decided for a ticket it had to queue: retried as is by the sweep (rules do not run again). */
export interface PendingDecision {
  kind?: "round_robin" | "load_balanced" | "on_call" | "team_mode";
  min_role?: string | null;
  rule_id?: number | null;
  rule_name?: string;
}

export async function getTicketState(ticketId: number, client?: HdQueryable): Promise<TicketState | undefined> {
  return q1<TicketState>("SELECT * FROM hd_assignment_ticket WHERE ticket_id = $1", [ticketId], client);
}

export async function queueTicket(ticketId: number, reason: string, decision: PendingDecision, now: Date, client?: HdQueryable): Promise<boolean> {
  const row = await q1<{ fresh: boolean }>(
    `INSERT INTO hd_assignment_ticket (ticket_id, queued_since, queued_reason, decision, updated_at) VALUES ($1, $2, $3, $4, $2)
     ON CONFLICT (ticket_id) DO UPDATE SET queued_since = COALESCE(hd_assignment_ticket.queued_since, EXCLUDED.queued_since),
        queued_reason = EXCLUDED.queued_reason, decision = EXCLUDED.decision, updated_at = EXCLUDED.updated_at
     RETURNING (queued_since = $2) AS fresh`,
    [ticketId, now, reason.slice(0, 500), JSON.stringify(decision)],
    client
  );
  return Boolean(row?.fresh);
}

export async function clearQueued(ticketId: number, client?: HdQueryable): Promise<void> {
  await q("UPDATE hd_assignment_ticket SET queued_since = NULL, queued_reason = '', updated_at = now() WHERE ticket_id = $1 AND queued_since IS NOT NULL", [ticketId], client);
}

export async function countReassign(ticketId: number, client?: HdQueryable): Promise<void> {
  await q(
    `INSERT INTO hd_assignment_ticket (ticket_id, auto_reassigns) VALUES ($1, 1)
     ON CONFLICT (ticket_id) DO UPDATE SET auto_reassigns = hd_assignment_ticket.auto_reassigns + 1, updated_at = now()`,
    [ticketId],
    client
  );
}

/** Mark the "reassigned the most times" note as written; true the first time. */
export async function claimCapNote(ticketId: number): Promise<boolean> {
  const row = await q1(
    `UPDATE hd_assignment_ticket SET cap_noted = 1, updated_at = now() WHERE ticket_id = $1 AND cap_noted = 0 RETURNING ticket_id`,
    [ticketId]
  );
  return Boolean(row);
}
