// Helpdesk 1.19.0: the desk's people (agent J) — who is on the desk, at
// which role, in which teams, and the rules for changing that. The
// Settings → Agents page and /api/helpdesk/admin/agents use it; the routes
// audit.
//
// Who may change whom:
//   agents.assign_roles (Manager, Admin)  any role assignableRoles() allows
//     (Manager: up to Team lead; Admin: any), any teams, for people below
//     their own rank (an Admin: anyone but themselves).
//   agents.manage_team (Team lead)  adds, moves between Newbie and Agent,
//     and removes people in their own teams only.
//   Nobody changes their own role, and a workspace helpdesk.admin holder
//   stays desk Admin (it is changed in Settings → People, not here).
//
// hd_team_members.role follows an assigned role ('lead' for Team lead,
// 'agent' otherwise) so the leads A and B read stay right. Server-only.

import "server-only";
import { actorFrom, audit } from "../audit";
import { legacyAuthzEnforcement } from "../authz";
import { forgetPushDevices } from "../db";
import { agentAllowance, agentLimit } from "../license";
import type { Role } from "../types";
import { hq, withTx, type HdQueryable } from "./db-core";
import { hdCapsFor, roleFacts, teamRoleFor } from "./roles";
import { withDeskRoles } from "./teams";
import type { HdTeamRole } from "./types";
import {
  HD_ROLE_LABEL,
  HD_ROLE_RANK,
  isHdRole,
  resolveRole,
  roleDisplayLabel,
  teamRoleForDeskRole,
  type HdCapsView,
  type HdDeskAgent,
  type HdRole,
  type HdRoleSource,
} from "./roles-shared";

type U = { id: number; role: Role };

export class DeskRoleError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/**
 * Adding someone to the desk would take it past the licence's agent
 * allowance (setDeskAgent only). The routes answer 402 with
 * { error, code: "agent_limit", allowed, used }.
 */
export class AgentLimitError extends DeskRoleError {
  readonly code = "agent_limit";
  constructor(
    public allowed: number,
    public used: number
  ) {
    super(
      `Your licence includes ${allowed} helpdesk agent${allowed === 1 ? "" : "s"} and all are in use. Buy more agents to add someone.`,
      402
    );
  }

  body() {
    return { error: this.message, code: this.code, allowed: this.allowed, used: this.used };
  }
}

const DESK_PERMS = ["helpdesk.admin", "helpdesk.agent_all", "helpdesk.agent", "helpdesk.reports"] as const;

interface Row {
  user_id: number;
  name: string;
  email: string;
  username: string;
  role: Role;
  explicit: HdRole | null;
  assigned_at: string | null;
  team_ids: number[];
  lead_ids: number[];
  perms: string[];
  availability: "available" | "away" | "offline";
}

/**
 * Everyone on the desk: an assigned role, a team membership, or a workspace
 * desk permission (helpdesk.agent / agent_all / admin). People with only
 * helpdesk.reports have no desk role and are not listed. Only active
 * accounts: deactivated people and API-token service accounts (status
 * 'service') are never listed. This list is also what the licence's agent
 * allowance counts (countDeskAgents). `client` runs it inside a transaction.
 */
export async function listDeskAgents(opts: { userIds?: number[]; client?: HdQueryable } = {}): Promise<HdDeskAgent[]> {
  const legacy = legacyAuthzEnforcement();
  const rows = await hq<Row>(
    `WITH perms AS (
       SELECT u.id AS user_id, array_agg(DISTINCT rp.permission) AS perms
         FROM users u
         JOIN role_assignments ra
           ON ra.scope_type = 'global'
          AND (ra.user_id = u.id OR ra.group_id IN (SELECT group_id FROM group_members WHERE user_id = u.id))
         JOIN role_permissions rp ON rp.role_id = ra.role_id AND rp.permission = ANY($1::text[])
        WHERE u.status = 'active'
        GROUP BY u.id
     ), candidates AS (
       SELECT user_id FROM hd_agent_roles
       UNION SELECT user_id FROM hd_team_members
       UNION SELECT user_id FROM perms WHERE perms && ARRAY['helpdesk.admin','helpdesk.agent_all','helpdesk.agent']::text[]
       UNION SELECT id FROM users WHERE $2::boolean AND role = 'admin'
     )
     SELECT u.id AS user_id, u.name, u.email, u.username, u.role,
            r.role AS explicit, r.assigned_at,
            COALESCE((SELECT array_agg(m.team_id ORDER BY m.team_id) FROM hd_team_members m WHERE m.user_id = u.id), '{}') AS team_ids,
            COALESCE((SELECT array_agg(m.team_id ORDER BY m.team_id) FROM hd_team_members m WHERE m.user_id = u.id AND m.role = 'lead'), '{}') AS lead_ids,
            COALESCE(p.perms, '{}') AS perms,
            COALESCE(ap.availability, 'available') AS availability
       FROM candidates c
       JOIN users u ON u.id = c.user_id AND u.status = 'active'
       LEFT JOIN hd_agent_roles r ON r.user_id = u.id
       LEFT JOIN perms p ON p.user_id = u.id
       LEFT JOIN hd_agent_prefs ap ON ap.user_id = u.id
      WHERE ($3::int[] IS NULL OR u.id = ANY($3::int[]))
      ORDER BY lower(COALESCE(NULLIF(u.name, ''), u.username)), u.id`,
    [DESK_PERMS, legacy, opts.userIds ?? null],
    opts.client
  );
  const out: HdDeskAgent[] = [];
  for (const r of rows) {
    const has = (k: string) => (legacy ? r.role === "admin" : r.perms.includes(k));
    const resolved = resolveRole({
      explicit: isHdRole(r.explicit) ? r.explicit : null,
      admin: has("helpdesk.admin"),
      agentAll: has("helpdesk.agent_all"),
      agent: has("helpdesk.agent"),
      reports: has("helpdesk.reports"),
      leadAnywhere: r.lead_ids.length > 0,
    });
    if (!resolved) continue; // a team member with no desk role and no key: not on the desk
    out.push({
      user_id: r.user_id,
      name: r.name || r.username,
      email: r.email,
      username: r.username,
      role: resolved.role,
      role_label: roleDisplayLabel(resolved.role, resolved.source),
      source: resolved.source,
      locked: resolved.source === "workspace",
      team_ids: r.team_ids,
      lead_team_ids: r.explicit === "team_lead" ? r.team_ids : r.explicit ? [] : r.lead_ids,
      availability: r.availability,
      assigned_at: r.assigned_at,
    });
  }
  return out;
}

export async function getDeskAgent(userId: number): Promise<HdDeskAgent | undefined> {
  return (await listDeskAgents({ userIds: [userId] }))[0];
}

// --- The licence's agent allowance ---------------------------------------------------
//
// One definition of who is an agent for the licence: exactly the people
// listDeskAgents lists (active, with a desk role; workspace Administrators
// and newbies included; service accounts, deactivated and Reports-only
// people not). The Agents page's meter, the License page, diagnostics, the
// setup checklist and setDeskAgent's limit all count this way.

/** The user ids that count against the agent allowance. */
export async function deskAgentIds(opts: { client?: HdQueryable } = {}): Promise<number[]> {
  return (await listDeskAgents({ client: opts.client })).map((a) => a.user_id);
}

/** How many people count against the agent allowance. */
export async function countDeskAgents(opts: { client?: HdQueryable } = {}): Promise<number> {
  return (await deskAgentIds(opts)).length;
}

export interface AgentUsage {
  /** The allowance in force; null = unlimited (no limit on the key, or in grace). */
  allowed: number | null;
  /** The key's own allowance whatever the licence's state (the meter shows this); null = unlimited. */
  licensed: number | null;
  /** setDeskAgent refuses adds past `allowed` (false: no limit, or in grace). */
  enforced: boolean;
  used: number;
  /** How many past the key's allowance (0 when within it or unlimited), in grace too. */
  over: number;
}

/** The meter: the key's allowance, and the one in force, against the count. `used` saves a recount when the caller has the list. */
export async function agentUsage(used?: number): Promise<AgentUsage> {
  const [{ allowed, licensed }, n] = await Promise.all([agentLimit(), used ?? countDeskAgents()]);
  return { allowed, licensed, enforced: allowed !== null, used: n, over: licensed === null ? 0 : Math.max(0, n - licensed) };
}

/** The audit row for an add the allowance refused (the agents routes write it). */
export async function auditAgentLimit(
  by: Parameters<typeof actorFrom>[0],
  e: AgentLimitError,
  attempted: { user_id: number; role: unknown },
  ip: string | null
): Promise<void> {
  const target = Number.isInteger(attempted.user_id) && attempted.user_id > 0 ? attempted.user_id : null;
  await audit({
    actor: actorFrom(by),
    action: "helpdesk.agent_role.refused_limit",
    targetType: target ? "user" : null,
    targetId: target,
    details: { role: isHdRole(attempted.role) ? attempted.role : null, allowed: e.allowed, used: e.used },
    ip,
  });
}

/** Serialises setDeskAgent's limit checks (pg_advisory_xact_lock). */
const AGENT_ALLOWANCE_LOCK = "hd_agent_allowance";

// --- Who may change whom -------------------------------------------------------------

interface Target {
  id: number;
  role: Role;
  current: { role: HdRole; source: HdRoleSource } | null;
  teams: number[];
}

async function loadTarget(userId: number): Promise<Target> {
  const u = (await hq<{ id: number; role: Role }>("SELECT id, role FROM users WHERE id = $1 AND status = 'active'", [userId]))[0];
  if (!u) throw new DeskRoleError("That person isn't an active member of the workspace.", 404);
  const facts = await roleFacts(u);
  return { id: u.id, role: u.role, current: resolveRole(facts), teams: facts.teams };
}

/** Can `by` manage `target` at all? Returns the scope ("all" teams, or by's own) or throws. */
function scopeFor(by: U, view: HdCapsView, target: Target): "all" | number[] {
  if (target.id === by.id) throw new DeskRoleError("You can't change your own desk role or teams.", 403);
  if (target.current?.source === "workspace") {
    throw new DeskRoleError("This person is Admin from their workspace role. Change it in Settings → People.", 409);
  }
  if (!view.role) throw new DeskRoleError("You don't have permission for that.", 403);
  if (target.current && view.role !== "admin" && HD_ROLE_RANK[target.current.role] >= HD_ROLE_RANK[view.role]) {
    throw new DeskRoleError(`You can't change someone who is ${HD_ROLE_LABEL[target.current.role]} or above your role.`, 403);
  }
  if (view.caps.includes("agents.assign_roles")) return "all";
  if (view.caps.includes("agents.manage_team")) {
    // A Team lead works on people in their own teams, or people not yet on
    // the desk. Someone already on the desk in no team (a helpdesk.agent_all
    // holder, say) is in nobody's team: only agents.assign_roles changes them.
    if (target.current && !target.teams.some((t) => view.team_ids.includes(t))) {
      throw new DeskRoleError("You can only manage people in your own teams.", 403);
    }
    return view.team_ids;
  }
  throw new DeskRoleError("You don't have permission for that.", 403);
}

async function validTeams(ids: unknown): Promise<number[] | null> {
  if (ids === undefined) return null;
  if (!Array.isArray(ids) || ids.length > 100 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
    throw new DeskRoleError("team_ids must be a list of team ids.", 400);
  }
  const uniq = [...new Set(ids as number[])];
  const found = await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1::int[])", [uniq]);
  if (found.length !== uniq.length) throw new DeskRoleError("One of the teams doesn't exist.", 400);
  return uniq.sort((a, b) => a - b);
}

export interface DeskAgentChange {
  before: { role: HdRole | null; source: HdRoleSource | null; team_ids: number[] };
  after: HdDeskAgent | undefined;
  /** No assigned role existed before (helpdesk.agent_role.assigned), else changed. */
  created: boolean;
}

/**
 * Set someone's desk role and/or teams. `role` undefined keeps it;
 * `team_ids` undefined keeps their teams. A Team lead's team_ids are
 * limited to their own teams, and only those of the person's memberships
 * change.
 */
export async function setDeskAgent(
  by: U & { name?: string },
  input: { user_id: unknown; role?: unknown; team_ids?: unknown },
  opts: { requireNew?: boolean } = {}
): Promise<DeskAgentChange> {
  const userId = Number(input.user_id);
  if (!Number.isInteger(userId) || userId <= 0) throw new DeskRoleError("Choose a person.", 400);
  if (input.role !== undefined && !isHdRole(input.role)) throw new DeskRoleError("Unknown desk role.", 400);
  const role = input.role as HdRole | undefined;
  const [view, target, teamIds] = await Promise.all([hdCapsFor(by), loadTarget(userId), validTeams(input.team_ids)]);
  const scope = scopeFor(by, view, target);
  if (opts.requireNew && target.current?.source === "assigned") {
    throw new DeskRoleError("This person is already on the desk. Change their role in the list.", 409);
  }
  if (role !== undefined && !view.assignable_roles.includes(role)) {
    throw new DeskRoleError(`You can't give the ${HD_ROLE_LABEL[role]} role.`, 403);
  }
  if (role === undefined && teamIds === null) throw new DeskRoleError("Nothing to change.", 400);
  if (scope !== "all") {
    if (teamIds && teamIds.some((t) => !scope.includes(t))) throw new DeskRoleError("You can only add people to your own teams.", 403);
    if (!target.current && (!teamIds || !teamIds.length)) throw new DeskRoleError("Choose at least one of your teams.", 400);
  }
  const effectiveRole = role ?? (target.current?.source === "assigned" ? target.current.role : null);
  // Only a role puts someone on the desk (a team membership alone doesn't),
  // so only a role change can need room under the allowance.
  const allowance = role !== undefined ? await agentAllowance() : null;

  await withTx(async (client) => {
    if (allowance !== null) {
      // The agent allowance: someone not yet counted needs room. Changing
      // the role of someone already counted is never refused. The lock makes
      // two adds at once take turns, so they can't both see the last place;
      // the count runs after it, on this transaction's snapshot.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [AGENT_ALLOWANCE_LOCK]);
      const counted = await deskAgentIds({ client });
      if (!counted.includes(userId) && counted.length >= allowance) throw new AgentLimitError(allowance, counted.length);
    }
    if (role !== undefined) {
      await client.query(
        `INSERT INTO hd_agent_roles (user_id, role, assigned_by, assigned_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
        [userId, role, by.id]
      );
    }
    if (teamIds) {
      // Within the scope, memberships become exactly teamIds; outside it, untouched.
      const inScope = scope === "all" ? target.teams : target.teams.filter((t) => scope.includes(t));
      const drop = inScope.filter((t) => !teamIds.includes(t));
      if (drop.length) await client.query("DELETE FROM hd_team_members WHERE user_id = $1 AND team_id = ANY($2::int[])", [userId, drop]);
      const teamRole = effectiveRole ? teamRoleForDeskRole(effectiveRole) : "agent";
      for (const t of teamIds) {
        await client.query(
          `INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, user_id) DO NOTHING`,
          [t, userId, teamRole]
        );
      }
    }
    if (effectiveRole) {
      await client.query("UPDATE hd_team_members SET role = $2 WHERE user_id = $1", [userId, teamRoleForDeskRole(effectiveRole)]);
    }
  });
  return {
    before: { role: target.current?.role ?? null, source: target.current?.source ?? null, team_ids: target.teams },
    after: await getDeskAgent(userId),
    created: target.current?.source !== "assigned" && role !== undefined,
  };
}

export interface DeskAgentRemoval {
  before: { role: HdRole | null; source: HdRoleSource | null; team_ids: number[] };
  /** Teams they were taken out of. */
  removed_team_ids: number[];
  /** Their assigned role went too. */
  role_removed: boolean;
  /** They still reach the desk through a workspace permission (helpdesk.agent / agent_all). */
  still_on_desk: HdDeskAgent | undefined;
}

/**
 * Take someone off the desk. Manager/Admin: their assigned role and every
 * team membership. Team lead: their memberships in the lead's teams, and
 * the assigned role when no team is left.
 */
export async function removeDeskAgent(by: U, userIdRaw: unknown): Promise<DeskAgentRemoval> {
  const userId = Number(userIdRaw);
  if (!Number.isInteger(userId) || userId <= 0) throw new DeskRoleError("Choose a person.", 400);
  const [view, target] = await Promise.all([hdCapsFor(by), loadTarget(userId)]);
  if (!target.current && !target.teams.length) throw new DeskRoleError("This person isn't on the desk.", 404);
  const scope = scopeFor(by, view, target);
  const drop = scope === "all" ? target.teams : target.teams.filter((t) => scope.includes(t));
  if (scope !== "all" && !drop.length) throw new DeskRoleError("You can only manage people in your own teams.", 403);
  const roleRemoved = await withTx(async (client) => {
    if (drop.length) await client.query("DELETE FROM hd_team_members WHERE user_id = $1 AND team_id = ANY($2::int[])", [userId, drop]);
    const left = target.teams.length - drop.length;
    if (scope === "all" || left === 0) {
      const r = await client.query("DELETE FROM hd_agent_roles WHERE user_id = $1 RETURNING user_id", [userId]);
      return (r.rowCount ?? 0) > 0;
    }
    return false;
  });
  const still = await getDeskAgent(userId);
  // Off the desk altogether: their desk push devices stop now.
  if (!still) await forgetPushDevices(userId);
  return {
    before: { role: target.current?.role ?? null, source: target.current?.source ?? null, team_ids: target.teams },
    removed_team_ids: drop,
    role_removed: roleRemoved,
    still_on_desk: still,
  };
}

/** May `view` change this row (the Agents page's controls)? Mirrors scopeFor without throwing. */
export function rowManageable(byId: number, view: HdCapsView, a: HdDeskAgent): boolean {
  if (a.user_id === byId || a.locked || !view.role) return false;
  if (view.role !== "admin" && HD_ROLE_RANK[a.role] >= HD_ROLE_RANK[view.role]) return false;
  if (view.caps.includes("agents.assign_roles")) return true;
  if (view.caps.includes("agents.manage_team")) return a.team_ids.some((t) => view.team_ids.includes(t));
  return false;
}

/**
 * The member list to store for PUT /api/helpdesk/admin/teams/[id]/members,
 * by this caller. teams.manage (Manager, Admin): the list as sent, with the
 * lead flag an assigned desk role implies (withDeskRoles). Anyone else got
 * through on agents.manage_team in this team (a Team lead) and works within
 * scopeFor's rules: everyone added or removed must be someone they could
 * add or remove on Settings → Agents (below their rank, not themselves, not
 * a workspace Admin), and nobody's lead flag changes: an assigned role
 * decides it, otherwise a member keeps theirs and a newcomer joins as an
 * agent. A body that asks for anything else is refused (403), not trimmed.
 */
export async function planTeamMembers(
  by: U,
  teamId: number,
  members: { user_id: number; role: HdTeamRole }[]
): Promise<{ members: { user_id: number; role: HdTeamRole }[]; expectBefore?: number[] }> {
  const view = await hdCapsFor(by);
  if (view.caps.includes("teams.manage")) return { members: await withDeskRoles(members) };
  if (!view.caps.includes("agents.manage_team") || !view.team_ids.includes(teamId)) {
    throw new DeskRoleError("You don't have permission for that.", 403);
  }
  const before = new Map(
    (
      await hq<{ user_id: number; role: HdTeamRole }>(
        `SELECT m.user_id, m.role FROM hd_team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active' WHERE m.team_id = $1`,
        [teamId]
      )
    ).map((r) => [r.user_id, r.role])
  );
  const seen = new Set<number>();
  const out: { user_id: number; role: HdTeamRole }[] = [];
  const mayChange = async (userId: number) => {
    const target = await loadTarget(userId).catch((e) => {
      // Gone or deactivated: setTeamMembers drops them anyway.
      if (e instanceof DeskRoleError && e.status === 404) return null;
      throw e;
    });
    if (target) scopeFor(by, view, target);
  };
  for (const m of members) {
    if (seen.has(m.user_id)) continue;
    seen.add(m.user_id);
    const prior = before.get(m.user_id);
    const role = (await teamRoleFor(m.user_id)) ?? prior ?? "agent";
    if (m.role !== role) throw new DeskRoleError("Only a Manager or Admin can change who leads a team.", 403);
    if (prior === undefined) await mayChange(m.user_id);
    out.push({ user_id: m.user_id, role });
  }
  for (const [userId, role] of before) {
    if (seen.has(userId)) continue;
    if (role === "lead") throw new DeskRoleError("Only a Manager or Admin can take a team lead out of a team.", 403);
    await mayChange(userId);
  }
  // setTeamMembers refuses if the team changed since these checks.
  return { members: out, expectBefore: [...before.keys()] };
}
