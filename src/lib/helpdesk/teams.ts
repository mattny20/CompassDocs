// Helpdesk 1.19.0: teams (IT, HR, Facilities…), their members (agent or
// lead) and agent availability. The routes audit; this module only reads
// and writes. Server-only.

import "server-only";
import { hq, hqOne, normalizeRow, withTx } from "./db-core";
import type { HdAvailability, HdTeam, HdTeamMember, HdTeamRole, HdTeamWithMembers } from "./types";

export const TEAM_LIMITS = { name: 60, description: 300, icon: 40, email_alias: 200, teams: 100, members: 500 } as const;

const TEAM_COLS = "t.id, t.name, t.description, t.icon, t.email_alias, t.position, t.created_at";

export async function listTeams(): Promise<HdTeam[]> {
  return hq<HdTeam>(`SELECT ${TEAM_COLS} FROM hd_teams t ORDER BY t.position, t.name, t.id`);
}

export async function getTeam(id: number): Promise<HdTeam | undefined> {
  return hqOne<HdTeam>(`SELECT ${TEAM_COLS} FROM hd_teams t WHERE t.id = $1`, [id]);
}

export async function listTeamMembers(teamId?: number): Promise<HdTeamMember[]> {
  return hq<HdTeamMember>(
    `SELECT m.team_id, m.user_id, m.role, u.name, u.email, u.username,
            COALESCE(p.availability, 'available') AS availability
       FROM hd_team_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN hd_agent_prefs p ON p.user_id = m.user_id
      WHERE ($1::int IS NULL OR m.team_id = $1) AND u.status = 'active'
      ORDER BY m.team_id, (m.role = 'lead') DESC, u.name`,
    [teamId ?? null]
  );
}

export async function listTeamsWithMembers(): Promise<HdTeamWithMembers[]> {
  const [teams, members] = await Promise.all([listTeams(), listTeamMembers()]);
  return teams.map((t) => ({ ...t, members: members.filter((m) => m.team_id === t.id) }));
}

export interface TeamInput {
  name: string;
  description?: string;
  icon?: string;
  email_alias?: string;
  position?: number;
}

/** Validate a team body. Returns the clean input or an error message. */
export function validateTeamInput(raw: Record<string, unknown>, partial = false): { ok: true; value: Partial<TeamInput> } | { ok: false; error: string } {
  const out: Partial<TeamInput> = {};
  if (raw.name !== undefined || !partial) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) return { ok: false, error: "A team needs a name." };
    if (name.length > TEAM_LIMITS.name) return { ok: false, error: `Keep the name under ${TEAM_LIMITS.name} characters.` };
    out.name = name;
  }
  for (const k of ["description", "icon", "email_alias"] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "string") return { ok: false, error: `${k} must be text.` };
    const v = (raw[k] as string).trim();
    if (v.length > TEAM_LIMITS[k]) return { ok: false, error: `Keep the ${k.replace("_", " ")} under ${TEAM_LIMITS[k]} characters.` };
    if (k === "icon" && v && !/^[a-z0-9-]+$/.test(v)) return { ok: false, error: "The icon is a lucide icon name." };
    if (k === "email_alias" && v && !/^[^\s@]+@[^\s@]+$/.test(v)) return { ok: false, error: "The email alias is not an address." };
    out[k] = v;
  }
  if (raw.position !== undefined) {
    const p = Number(raw.position);
    if (!Number.isInteger(p) || p < 0 || p > 10000) return { ok: false, error: "Position must be a whole number." };
    out.position = p;
  }
  return { ok: true, value: out };
}

/** Create a team; null when the name is taken. */
export async function createTeam(input: TeamInput): Promise<HdTeam | null> {
  const count = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_teams");
  if ((count?.n ?? 0) >= TEAM_LIMITS.teams) throw new Error(`A helpdesk has at most ${TEAM_LIMITS.teams} teams.`);
  const row = await hqOne<HdTeam>(
    `INSERT INTO hd_teams (name, description, icon, email_alias, position)
     VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT COALESCE(max(position) + 1, 0) FROM hd_teams)))
     ON CONFLICT (name) DO NOTHING
     RETURNING id, name, description, icon, email_alias, position, created_at`,
    [input.name, input.description ?? "", input.icon ?? "", input.email_alias ?? "", input.position ?? null]
  );
  return row ?? null;
}

/** Update a team; undefined when it does not exist, null when the new name is taken. */
export async function updateTeam(id: number, patch: Partial<TeamInput>): Promise<HdTeam | null | undefined> {
  try {
    return await hqOne<HdTeam>(
      `UPDATE hd_teams SET name = COALESCE($2, name), description = COALESCE($3, description),
              icon = COALESCE($4, icon), email_alias = COALESCE($5, email_alias), position = COALESCE($6, position)
        WHERE id = $1
        RETURNING id, name, description, icon, email_alias, position, created_at`,
      [id, patch.name ?? null, patch.description ?? null, patch.icon ?? null, patch.email_alias ?? null, patch.position ?? null]
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return null;
    throw e;
  }
}

/** Delete a team: its members go, its tickets keep their history (team_id NULL). */
export async function deleteTeam(id: number): Promise<HdTeam | undefined> {
  return withTx(async (client) => {
    const r = await client.query(
      "DELETE FROM hd_teams WHERE id = $1 RETURNING id, name, description, icon, email_alias, position, created_at",
      [id]
    );
    if (!r.rows[0]) return undefined;
    // The team's own email compositions (lib/email-parts, scope 'hd_team:<id>') go with it.
    await client.query("DELETE FROM email_template_compositions WHERE scope = 'hd_team:' || $1::text", [id]);
    return normalizeRow<HdTeam>(r.rows[0]);
  });
}

/**
 * Replace a team's members in one transaction. Unknown or disabled users
 * are dropped. Returns the before/after user ids for the audit row.
 */
export async function setTeamMembers(
  teamId: number,
  members: { user_id: number; role: HdTeamRole }[],
  opts: { expectBefore?: number[] } = {}
): Promise<{ added: number[]; removed: number[]; members: HdTeamMember[] }> {
  if (members.length > TEAM_LIMITS.members) throw new Error(`A team has at most ${TEAM_LIMITS.members} members.`);
  const result = await withTx(async (client) => {
    const before = (await client.query<{ user_id: number }>("SELECT user_id FROM hd_team_members WHERE team_id = $1 FOR UPDATE", [teamId])).rows.map((r) => r.user_id);
    if (opts.expectBefore) {
      // The caller checked each change against this list (roles-agents planTeamMembers).
      const active = new Set(
        (await client.query<{ id: number }>("SELECT id FROM users WHERE id = ANY($1::int[]) AND status = 'active'", [before])).rows.map((r) => r.id)
      );
      const now = before.filter((u) => active.has(u)).sort((a, b) => a - b);
      const want = [...opts.expectBefore].sort((a, b) => a - b);
      if (now.length !== want.length || now.some((u, i) => u !== want[i])) throw new Error("The team changed while you were editing it. Reload and try again.");
    }
    const ids = [...new Set(members.map((m) => m.user_id))];
    const valid = new Set(
      (await client.query<{ id: number }>("SELECT id FROM users WHERE id = ANY($1::int[]) AND status = 'active'", [ids])).rows.map((r) => r.id)
    );
    const keep = members.filter((m) => valid.has(m.user_id));
    await client.query("DELETE FROM hd_team_members WHERE team_id = $1 AND user_id <> ALL($2::int[])", [teamId, keep.map((m) => m.user_id)]);
    for (const m of keep) {
      await client.query(
        `INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [teamId, m.user_id, m.role === "lead" ? "lead" : "agent"]
      );
    }
    const after = keep.map((m) => m.user_id);
    return { added: after.filter((u) => !before.includes(u)), removed: before.filter((u) => !after.includes(u)) };
  });
  return { ...result, members: await listTeamMembers(teamId) };
}

/** Add (or change the role of) one member. */
export async function addTeamMember(teamId: number, userId: number, role: HdTeamRole = "agent"): Promise<void> {
  await hq(
    `INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [teamId, userId, role === "lead" ? "lead" : "agent"]
  );
}

export async function removeTeamMember(teamId: number, userId: number): Promise<boolean> {
  const rows = await hq("DELETE FROM hd_team_members WHERE team_id = $1 AND user_id = $2 RETURNING user_id", [teamId, userId]);
  return rows.length > 0;
}

/** Is this user a member of this team? */
export async function isTeamMember(teamId: number, userId: number): Promise<boolean> {
  return Boolean(await hqOne("SELECT 1 FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId]));
}

// --- Availability --------------------------------------------------------------

export function isAvailability(v: unknown): v is HdAvailability {
  return v === "available" || v === "away" || v === "offline";
}

export async function getAvailability(userId: number): Promise<HdAvailability> {
  const row = await hqOne<{ availability: HdAvailability }>("SELECT availability FROM hd_agent_prefs WHERE user_id = $1", [userId]);
  return row?.availability ?? "available";
}

export async function setAvailability(userId: number, availability: HdAvailability): Promise<HdAvailability> {
  await hq(
    `INSERT INTO hd_agent_prefs (user_id, availability, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET availability = EXCLUDED.availability, updated_at = now()`,
    [userId, availability]
  );
  return availability;
}

/**
 * The people an agent may assign a team's tickets to: that team's active
 * members (with availability), or, for no team, every member of any team.
 */
export async function assignableAgents(teamId?: number | null): Promise<
  { user_id: number; name: string; email: string; team_ids: number[]; role_in_team: HdTeamRole | null; availability: HdAvailability }[]
> {
  const rows = await hq<{ user_id: number; name: string; email: string; team_ids: number[]; lead_of: number[]; availability: HdAvailability }>(
    `SELECT u.id AS user_id, u.name, u.email,
            array_agg(m.team_id ORDER BY m.team_id) AS team_ids,
            array_agg(m.team_id ORDER BY m.team_id) FILTER (WHERE m.role = 'lead') AS lead_of,
            COALESCE(max(p.availability), 'available') AS availability
       FROM hd_team_members m
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
       LEFT JOIN hd_agent_prefs p ON p.user_id = u.id
      WHERE ($1::int IS NULL OR m.team_id = $1)
      GROUP BY u.id, u.name, u.email
      ORDER BY u.name`,
    [teamId ?? null]
  );
  return rows.map((r) => ({
    user_id: r.user_id,
    name: r.name,
    email: r.email,
    team_ids: r.team_ids,
    role_in_team: teamId ? ((r.lead_of ?? []).includes(teamId) ? "lead" : "agent") : null,
    availability: r.availability,
  }));
}

/** [{user_id, role}] from a body; null when malformed. */
export function parseMembers(raw: unknown): { user_id: number; role: HdTeamRole }[] | null {
  if (!Array.isArray(raw) || raw.length > TEAM_LIMITS.members) return null;
  const out: { user_id: number; role: HdTeamRole }[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    if (!m || typeof m !== "object") return null;
    const id = Number(m.user_id);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (m.role !== undefined && m.role !== "agent" && m.role !== "lead") return null;
    out.push({ user_id: id, role: m.role === "lead" ? "lead" : "agent" });
  }
  return out;
}

/** Members' team roles as their desk roles imply (an assigned Team lead leads; other assigned roles are agents); the body's role otherwise. */
export async function withDeskRoles(members: { user_id: number; role: HdTeamRole }[]): Promise<{ user_id: number; role: HdTeamRole }[]> {
  const { teamRoleFor } = await import("./roles");
  return Promise.all(members.map(async (m) => ({ user_id: m.user_id, role: (await teamRoleFor(m.user_id)) ?? m.role })));
}
