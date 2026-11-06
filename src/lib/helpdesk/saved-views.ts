// Helpdesk 1.19.1: saved queue views (agent V4). A name and a queue filter,
// personal or shared with a team, listed in the desk's views column with
// a count.
//
// Who sees and changes what:
//   personal   only the owner sees it, and changes it.
//   team       the team's members see it (and anyone who manages every
//              team: teams.manage lifts agents.manage_team); creating,
//              changing and deleting needs agents.manage_team on that team
//              (a team lead and up), J's capability.
// A view the caller cannot see is "not found" (404 in the routes), so ids
// reveal nothing.
//
// Filters are the tickets API's queue parameters, checked against the same
// whitelist and parser (lib/helpdesk/ticket-filters); sort is the list's,
// not the view's. Counts run the queue's own query in the viewer's scope
// (listTickets countOnly), batched and cached for 20 seconds per viewer.
// Server-only.

import "server-only";
import { hq, hqOne } from "./db-core";
import { memberTeamIds } from "./access";
import { hdCan } from "./roles";
import { listTickets } from "./tickets";
import { parseTicketFilters, TICKET_FILTER_KEYS } from "./ticket-filters";
import { SAVED_VIEW_LIMIT, SAVED_VIEW_NAME_MAX, type HdSavedView, type HdViewFilters } from "./saved-views-shared";
import type { Role } from "../types";

type U = { id: number; role: Role };

interface ViewRow {
  id: number;
  name: string;
  owner_id: number | null;
  team_id: number | null;
  team_name: string | null;
  filters: HdViewFilters;
  position: number;
  created_at: string;
  updated_at: string;
}

const COLS = `v.id, v.name, v.owner_id, v.team_id, tm.name AS team_name, v.filters, v.position, v.created_at, v.updated_at`;
const FROM = `hd_saved_views v LEFT JOIN hd_teams tm ON tm.id = v.team_id`;

/** The filter keys a view may hold: the queue's, without the list's own sort. */
export const VIEW_FILTER_KEYS: readonly string[] = TICKET_FILTER_KEYS.filter((k) => k !== "sort");

export class SavedViewError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A view's name: trimmed, 1–60 characters. */
export function cleanViewName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new SavedViewError("Give the view a name.");
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length > SAVED_VIEW_NAME_MAX) throw new SavedViewError(`Keep the name under ${SAVED_VIEW_NAME_MAX} characters.`);
  return name;
}

/**
 * Filters from a request body: an object of whitelisted keys with string
 * (or number) values, valid as queue parameters. Empty values are dropped;
 * `sort` is dropped (the list's). Throws SavedViewError with the reason.
 */
export async function cleanViewFilters(raw: unknown): Promise<HdViewFilters> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new SavedViewError("Filters are an object of queue parameters.");
  const out: HdViewFilters = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "sort") continue;
    if (!VIEW_FILTER_KEYS.includes(k)) throw new SavedViewError(`Unknown filter: ${k.slice(0, 40)}.`);
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "string" && typeof v !== "number") throw new SavedViewError(`The ${k} filter is text.`);
    const s = String(v).trim();
    if (!s) continue;
    if (s.length > 320) throw new SavedViewError(`The ${k} filter is too long.`);
    out[k] = s;
  }
  const parsed = await parseTicketFilters(new URLSearchParams(out));
  if (!parsed.ok) throw new SavedViewError(parsed.error);
  return out;
}

/** Sees every team's views (manages every team: teams.manage with agents.manage_team). */
async function managesAllTeams(user: U): Promise<boolean> {
  return (await hdCan(user, "agents.manage_team")) && (await hdCan(user, "teams.manage"));
}

/** May the person change this view? Personal: its owner. Team: agents.manage_team on that team. */
export async function canEditView(user: U, v: Pick<ViewRow, "owner_id" | "team_id">): Promise<boolean> {
  if (v.owner_id != null) return v.owner_id === user.id;
  if (v.team_id == null) return false;
  return hdCan(user, "agents.manage_team", { teamId: v.team_id });
}

function rowOut(r: ViewRow, canEdit: boolean): HdSavedView {
  return {
    id: Number(r.id),
    name: r.name,
    owner_id: r.owner_id == null ? null : Number(r.owner_id),
    team_id: r.team_id == null ? null : Number(r.team_id),
    team_name: r.team_name ?? null,
    filters: r.filters && typeof r.filters === "object" ? r.filters : {},
    position: Number(r.position),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    can_edit: canEdit,
  };
}

/** Every view the person sees: their own, then each team's, in order. */
export async function listVisibleViews(user: U): Promise<HdSavedView[]> {
  const all = await managesAllTeams(user);
  const teams = all ? null : await memberTeamIds(user.id);
  const rows = await hq<ViewRow>(
    `SELECT ${COLS} FROM ${FROM}
      WHERE v.owner_id = $1 OR (v.team_id IS NOT NULL AND ($2::int[] IS NULL OR v.team_id = ANY($2::int[])))
      ORDER BY (v.owner_id IS NULL), tm.position NULLS FIRST, tm.name NULLS FIRST, v.team_id NULLS FIRST, v.position, v.id`,
    [user.id, teams]
  );
  const out: HdSavedView[] = [];
  const teamEdit = new Map<number, boolean>();
  for (const r of rows) {
    let can = r.owner_id != null;
    if (r.team_id != null) {
      const tid = Number(r.team_id);
      if (!teamEdit.has(tid)) teamEdit.set(tid, await canEditView(user, r));
      can = teamEdit.get(tid)!;
    }
    out.push(rowOut(r, can));
  }
  return out;
}

/** One view the person sees, or undefined (not found to them). */
export async function getVisibleView(user: U, id: number): Promise<HdSavedView | undefined> {
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  const r = await hqOne<ViewRow>(`SELECT ${COLS} FROM ${FROM} WHERE v.id = $1`, [id]);
  if (!r) return undefined;
  if (r.owner_id != null) return Number(r.owner_id) === user.id ? rowOut(r, true) : undefined;
  if (r.team_id == null) return undefined;
  const sees = (await managesAllTeams(user)) || (await memberTeamIds(user.id)).includes(Number(r.team_id));
  if (!sees) return undefined;
  return rowOut(r, await canEditView(user, r));
}

/** Teams the person may share a view with (agents.manage_team there), by name. */
export async function shareTeams(user: U): Promise<{ id: number; name: string }[]> {
  if (!(await hdCan(user, "agents.manage_team"))) return [];
  const all = await managesAllTeams(user);
  const rows = await hq<{ id: number; name: string }>(
    `SELECT id, name FROM hd_teams ${all ? "" : "WHERE id = ANY($1::int[])"} ORDER BY position, name`,
    all ? [] : [await memberTeamIds(user.id)]
  );
  const out: { id: number; name: string }[] = [];
  for (const t of rows) if (await hdCan(user, "agents.manage_team", { teamId: Number(t.id) })) out.push({ id: Number(t.id), name: t.name });
  return out;
}

/** Create a view: personal (teamId null) or for a team the person leads. Checks the limit. */
export async function createView(user: U, input: { name: string; filters: HdViewFilters; teamId: number | null }): Promise<HdSavedView> {
  const scope = input.teamId == null ? { col: "owner_id", id: user.id } : { col: "team_id", id: input.teamId };
  const n = await hqOne<{ n: number; max: number | null }>(
    `SELECT count(*)::int AS n, max(position) AS max FROM hd_saved_views WHERE ${scope.col} = $1`,
    [scope.id]
  );
  if ((n?.n ?? 0) >= SAVED_VIEW_LIMIT) {
    throw new SavedViewError(
      input.teamId == null ? `You have ${SAVED_VIEW_LIMIT} views already. Delete one first.` : `This team has ${SAVED_VIEW_LIMIT} views already. Delete one first.`,
      409
    );
  }
  const r = await hqOne<{ id: number }>(
    `INSERT INTO hd_saved_views (name, owner_id, team_id, filters, position) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [input.name, input.teamId == null ? user.id : null, input.teamId, JSON.stringify(input.filters), (n?.max ?? 0) + 1]
  );
  return (await getVisibleView(user, Number(r!.id))) ?? rowOut((await hqOne<ViewRow>(`SELECT ${COLS} FROM ${FROM} WHERE v.id = $1`, [r!.id]))!, true);
}

/** Rename a view and/or replace its filters. */
export async function updateView(user: U, id: number, patch: { name?: string; filters?: HdViewFilters }): Promise<HdSavedView | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.filters !== undefined) {
    params.push(JSON.stringify(patch.filters));
    sets.push(`filters = $${params.length}::jsonb`);
  }
  if (sets.length) await hq(`UPDATE hd_saved_views SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
  countCache.clear();
  return getVisibleView(user, id);
}

export async function deleteView(id: number): Promise<void> {
  await hq("DELETE FROM hd_saved_views WHERE id = $1", [id]);
}

// --- Counts ---------------------------------------------------------------------

const COUNT_TTL_MS = 20_000;
const countCache = new Map<string, { n: number | null; at: number }>();

/** One view's ticket count for this person (their scope); null when its filters no longer parse. */
async function countOne(user: U, v: HdSavedView): Promise<number | null> {
  const parsed = await parseTicketFilters(new URLSearchParams(v.filters));
  if (!parsed.ok) return null;
  const { total } = await listTickets(user, { ...parsed.filters, sort: undefined, countOnly: true });
  return total;
}

/**
 * Fill each view's `count` for this person, four at a time, from a 20-second
 * cache keyed by viewer, view and its last change. A failing count is null,
 * never a failed list.
 */
export async function withCounts(user: U, views: HdSavedView[]): Promise<HdSavedView[]> {
  const now = Date.now();
  if (countCache.size > 5_000) for (const [k, c] of countCache) if (now - c.at > COUNT_TTL_MS) countCache.delete(k);
  const todo: HdSavedView[] = [];
  for (const v of views) {
    const hit = countCache.get(`${user.id}:${v.id}:${v.updated_at}`);
    if (hit && now - hit.at < COUNT_TTL_MS) v.count = hit.n;
    else todo.push(v);
  }
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(
      todo.slice(i, i + 4).map(async (v) => {
        try {
          v.count = await countOne(user, v);
        } catch (e) {
          console.error("[helpdesk] saved view count:", e);
          v.count = null;
        }
        countCache.set(`${user.id}:${v.id}:${v.updated_at}`, { n: v.count ?? null, at: now });
      })
    );
  }
  return views;
}

/** Forget cached counts (tests; after a write that moves tickets in bulk). */
export function clearViewCountCache(): void {
  countCache.clear();
}
