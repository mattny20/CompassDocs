import "server-only";
import { pool } from "./db";
import type { SpaceScope } from "./space-scope";
import { handbookFilterSql, type FindScope } from "./handbook-visibility";
import type { DocStatus, DocType } from "./types";

// The home dashboard's own queries (1.17.0): Latest in your spaces (with the
// Following view), Popular this week and the status strip. Every document
// query takes the viewer's SpaceScope from lib/access and the drafts flag
// the page already resolved (canSeeDrafts), the way listRecentDocuments
// does, so a tile can never list a document its reader could not open.
// Handbooks 1.18.0 (H6): the document lists also take the viewer's FindScope
// (findScopeFor), so Latest and Popular leave handbook-only documents out for
// readers, as the Ask page's suggestions and the old dashboard did.

async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

export interface DashboardDoc {
  id: number;
  title: string;
  type: DocType;
  status: DocStatus;
  author: string;
  updated_at: string;
  space_id: number;
  space_name: string;
  space_slug: string;
  space_icon: string;
  space_color: string;
}

const DOC_COLUMNS = `d.id, d.title, d.type, d.status, d.author, d.updated_at, d.space_id,
  s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon, s.color AS space_color`;

/**
 * The spaces this person follows: a personal subscription, or a group the
 * admin subscribed to the space that the person has not muted — the same
 * audience the space's update mail goes to (listSubscriberIds). Only spaces
 * in the scope count.
 */
export async function listFollowedSpaceIds(userId: number, scope: SpaceScope): Promise<number[]> {
  const scoped = Array.isArray(scope) ? " AND s.id = ANY($2)" : "";
  const rows = await q<{ id: number }>(
    `SELECT s.id FROM spaces s
     WHERE (
       EXISTS (SELECT 1 FROM space_subscriptions ss
               WHERE ss.space_id = s.id AND ss.user_id = $1 AND ss.state = 'subscribed')
       OR (
         EXISTS (SELECT 1 FROM space_subscription_groups sg
                 JOIN group_members gm ON gm.group_id = sg.group_id
                 WHERE sg.space_id = s.id AND gm.user_id = $1)
         AND NOT EXISTS (SELECT 1 FROM space_subscriptions ss
                         WHERE ss.space_id = s.id AND ss.user_id = $1 AND ss.state = 'muted')
       )
     )${scoped}
     ORDER BY s.id`,
    Array.isArray(scope) ? [userId, scope] : [userId]
  );
  return rows.map((r) => r.id);
}

/**
 * Recently updated documents, newest first. `spaceIds` narrows to those
 * spaces (the Following view; an empty list matches nothing) on top of the
 * scope; `excludeIds` drops what the pick-up cards above already show.
 */
export async function listLatestDocuments(opts: {
  scope: SpaceScope;
  includeDrafts: boolean;
  spaceIds?: number[];
  excludeIds?: number[];
  limit?: number;
  /** Handbooks 1.18.0 (H6): hide handbook-only documents outside these spaces; omit for none hidden. */
  find?: FindScope;
}): Promise<DashboardDoc[]> {
  const conds = ["d.deleted_at IS NULL", "d.branch_of IS NULL"];
  const params: unknown[] = [];
  if (!opts.includeDrafts) conds.push("d.status = 'published'");
  if (Array.isArray(opts.scope)) {
    params.push(opts.scope);
    conds.push(`d.space_id = ANY($${params.length})`);
  }
  if (opts.spaceIds) {
    params.push(opts.spaceIds);
    conds.push(`d.space_id = ANY($${params.length})`);
  }
  if (opts.excludeIds?.length) {
    params.push(opts.excludeIds);
    conds.push(`NOT (d.id = ANY($${params.length}))`);
  }
  const hidden = handbookFilterSql("d", opts.find, params); // Handbooks 1.18.0 (H6)
  params.push(opts.limit ?? 8);
  return q<DashboardDoc>(
    `SELECT ${DOC_COLUMNS}
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE ${conds.join(" AND ")}${hidden}
     ORDER BY d.updated_at DESC, d.id DESC LIMIT $${params.length}`,
    params
  );
}

// The week's view counts per document are the same for every viewer, and
// counting a busy week of views on every dashboard load is the expensive
// part: one process-wide copy (the most-read POPULAR_POOL documents) serves
// all dashboards for POPULAR_TTL_MS, and each viewer's scope is applied to
// it afterwards. Handbooks 1.18.0 (H6): so is the viewer's FindScope — the
// cached counts are everyone's, and the handbook-only filter belongs to the
// per-viewer query below, never to the cache.
const POPULAR_TTL_MS = 5 * 60_000;
const POPULAR_POOL = 500;
let popularCache: { at: number; rows: Promise<{ document_id: number; views: number }[]> } | null = null;
function weeklyViewCounts(): Promise<{ document_id: number; views: number }[]> {
  const now = Date.now();
  if (!popularCache || now - popularCache.at > POPULAR_TTL_MS) {
    const rows = q<{ document_id: number; views: number }>(
      `SELECT v.document_id, COUNT(*)::int AS views FROM doc_views v
       WHERE v.viewed_at > now() - interval '7 days'
       GROUP BY v.document_id ORDER BY COUNT(*) DESC LIMIT $1`,
      [POPULAR_POOL]
    );
    popularCache = { at: now, rows };
    rows.catch(() => {
      if (popularCache?.rows === rows) popularCache = null;
    });
  }
  return popularCache.rows;
}

/**
 * The most-read documents of the last 7 days among those the viewer can
 * read, with their view counts (every recorded view, the in-app reader and
 * the public site alike, as the Ask page's suggestions count them).
 */
export async function listPopularThisWeek(
  scope: SpaceScope,
  includeDrafts: boolean,
  limit = 5,
  /** Handbooks 1.18.0 (H6): hide handbook-only documents outside these spaces; omit for none hidden. */
  find?: FindScope
): Promise<(DashboardDoc & { views: number })[]> {
  const counts = await weeklyViewCounts();
  if (counts.length === 0) return [];
  const conds = ["d.deleted_at IS NULL", "d.branch_of IS NULL"];
  const params: unknown[] = [limit, counts.map((c) => c.document_id), counts.map((c) => c.views)];
  if (!includeDrafts) conds.push("d.status = 'published'");
  if (Array.isArray(scope)) {
    params.push(scope);
    conds.push(`d.space_id = ANY($${params.length})`);
  }
  const hidden = handbookFilterSql("d", find, params); // Handbooks 1.18.0 (H6): per viewer, after the shared cache
  return q(
    `SELECT ${DOC_COLUMNS}, pv.views
     FROM unnest($2::int[], $3::int[]) AS pv(document_id, views)
     JOIN documents d ON d.id = pv.document_id
     JOIN spaces s ON s.id = d.space_id
     WHERE ${conds.join(" AND ")}${hidden}
     ORDER BY pv.views DESC, d.updated_at DESC, d.id DESC LIMIT $1`,
    params
  );
}

export type StripStatus = "operational" | "degraded" | "outage" | "maintenance" | "unknown";

export interface StripService {
  id: number;
  name: string;
  status: StripStatus;
  /** What is wrong, in the service's or the incident's own words; '' when nothing is. */
  detail: string;
}

const RANK: Record<string, number> = { outage: 0, degraded: 1, maintenance: 2, unknown: 3, operational: 4 };

/**
 * Every tracked service with its standing for the status strip: the worse of
 * the polled (or declared) status and any open incident on it. Problems
 * first (outage, degraded, maintenance), then by name. Empty when nothing
 * is tracked, and the strip is then left out.
 */
export async function listStatusStrip(): Promise<StripService[]> {
  const rows = await q<{
    id: number;
    name: string;
    status: string;
    status_detail: string;
    incident_severity: string | null;
    incident_title: string | null;
  }>(
    `SELECT s.id, s.name, s.status, s.status_detail, i.severity AS incident_severity, i.title AS incident_title
     FROM status_services s
     LEFT JOIN LATERAL (
       SELECT severity, title FROM status_incidents
       WHERE service_id = s.id AND state = 'open'
       ORDER BY CASE severity WHEN 'outage' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, created_at DESC
       LIMIT 1
     ) i ON true
     ORDER BY s.name, s.id`
  );
  const out = rows.map((r) => {
    const polled = (r.status in RANK ? r.status : "unknown") as StripStatus;
    const incident = r.incident_severity && r.incident_severity in RANK ? (r.incident_severity as StripStatus) : null;
    const byIncident = incident !== null && RANK[incident] < RANK[polled];
    const status = byIncident ? incident : polled;
    const problem = RANK[status] <= RANK.maintenance;
    return {
      id: r.id,
      name: r.name,
      status,
      detail: problem ? ((byIncident ? r.incident_title : r.status_detail) || r.incident_title || "").trim() : "",
    };
  });
  return out.sort((a, b) => Math.min(RANK[a.status], 3) - Math.min(RANK[b.status], 3) || a.name.localeCompare(b.name));
}
