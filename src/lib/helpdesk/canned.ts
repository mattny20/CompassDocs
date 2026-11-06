// Helpdesk 1.19.2: canned responses (agent W4). Server-only.
//
// Text-only snippets an agent inserts at the cursor in a reply or an
// internal note. They never change the ticket (macros do that); inserting
// one only fills its placeholders for that ticket and that agent and counts
// the use. The pure half (placeholders, rendering, the ";" trigger, the
// picker's grouping) is lib/helpdesk/canned-shared; the tables are
// canned-schema's.
//
// Sharing and who writes it (agent J's macro capabilities, which the Roles
// page labels "macros and canned responses"):
//   personal   owner_id set: its owner's alone          macros.manage_personal
//   team       team_id set: that team's agents          macros.manage_team in that team
//                (an Agent with every team's queue sees every team's)
//   workspace  neither: every agent                     macros.manage_all
// Someone else's personal response is never listed, read or used.

import "server-only";
import { hq, hqOne } from "./db-core";
import { agentTeamIds, canWorkTicket } from "./access";
import { hdCan } from "./roles";
import type { HdCap } from "./roles-shared";
import type { HdTicketRow } from "./types";
import type { Role } from "../types";
import {
  CANNED_LIMITS,
  CANNED_PLACEHOLDERS,
  parseShare,
  renderCanned,
  shareOf,
  strayBraces,
  unknownPlaceholders,
  type HdCanned,
  type HdCannedScope,
} from "./canned-shared";

type U = { id: number; role: Role; name?: string | null; username?: string | null };

export { CANNED_LIMITS, CANNED_PLACEHOLDERS };

/** How long use rows are kept (the library shows 30 days). */
export const CANNED_USES_KEEP_DAYS = 90;

export class CannedError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400
  ) {
    super(message);
  }
}

interface Row {
  id: number;
  title: string;
  body: string;
  folder: string;
  owner_id: number | null;
  team_id: number | null;
  team_name: string | null;
  uses_30d: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export function cannedScope(c: { owner_id: number | null; team_id: number | null }): HdCannedScope {
  if (c.owner_id) return "personal";
  return c.team_id ? "team" : "workspace";
}

function out(r: Row): HdCanned {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    folder: r.folder,
    scope: cannedScope(r),
    owner_id: r.owner_id,
    team_id: r.team_id,
    team_name: r.team_name,
    uses_30d: Number(r.uses_30d) || 0,
    updated_at: r.updated_at,
  };
}

const SELECT = `
  SELECT c.id, c.title, c.body, c.folder, c.owner_id, c.team_id, t.name AS team_name, c.created_by, c.created_at, c.updated_at,
         (SELECT count(*) FROM hd_canned_uses u WHERE u.canned_id = c.id AND u.used_at > now() - interval '30 days')::int AS uses_30d
    FROM hd_canned_responses c LEFT JOIN hd_teams t ON t.id = c.team_id`;

/**
 * The responses a person may see: the workspace's, those of `teams` ("all"
 * = every team's) and their own personal ones. Nobody else's personal
 * responses are ever listed.
 */
export async function listCanned(teams: number[] | "all", ownerId: number): Promise<HdCanned[]> {
  const rows = await hq<Row>(
    `${SELECT}
      WHERE c.owner_id = $2::int
         OR (c.owner_id IS NULL AND c.team_id IS NULL)
         OR (c.owner_id IS NULL AND c.team_id IS NOT NULL AND ($1::int[] IS NULL OR c.team_id = ANY($1::int[])))
      ORDER BY lower(c.title), c.id`,
    [teams === "all" ? null : teams, ownerId]
  );
  return rows.map(out);
}

export async function getCanned(id: number): Promise<HdCanned | undefined> {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const r = await hqOne<Row>(`${SELECT} WHERE c.id = $1`, [id]);
  return r ? out(r) : undefined;
}

/** May this person see (and so use) the response? `extraTeamId`: the team of a ticket they work. */
export function cannedVisibleTo(c: { owner_id: number | null; team_id: number | null }, userId: number, teams: number[] | "all", extraTeamId: number | null = null): boolean {
  if (c.owner_id) return c.owner_id === userId;
  if (c.team_id === null) return true;
  return teams === "all" || teams.includes(c.team_id) || c.team_id === extraTeamId;
}

/** The capability that writes a response of this sharing, and the team it is checked in. */
export function cannedManageCap(c: { owner_id: number | null; team_id: number | null }): { cap: HdCap; teamId: number | null } {
  const scope = cannedScope(c);
  if (scope === "personal") return { cap: "macros.manage_personal", teamId: null };
  if (scope === "team") return { cap: "macros.manage_team", teamId: c.team_id };
  return { cap: "macros.manage_all", teamId: null };
}

/** May this person create, edit or delete a response shared this way? A personal one only ever its owner. */
export async function mayManageCanned(user: U, c: { owner_id: number | null; team_id: number | null }): Promise<boolean> {
  if (c.owner_id && c.owner_id !== user.id) return false;
  const { cap, teamId } = cannedManageCap(c);
  return hdCan(user, cap, { teamId });
}

export const CANNED_MANAGE_CAPS: HdCap[] = ["macros.manage_personal", "macros.manage_team", "macros.manage_all"];

/** The Shared with choices this person may save: Only me, each team they may write for, Workspace. */
export async function shareOptionsFor(user: U): Promise<{ value: string; label: string }[]> {
  const opts: { value: string; label: string }[] = [];
  if (await hdCan(user, "macros.manage_personal")) opts.push({ value: "me", label: "Only me" });
  if (await hdCan(user, "macros.manage_team")) {
    const all = await hdCan(user, "macros.manage_all");
    const teams = await hq<{ id: number; name: string }>(
      all
        ? "SELECT id, name FROM hd_teams ORDER BY position, lower(name)"
        : "SELECT t.id, t.name FROM hd_teams t JOIN hd_team_members m ON m.team_id = t.id AND m.user_id = $1 ORDER BY t.position, lower(t.name)",
      all ? [] : [user.id]
    );
    for (const t of teams) if (await hdCan(user, "macros.manage_team", { teamId: t.id })) opts.push({ value: `team:${t.id}`, label: t.name });
  }
  if (await hdCan(user, "macros.manage_all")) opts.push({ value: "workspace", label: "Workspace" });
  return opts;
}

// --- Validation ------------------------------------------------------------------

export interface CannedInput {
  title: string;
  body: string;
  folder: string;
  owner_id: number | null;
  team_id: number | null;
}

/**
 * Clean a create (every field) or an edit (only what is sent). `share` is
 * "me" | "workspace" | "team:<id>"; "me" makes the caller the owner.
 */
export async function validateCannedInput(raw: Record<string, unknown>, callerId: number, partial = false): Promise<Partial<CannedInput>> {
  const v: Partial<CannedInput> = {};
  if (!partial || raw.title !== undefined) {
    if (typeof raw.title !== "string" || !raw.title.trim()) throw new CannedError("Give the canned response a name.");
    const t = raw.title.replace(/\s+/g, " ").trim();
    if (t.length > CANNED_LIMITS.title) throw new CannedError(`Keep the name under ${CANNED_LIMITS.title} characters.`);
    v.title = t;
  }
  if (!partial || raw.body !== undefined) {
    if (typeof raw.body !== "string" || !raw.body.trim()) throw new CannedError("Write the text to insert.");
    const b = raw.body.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
    if (b.length > CANNED_LIMITS.body) throw new CannedError(`Keep the text under ${CANNED_LIMITS.body.toLocaleString("en")} characters.`);
    const unknown = unknownPlaceholders(b);
    if (unknown.length) {
      const known = CANNED_PLACEHOLDERS.map((p) => `{{${p.tag}}}`).join(", ");
      throw new CannedError(`${unknown.slice(0, 3).join(", ")} isn't a placeholder canned responses fill. Use ${known}.`);
    }
    if (strayBraces(b)) {
      throw new CannedError("Check the braces: {{ and }} only go around a placeholder, such as {{requester.first_name}}.");
    }
    v.body = b;
  }
  if (!partial || raw.folder !== undefined) {
    if (raw.folder !== undefined && raw.folder !== null && typeof raw.folder !== "string") throw new CannedError("The folder must be text.");
    const f = typeof raw.folder === "string" ? raw.folder.replace(/\s+/g, " ").trim() : "";
    if (f.length > CANNED_LIMITS.folder) throw new CannedError(`Keep the folder name under ${CANNED_LIMITS.folder} characters.`);
    v.folder = f;
  }
  if (!partial || raw.share !== undefined) {
    const s = parseShare(raw.share ?? "me");
    if (!s) throw new CannedError("Choose who it is shared with.");
    if (s.scope === "team") {
      const team = await hqOne<{ id: number }>("SELECT id FROM hd_teams WHERE id = $1", [s.teamId]);
      if (!team) throw new CannedError("Unknown team.");
    }
    v.owner_id = s.scope === "personal" ? callerId : null;
    v.team_id = s.scope === "team" ? s.teamId : null;
  }
  return v;
}

// --- Writes ----------------------------------------------------------------------

/**
 * Room for one more response shared this way (`exceptId`: the one being
 * moved)? Personal ones count against their owner (CANNED_LIMITS.personal),
 * so nobody's private list can use up the workspace's; team and workspace
 * ones against the workspace (CANNED_LIMITS.total).
 */
async function assertRoom(ownerId: number | null, exceptId: number | null = null): Promise<void> {
  if (ownerId) {
    const n = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_canned_responses WHERE owner_id = $1 AND id IS DISTINCT FROM $2", [ownerId, exceptId]);
    if ((n?.n ?? 0) >= CANNED_LIMITS.personal) throw new CannedError(`You can keep up to ${CANNED_LIMITS.personal} personal canned responses.`, 409);
    return;
  }
  const n = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_canned_responses WHERE owner_id IS NULL AND id IS DISTINCT FROM $1", [exceptId]);
  if ((n?.n ?? 0) >= CANNED_LIMITS.total) {
    throw new CannedError(`A workspace can keep up to ${CANNED_LIMITS.total.toLocaleString("en")} shared canned responses.`, 409);
  }
}

export async function createCanned(input: CannedInput, createdBy: number | null): Promise<HdCanned> {
  await assertRoom(input.owner_id);
  const r = await hqOne<{ id: number }>(
    `INSERT INTO hd_canned_responses (title, body, folder, owner_id, team_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.title, input.body, input.folder, input.owner_id, input.owner_id ? null : input.team_id, createdBy]
  );
  return (await getCanned(r!.id))!;
}

/**
 * Change only the fields in `patch`, and only while the response is still
 * shared as `expected` says (the sharing the caller's permission was checked
 * against): a concurrent move answers 409 and writes nothing. Undefined when
 * the response is gone.
 */
export async function updateCanned(
  id: number,
  patch: Partial<CannedInput>,
  expected: { owner_id: number | null; team_id: number | null }
): Promise<HdCanned | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [id, expected.owner_id, expected.team_id];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.title !== undefined) set("title", patch.title);
  if (patch.body !== undefined) set("body", patch.body);
  if (patch.folder !== undefined) set("folder", patch.folder);
  if (patch.owner_id !== undefined || patch.team_id !== undefined) {
    const owner = patch.owner_id !== undefined ? patch.owner_id : expected.owner_id;
    const team = owner ? null : patch.team_id !== undefined ? patch.team_id : expected.team_id;
    if (owner !== expected.owner_id) await assertRoom(owner, id);
    set("owner_id", owner);
    set("team_id", team);
  }
  if (sets.length) {
    const r = await hq<{ id: number }>(
      `UPDATE hd_canned_responses SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2::int AND team_id IS NOT DISTINCT FROM $3::int RETURNING id`,
      params
    );
    if (!r.length) {
      if (!(await getCanned(id))) return undefined;
      throw new CannedError("Someone changed who this canned response is shared with just now. Reload and try again.", 409);
    }
  }
  return getCanned(id);
}

/** The fields an edit actually changed (title, body, folder, share), for the audit. */
export function changedFields(before: HdCanned, after: HdCanned): string[] {
  const out: string[] = [];
  if (before.title !== after.title) out.push("title");
  if (before.body !== after.body) out.push("body");
  if (before.folder !== after.folder) out.push("folder");
  if (shareOf(before) !== shareOf(after)) out.push("share");
  return out;
}

/** How many responses are shared with a team (the Delete team dialog and its audit: they go with the team). */
export async function cannedCountForTeam(teamId: number): Promise<number> {
  return (await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_canned_responses WHERE team_id = $1", [teamId]))?.n ?? 0;
}

/**
 * People who are deactivated but still own personal responses, with how
 * many (never their text): a Manager (macros.manage_all) may delete them
 * without reading them. A removed account's go with it already.
 */
export async function inactiveOwners(): Promise<{ owner_id: number; name: string; count: number }[]> {
  return hq<{ owner_id: number; name: string; count: number }>(
    `SELECT c.owner_id, COALESCE(NULLIF(u.name, ''), u.username) AS name, count(*)::int AS count
       FROM hd_canned_responses c JOIN users u ON u.id = c.owner_id
      WHERE u.status <> 'active'
      GROUP BY c.owner_id, u.name, u.username ORDER BY lower(COALESCE(NULLIF(u.name, ''), u.username))`
  );
}

/** Delete a deactivated person's personal responses; how many went (0 when they are active again). */
export async function deleteInactiveOwnersCanned(ownerId: number): Promise<number> {
  const r = await hq<{ id: number }>(
    `DELETE FROM hd_canned_responses c USING users u
      WHERE c.owner_id = $1 AND u.id = c.owner_id AND u.status <> 'active' RETURNING c.id`,
    [ownerId]
  );
  return r.length;
}

export async function deleteCanned(id: number): Promise<HdCanned | undefined> {
  const cur = await getCanned(id);
  if (!cur) return undefined;
  await hq("DELETE FROM hd_canned_responses WHERE id = $1", [id]);
  return cur;
}

// --- Using -------------------------------------------------------------------------

/** One use per person, response and ticket in this window: inserting the same one again counts once. */
export const CANNED_USE_WINDOW_MINUTES = 60;

/** Count one insert, unless this person already used it on this ticket within the window. True when counted. */
export async function recordCannedUse(cannedId: number, userId: number | null, ticketId: number | null): Promise<boolean> {
  const r = await hq<{ id: number }>(
    `INSERT INTO hd_canned_uses (canned_id, user_id, ticket_id)
     SELECT $1, $2, $3
      WHERE NOT EXISTS (
        SELECT 1 FROM hd_canned_uses
         WHERE canned_id = $1 AND user_id IS NOT DISTINCT FROM $2::int AND ticket_id IS NOT DISTINCT FROM $3::int
           AND used_at > now() - interval '${CANNED_USE_WINDOW_MINUTES} minutes')
     RETURNING id`,
    [cannedId, userId, ticketId]
  );
  return r.length > 0;
}

let lastPrune = 0;

/**
 * Drop every use older than CANNED_USES_KEEP_DAYS, in one statement (the
 * used_at index serves it). The helpdesk sweep (lib/periodic, hd_canned)
 * calls it every minute; it runs at most every six hours per process, and
 * running twice is harmless, so it needs no advisory lock. `force` for tests.
 */
export async function pruneCannedUses(opts: { force?: boolean } = {}): Promise<number> {
  const now = Date.now();
  if (!opts.force && now - lastPrune < 6 * 3_600_000) return 0;
  lastPrune = now;
  const r = await hqOne<{ n: number }>(
    `WITH gone AS (DELETE FROM hd_canned_uses WHERE used_at < now() - interval '${CANNED_USES_KEEP_DAYS} days' RETURNING 1) SELECT count(*)::int AS n FROM gone`
  );
  return r?.n ?? 0;
}

type TicketRef = Pick<HdTicketRow, "id" | "number" | "requester_id" | "requester_name" | "team_id" | "assignee_id">;

/** Fill a response for one ticket and one agent (the team's name read now). */
export async function renderCannedFor(c: Pick<HdCanned, "body">, ticket: TicketRef | null, agent: U): Promise<string> {
  let teamName = "";
  if (ticket?.team_id) teamName = (await hqOne<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [ticket.team_id]))?.name ?? "";
  return renderCanned(c.body, {
    requesterName: ticket?.requester_name ?? "",
    ticketNumber: ticket?.number ?? null,
    teamName,
    agentName: (agent.name || agent.username || "").trim(),
  });
}

/**
 * The responses for the composer's picker on one ticket the agent works:
 * the workspace's, their teams' (every team's with See every team's
 * tickets), the ticket's own team's, and their own. `ticketTeamId` orders
 * the groups (that team first).
 */
export async function pickerCanned(user: U, ticket: TicketRef | null): Promise<{ items: HdCanned[]; ticketTeamId: number | null }> {
  const teams = await agentTeamIds(user);
  let scope: number[] | "all" = teams;
  let ticketTeamId: number | null = null;
  if (ticket && (await canWorkTicket(user, ticket))) {
    ticketTeamId = ticket.team_id;
    if (scope !== "all" && ticket.team_id && !scope.includes(ticket.team_id)) scope = [...scope, ticket.team_id];
  }
  return { items: await listCanned(scope, user.id), ticketTeamId };
}

/**
 * Insert a response into a reply on a ticket the agent works: check they
 * may see it there, fill it, count the use. Never touches the ticket.
 */
export async function insertCanned(user: U, cannedId: number, ticket: TicketRef): Promise<{ body: string; canned: HdCanned }> {
  if (!(await canWorkTicket(user, ticket))) throw new CannedError("Ticket not found.", 404);
  const c = await getCanned(cannedId);
  if (!c || !cannedVisibleTo(c, user.id, await agentTeamIds(user), ticket.team_id)) throw new CannedError("Canned response not found.", 404);
  const body = await renderCannedFor(c, ticket, user);
  await recordCannedUse(c.id, user.id, ticket.id);
  return { body, canned: c };
}
