// Helpdesk 1.19.0 reports (agent K): saved dashboards. Who sees and edits
// what:
//
//   see      a built-in, your own, a "team" dashboard of a team you belong
//            to, an "everyone" dashboard, or any of them with reports.all.
//            Seeing a dashboard never widens the numbers: every widget runs
//            in the viewer's own report scope.
//   edit     your own; a shared one needs its owner, reports.all, or the
//            desk role Manager or Admin. Built-ins are read-only for
//            everyone (duplicate one to change it).
//   share    "team" needs membership of that team (or reports.all);
//            "everyone" needs reports.team or reports.all.
//   default  only reports.all may make a dashboard the default one.
//
// The built-ins are seeded on first read and kept in step with
// ./builtins (their layout is the code's; their is_default is the
// workspace's). Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { hq, hqOne, withTx } from "../db-core";
import { hdCan, hdRoleOf } from "../roles";
import { memberTeamIds } from "../access";
import { HD_BUILTIN_DASHBOARDS } from "./builtins";
import {
  DASHBOARD_LIMITS,
  parseLayout,
  type HdDashboard,
  type HdDashboardLayout,
  type HdVisibility,
} from "./shared";
import type { Viewer } from "./engine";

// --- Schema -------------------------------------------------------------------------------

let schemaReady: Promise<void> | null = null;

/**
 * The reports' tables and indexes come with lib/db's boot schema
 * (${HD_ANALYTICS_SCHEMA} in the Helpdesk block, guarded ALTERs and
 * indexes): wait for it, and run no DDL here (review #32).
 */
export function ensureAnalyticsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const { dbReady } = await import("../../db");
    await dbReady();
  })().catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

// --- Seeding --------------------------------------------------------------------------------

let seeded = false;

/** Insert the built-in dashboards that are missing and refresh the others' layout. Idempotent. */
export async function seedBuiltinDashboards(force = false): Promise<void> {
  await ensureAnalyticsSchema();
  if (seeded && !force) return;
  await withTx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('hd_dashboards_seed'))");
    const anyDefault = (await c.query("SELECT 1 FROM hd_dashboards WHERE is_default = 1 LIMIT 1")).rowCount;
    for (const [i, b] of HD_BUILTIN_DASHBOARDS.entries()) {
      await c.query(
        `INSERT INTO hd_dashboards (name, description, owner_id, visibility, layout, is_default, builtin, position)
         VALUES ($1, $2, NULL, 'everyone', $3, $4, $5, $6)
         ON CONFLICT (builtin) WHERE builtin IS NOT NULL
         DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, layout = EXCLUDED.layout, position = EXCLUDED.position
           WHERE hd_dashboards.layout IS DISTINCT FROM EXCLUDED.layout OR hd_dashboards.name IS DISTINCT FROM EXCLUDED.name
              OR hd_dashboards.description IS DISTINCT FROM EXCLUDED.description OR hd_dashboards.position IS DISTINCT FROM EXCLUDED.position`,
        [b.name, b.description, JSON.stringify(b.layout), anyDefault ? 0 : b.is_default, b.key, i]
      );
    }
  });
  seeded = true;
}

// --- Access ---------------------------------------------------------------------------------

interface Row {
  id: number;
  name: string;
  description: string;
  owner_id: number | null;
  owner_name: string | null;
  visibility: HdVisibility;
  team_id: number | null;
  team_name: string | null;
  layout: unknown;
  is_default: number;
  builtin: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

const COLS = `d.id, d.name, d.description, d.owner_id, COALESCE(NULLIF(u.name, ''), u.username) AS owner_name, d.visibility,
  d.team_id, tm.name AS team_name, d.layout, d.is_default, d.builtin, d.position, d.created_at, d.updated_at`;
const FROM = `hd_dashboards d LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN hd_teams tm ON tm.id = d.team_id`;

export interface DashboardRights {
  all: boolean;
  team: boolean;
  manager: boolean;
  teams: number[];
}

export async function dashboardRights(viewer: Viewer): Promise<DashboardRights> {
  const [all, team, role, teams] = await Promise.all([
    hdCan(viewer, "reports.all"),
    hdCan(viewer, "reports.team"),
    hdRoleOf(viewer),
    memberTeamIds(viewer.id),
  ]);
  return { all, team, manager: role?.role === "manager" || role?.role === "admin", teams };
}

function canSee(r: Row, viewer: Viewer, rights: DashboardRights): boolean {
  if (r.builtin || r.owner_id === viewer.id || rights.all) return true;
  if (r.visibility === "everyone") return true;
  if (r.visibility === "team") return r.team_id !== null && rights.teams.includes(r.team_id);
  return false;
}

function canEdit(r: Row, viewer: Viewer, rights: DashboardRights): boolean {
  if (r.builtin) return false;
  if (r.owner_id === viewer.id) return true;
  if (r.visibility === "private") return false;
  return rights.all || rights.manager;
}

function shape(r: Row, viewer: Viewer, rights: DashboardRights): HdDashboard {
  const layout = parseLayout(r.layout);
  const empty: HdDashboardLayout = { widgets: [], filters: {}, range: { preset: "last_30" }, compare: null };
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    owner_id: r.owner_id,
    owner_name: r.owner_name,
    visibility: r.visibility,
    team_id: r.team_id,
    team_name: r.team_name,
    layout: layout.ok ? layout.value : empty,
    is_default: r.is_default,
    builtin: r.builtin,
    created_at: r.created_at,
    updated_at: r.updated_at,
    can_edit: canEdit(r, viewer, rights),
  };
}

// --- Reads ------------------------------------------------------------------------------------

/** The dashboards this viewer can open: built-ins first, then the default, then by name. */
export async function listDashboards(viewer: Viewer): Promise<HdDashboard[]> {
  await seedBuiltinDashboards();
  const rights = await dashboardRights(viewer);
  const rows = await hq<Row>(
    `SELECT ${COLS} FROM ${FROM}
      WHERE d.builtin IS NOT NULL OR d.owner_id = $1 OR d.visibility = 'everyone' OR $2::boolean
         OR (d.visibility = 'team' AND d.team_id = ANY($3::int[]))
      ORDER BY (d.builtin IS NULL), d.position, lower(d.name), d.id
      LIMIT 500`,
    [viewer.id, rights.all, rights.teams]
  );
  return rows.filter((r) => canSee(r, viewer, rights)).map((r) => shape(r, viewer, rights));
}

export async function getDashboard(id: number, viewer: Viewer): Promise<HdDashboard | null> {
  await seedBuiltinDashboards();
  const r = await hqOne<Row>(`SELECT ${COLS} FROM ${FROM} WHERE d.id = $1`, [id]);
  if (!r) return null;
  const rights = await dashboardRights(viewer);
  return canSee(r, viewer, rights) ? shape(r, viewer, rights) : null;
}

/** For the scheduled digests: a dashboard by id, no viewer check (the digest checks each recipient). */
export async function dashboardById(id: number): Promise<HdDashboard | null> {
  await ensureAnalyticsSchema();
  const r = await hqOne<Row>(`SELECT ${COLS} FROM ${FROM} WHERE d.id = $1`, [id]);
  if (!r) return null;
  return shape(r, { id: 0, role: "viewer" }, { all: false, team: false, manager: false, teams: [] });
}

export async function viewerCanSee(d: HdDashboard, viewer: Viewer): Promise<boolean> {
  const rights = await dashboardRights(viewer);
  return canSee({ ...d, layout: d.layout, position: 0 } as Row, viewer, rights);
}

// --- Writes -----------------------------------------------------------------------------------

export class DashboardError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface DashboardInput {
  name?: unknown;
  description?: unknown;
  visibility?: unknown;
  team_id?: unknown;
  layout?: unknown;
  is_default?: unknown;
}

interface Clean {
  name?: string;
  description?: string;
  visibility?: HdVisibility;
  team_id?: number | null;
  layout?: HdDashboardLayout;
  is_default?: number;
}

function clean(input: DashboardInput, partial: boolean): Clean {
  const out: Clean = {};
  if (input.name !== undefined || !partial) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new DashboardError("Give the dashboard a name.");
    if (name.length > DASHBOARD_LIMITS.name) throw new DashboardError(`Keep the name under ${DASHBOARD_LIMITS.name} characters.`);
    out.name = name;
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.length > DASHBOARD_LIMITS.description) {
      throw new DashboardError(`Keep the description under ${DASHBOARD_LIMITS.description} characters.`);
    }
    out.description = input.description.trim();
  }
  if (input.visibility !== undefined) {
    if (input.visibility !== "private" && input.visibility !== "team" && input.visibility !== "everyone") throw new DashboardError("Unknown visibility.");
    out.visibility = input.visibility;
  }
  if (input.team_id !== undefined) {
    if (input.team_id === null) out.team_id = null;
    else {
      const t = Number(input.team_id);
      if (!Number.isSafeInteger(t) || t <= 0) throw new DashboardError("Unknown team.");
      out.team_id = t;
    }
  }
  if (input.layout !== undefined) {
    const l = parseLayout(input.layout);
    if (!l.ok) throw new DashboardError(l.error);
    out.layout = l.value;
  }
  if (input.is_default !== undefined) out.is_default = input.is_default === true || input.is_default === 1 ? 1 : 0;
  return out;
}

async function checkSharing(c: Clean, current: { visibility: HdVisibility; team_id: number | null } | null, rights: DashboardRights): Promise<{ visibility: HdVisibility; team_id: number | null }> {
  const visibility = c.visibility ?? current?.visibility ?? "private";
  let team_id = c.team_id !== undefined ? c.team_id : current?.team_id ?? null;
  if (visibility !== "team") team_id = null;
  if (visibility === "team") {
    if (!team_id) throw new DashboardError("Pick the team to share it with.");
    if (!(await hqOne("SELECT 1 FROM hd_teams WHERE id = $1", [team_id]))) throw new DashboardError("Unknown team.");
    if (!rights.all && !rights.teams.includes(team_id)) throw new DashboardError("You can only share with a team you belong to.", 403);
  }
  if (visibility === "everyone" && !rights.all && !rights.team) throw new DashboardError("Sharing with everyone needs team or all reports.", 403);
  return { visibility, team_id };
}

async function clearDefault(c: PoolClient, except: number): Promise<void> {
  await c.query("UPDATE hd_dashboards SET is_default = 0 WHERE is_default = 1 AND id <> $1", [except]);
}

export async function createDashboard(viewer: Viewer, input: DashboardInput): Promise<HdDashboard> {
  await seedBuiltinDashboards();
  const rights = await dashboardRights(viewer);
  const c = clean(input, false);
  const share = await checkSharing(c, null, rights);
  if (c.is_default && !rights.all) throw new DashboardError("Only someone with all reports can choose the default dashboard.", 403);
  const owned = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_dashboards WHERE owner_id = $1", [viewer.id]);
  if ((owned?.n ?? 0) >= DASHBOARD_LIMITS.dashboardsPerUser) throw new DashboardError(`You can keep up to ${DASHBOARD_LIMITS.dashboardsPerUser} dashboards.`);
  const layout = c.layout ?? { widgets: [], filters: {}, range: { preset: "last_30" }, compare: "previous_period" };
  const id = await withTx(async (tx) => {
    const r = await tx.query<{ id: number }>(
      `INSERT INTO hd_dashboards (name, description, owner_id, visibility, team_id, layout, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [c.name, c.description ?? "", viewer.id, share.visibility, share.team_id, JSON.stringify(layout), c.is_default ?? 0]
    );
    if (c.is_default) await clearDefault(tx, r.rows[0].id);
    return r.rows[0].id;
  });
  return (await getDashboard(id, viewer))!;
}

async function editable(id: number, viewer: Viewer): Promise<{ row: Row; rights: DashboardRights }> {
  await seedBuiltinDashboards();
  const row = await hqOne<Row>(`SELECT ${COLS} FROM ${FROM} WHERE d.id = $1`, [id]);
  const rights = await dashboardRights(viewer);
  if (!row || !canSee(row, viewer, rights)) throw new DashboardError("That dashboard doesn't exist.", 404);
  return { row, rights };
}

export async function updateDashboard(id: number, viewer: Viewer, input: DashboardInput): Promise<{ before: HdDashboard; after: HdDashboard }> {
  const { row, rights } = await editable(id, viewer);
  const c = clean(input, true);
  // Making a dashboard the default is a workspace choice, allowed on a built-in too.
  const onlyDefault = Object.keys(c).length === 1 && c.is_default !== undefined;
  if (c.is_default !== undefined && !rights.all) throw new DashboardError("Only someone with all reports can choose the default dashboard.", 403);
  if (!onlyDefault && !canEdit(row, viewer, rights)) {
    throw new DashboardError(row.builtin ? "Built-in dashboards can't be changed. Duplicate it to make your own." : "You can't change this dashboard.", 403);
  }
  const share = onlyDefault ? { visibility: row.visibility, team_id: row.team_id } : await checkSharing(c, row, rights);
  // Only the owner may take a shared dashboard private (it would vanish for its other editors).
  if (share.visibility === "private" && row.visibility !== "private" && row.owner_id !== viewer.id) {
    throw new DashboardError("Only its owner can make a shared dashboard private.", 403);
  }
  await withTx(async (tx) => {
    await tx.query(
      `UPDATE hd_dashboards SET name = COALESCE($2, name), description = COALESCE($3, description), visibility = $4, team_id = $5,
              layout = COALESCE($6::jsonb, layout), is_default = COALESCE($7, is_default), updated_at = now()
        WHERE id = $1`,
      [id, c.name ?? null, c.description ?? null, share.visibility, share.team_id, c.layout ? JSON.stringify(c.layout) : null, c.is_default ?? null]
    );
    if (c.is_default) await clearDefault(tx, id);
  });
  return { before: shape(row, viewer, rights), after: (await getDashboard(id, viewer))! };
}

export async function deleteDashboard(id: number, viewer: Viewer): Promise<HdDashboard> {
  const { row, rights } = await editable(id, viewer);
  if (!canEdit(row, viewer, rights)) throw new DashboardError(row.builtin ? "Built-in dashboards can't be deleted." : "You can't delete this dashboard.", 403);
  if (row.owner_id !== viewer.id && !rights.all) throw new DashboardError("Only its owner or someone with all reports can delete a shared dashboard.", 403);
  await withTx(async (tx) => {
    await tx.query("DELETE FROM hd_dashboards WHERE id = $1", [id]);
    // The default went with it: the built-in Overview takes over.
    if (row.is_default) await tx.query("UPDATE hd_dashboards SET is_default = 1 WHERE builtin = 'overview'");
  });
  return shape(row, viewer, rights);
}

/** A private copy for the viewer ("Overview (copy)"). */
export async function duplicateDashboard(id: number, viewer: Viewer, name?: unknown): Promise<HdDashboard> {
  const src = await getDashboard(id, viewer);
  if (!src) throw new DashboardError("That dashboard doesn't exist.", 404);
  const copyName = typeof name === "string" && name.trim() ? name : `${src.name} (copy)`.slice(0, DASHBOARD_LIMITS.name);
  return createDashboard(viewer, { name: copyName, description: src.description, visibility: "private", layout: src.layout });
}
