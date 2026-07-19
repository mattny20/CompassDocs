import "server-only";
import { pool } from "./db";

// Knowledge-base analytics: event recording (views with duration heartbeats,
// searches, downloads) and the aggregations behind the /analytics dashboard.
// Raw events live in doc_views / search_events / download_events; everything
// here is computed at read time — no rollup jobs to maintain.

async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

// --- Recording ----------------------------------------------------------------

export async function recordView(
  documentId: number,
  userId: number | null,
  source: "app" | "public"
): Promise<number> {
  const r = await q<{ id: number }>(
    "INSERT INTO doc_views (document_id, user_id, source) VALUES ($1,$2,$3) RETURNING id",
    [documentId, userId, source]
  );
  return r[0].id;
}

/** Heartbeat: extend a view's duration (capped at 30 minutes). The user check
 * stops one session from inflating another user's rows. */
export async function touchView(
  viewId: number,
  userId: number | null,
  seconds: number
): Promise<void> {
  await q(
    `UPDATE doc_views SET duration_seconds = LEAST(1800, GREATEST(duration_seconds, $1))
     WHERE id = $2 AND user_id IS NOT DISTINCT FROM $3`,
    [Math.max(0, Math.floor(seconds)), viewId, userId]
  );
}

/**
 * Record a search. Typing produces prefix bursts ("dep", "deplo", "deploy"),
 * so an event from the same user+source in the last 15s that is a prefix of
 * the new query (or vice versa) is replaced instead of double-counted.
 */
export async function recordSearch(
  userId: number | null,
  query: string,
  results: number,
  source: "search" | "ask" | "public"
): Promise<void> {
  const trimmed = query.trim().slice(0, 200);
  if (!trimmed) return;
  await q(
    `DELETE FROM search_events
     WHERE user_id IS NOT DISTINCT FROM $1 AND source = $2
       AND searched_at > now() - interval '15 seconds'
       AND (lower($3) LIKE lower(query) || '%' OR lower(query) LIKE lower($3) || '%')`,
    [userId, source, trimmed]
  );
  await q("INSERT INTO search_events (user_id, query, results, source) VALUES ($1,$2,$3,$4)", [
    userId,
    trimmed,
    results,
    source,
  ]);
}

export async function recordDownload(
  attachmentId: number,
  documentId: number,
  userId: number | null,
  filename: string
): Promise<void> {
  await q(
    "INSERT INTO download_events (attachment_id, document_id, user_id, filename) VALUES ($1,$2,$3,$4)",
    [attachmentId, documentId, userId, filename]
  );
}

// --- Aggregation --------------------------------------------------------------

export interface AnalyticsFilters {
  /** Days of history (window ends now). */
  days: number;
  spaceId?: number;
  categoryId?: number;
  author?: string;
  tag?: string;
  /** Space ids visible to the caller ("all" = unrestricted). */
  scope: number[] | "all";
}

/** WHERE fragment + params for doc-scoped filters. Every condition references
 * the `d` (documents) alias only, so the fragment is safe in any query that
 * joins documents AS d. */
function docFilter(f: AnalyticsFilters, params: unknown[]): string {
  const conds = ["d.deleted_at IS NULL", "d.branch_of IS NULL"];
  if (Array.isArray(f.scope)) {
    params.push(f.scope);
    conds.push(`d.space_id = ANY($${params.length})`);
  }
  if (f.spaceId) {
    params.push(f.spaceId);
    conds.push(`d.space_id = $${params.length}`);
  }
  if (f.categoryId) {
    params.push(f.categoryId);
    conds.push(`d.category_id = $${params.length}`);
  }
  if (f.author) {
    params.push(f.author.toLowerCase());
    conds.push(`lower(d.author) = $${params.length}`);
  }
  if (f.tag) {
    params.push(`%${f.tag.toLowerCase()}%`);
    conds.push(`lower(d.tags) LIKE $${params.length}`);
  }
  return conds.join(" AND ");
}

const DOC_JOIN = "JOIN documents d ON d.id = v.document_id";

/** KPI totals for the window plus the immediately preceding window (deltas). */
export async function overview(f: AnalyticsFilters) {
  const params: unknown[] = [f.days];
  const filter = docFilter(f, params);
  const [row] = await q(
    `WITH cur AS (
       SELECT v.* FROM doc_views v ${DOC_JOIN}
       WHERE v.viewed_at > now() - ($1 * interval '1 day') AND ${filter}
     ), prev AS (
       SELECT v.* FROM doc_views v ${DOC_JOIN}
       WHERE v.viewed_at <= now() - ($1 * interval '1 day')
         AND v.viewed_at > now() - (2 * $1 * interval '1 day') AND ${filter}
     )
     SELECT
       (SELECT COUNT(*) FROM cur)::int                                   AS views,
       (SELECT COUNT(*) FROM prev)::int                                  AS views_prev,
       (SELECT COUNT(DISTINCT COALESCE(user_id::text, 'anon-' || id::text)) FROM cur)::int AS unique_viewers,
       (SELECT COUNT(DISTINCT COALESCE(user_id::text, 'anon-' || id::text)) FROM prev)::int AS unique_viewers_prev,
       (SELECT COUNT(DISTINCT document_id) FROM cur)::int                AS docs_viewed,
       (SELECT COUNT(*) FROM cur WHERE source = 'public')::int           AS public_views,
       (SELECT COALESCE(ROUND(AVG(NULLIF(duration_seconds, 0))), 0) FROM cur)::int AS avg_seconds,
       (SELECT COALESCE(ROUND(AVG(NULLIF(duration_seconds, 0))), 0) FROM prev)::int AS avg_seconds_prev`,
    params
  );

  const dparams: unknown[] = [f.days];
  const dfilter = docFilter(f, dparams);
  const [dl] = await q(
    `SELECT
       (SELECT COUNT(*) FROM download_events e JOIN documents d ON d.id = e.document_id
         WHERE e.downloaded_at > now() - ($1 * interval '1 day') AND ${dfilter})::int AS downloads,
       (SELECT COUNT(*) FROM download_events e JOIN documents d ON d.id = e.document_id
         WHERE e.downloaded_at <= now() - ($1 * interval '1 day')
           AND e.downloaded_at > now() - (2 * $1 * interval '1 day') AND ${dfilter})::int AS downloads_prev`,
    dparams
  );

  const [s] = await q(
    `SELECT
       (SELECT COUNT(*) FROM search_events WHERE searched_at > now() - ($1 * interval '1 day'))::int AS searches,
       (SELECT COUNT(*) FROM search_events WHERE searched_at <= now() - ($1 * interval '1 day')
          AND searched_at > now() - (2 * $1 * interval '1 day'))::int AS searches_prev,
       (SELECT COUNT(*) FROM search_events WHERE searched_at > now() - ($1 * interval '1 day') AND results = 0)::int AS zero_searches`,
    [f.days]
  );
  return { ...row, ...dl, ...s };
}

/** Daily view counts (app vs public) and daily active users, for the chart. */
export async function viewsOverTime(f: AnalyticsFilters) {
  const params: unknown[] = [f.days];
  const filter = docFilter(f, params);
  return q(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day,
            COALESCE(app_views, 0)::int AS app_views,
            COALESCE(public_views, 0)::int AS public_views,
            COALESCE(active_users, 0)::int AS active_users
     FROM generate_series(
       date_trunc('day', now() - (($1 - 1) * interval '1 day')),
       date_trunc('day', now()), interval '1 day') AS day
     LEFT JOIN (
       SELECT date_trunc('day', v.viewed_at) AS d,
              COUNT(*) FILTER (WHERE v.source = 'app') AS app_views,
              COUNT(*) FILTER (WHERE v.source = 'public') AS public_views,
              COUNT(DISTINCT v.user_id) AS active_users
       FROM doc_views v ${DOC_JOIN}
       WHERE v.viewed_at > now() - ($1 * interval '1 day') AND ${filter}
       GROUP BY 1
     ) x ON x.d = day
     ORDER BY day`,
    params
  );
}

/** Most-viewed documents with uniques, avg time, downloads, and daily spark. */
export async function topDocuments(f: AnalyticsFilters, limit = 10) {
  const params: unknown[] = [f.days];
  const filter = docFilter(f, params);
  params.push(limit);
  return q(
    `SELECT d.id, d.title, d.author, s.name AS space_name, s.icon AS space_icon,
            COUNT(v.id)::int AS views,
            COUNT(DISTINCT v.user_id)::int AS unique_viewers,
            COUNT(v.id) FILTER (WHERE v.source = 'public')::int AS public_views,
            COALESCE(ROUND(AVG(NULLIF(v.duration_seconds, 0))), 0)::int AS avg_seconds,
            (SELECT COUNT(*) FROM download_events e
              WHERE e.document_id = d.id AND e.downloaded_at > now() - ($1 * interval '1 day'))::int AS downloads
     FROM doc_views v ${DOC_JOIN} JOIN spaces s ON s.id = d.space_id
     WHERE v.viewed_at > now() - ($1 * interval '1 day') AND ${filter}
     GROUP BY d.id, d.title, d.author, s.name, s.icon
     ORDER BY views DESC, unique_viewers DESC
     LIMIT $${params.length}`,
    params
  );
}

/** Published documents with the FEWEST views in the window (including zero). */
export async function leastViewed(f: AnalyticsFilters, limit = 10) {
  const params: unknown[] = [f.days];
  const filter = docFilter(f, params);
  params.push(limit);
  return q(
    `SELECT d.id, d.title, d.author, s.name AS space_name, s.icon AS space_icon,
            to_char(d.updated_at, 'YYYY-MM-DD') AS updated,
            COALESCE(x.views, 0)::int AS views
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     LEFT JOIN (
       SELECT dv.document_id, COUNT(*) AS views FROM doc_views dv
       WHERE dv.viewed_at > now() - ($1 * interval '1 day')
       GROUP BY dv.document_id
     ) x ON x.document_id = d.id
     WHERE d.status = 'published' AND ${filter}
     ORDER BY views ASC, d.updated_at ASC
     LIMIT $${params.length}`,
    params
  );
}

/** Documents gaining the most vs the previous window. */
export async function trendingDocuments(f: AnalyticsFilters, limit = 8) {
  const params: unknown[] = [f.days];
  const filter = docFilter(f, params);
  params.push(limit);
  return q(
    `SELECT d.id, d.title, s.name AS space_name, s.icon AS space_icon,
            COUNT(v.id) FILTER (WHERE v.viewed_at > now() - ($1 * interval '1 day'))::int AS views,
            COUNT(v.id) FILTER (WHERE v.viewed_at <= now() - ($1 * interval '1 day'))::int AS prev_views
     FROM doc_views v ${DOC_JOIN} JOIN spaces s ON s.id = d.space_id
     WHERE v.viewed_at > now() - (2 * $1 * interval '1 day') AND ${filter}
     GROUP BY d.id, d.title, s.name, s.icon
     HAVING COUNT(v.id) FILTER (WHERE v.viewed_at > now() - ($1 * interval '1 day')) > 0
     ORDER BY (COUNT(v.id) FILTER (WHERE v.viewed_at > now() - ($1 * interval '1 day'))
             - COUNT(v.id) FILTER (WHERE v.viewed_at <= now() - ($1 * interval '1 day'))) DESC,
             views DESC
     LIMIT $${params.length}`,
    params
  );
}

export async function topSearches(days: number, limit = 10) {
  return q(
    `SELECT lower(query) AS query, COUNT(*)::int AS count,
            ROUND(AVG(results))::int AS avg_results,
            COUNT(*) FILTER (WHERE results = 0)::int AS zero_hits
     FROM search_events WHERE searched_at > now() - ($1 * interval '1 day')
     GROUP BY lower(query) ORDER BY count DESC, query LIMIT $2`,
    [days, limit]
  );
}

export async function zeroResultSearches(days: number, limit = 10) {
  return q(
    `SELECT lower(query) AS query, COUNT(*)::int AS count,
            to_char(MAX(searched_at), 'YYYY-MM-DD') AS last
     FROM search_events
     WHERE searched_at > now() - ($1 * interval '1 day') AND results = 0
     GROUP BY lower(query) ORDER BY count DESC, MAX(searched_at) DESC LIMIT $2`,
    [days, limit]
  );
}

/** Most engaged readers: views, breadth, and time spent. */
export async function topReaders(f: AnalyticsFilters, limit = 10) {
  const params: unknown[] = [f.days];
  const filter = docFilter(f, params);
  params.push(limit);
  return q(
    `SELECT u.id, u.name, u.username, u.role,
            COUNT(v.id)::int AS views,
            COUNT(DISTINCT v.document_id)::int AS docs,
            COALESCE(SUM(v.duration_seconds), 0)::int AS seconds,
            to_char(MAX(v.viewed_at), 'YYYY-MM-DD') AS last_active
     FROM doc_views v ${DOC_JOIN} JOIN users u ON u.id = v.user_id
     WHERE v.viewed_at > now() - ($1 * interval '1 day') AND ${filter}
     GROUP BY u.id, u.name, u.username, u.role
     ORDER BY views DESC LIMIT $${params.length}`,
    params
  );
}

/** Author scoreboard: reach of each author's live documents in the window. */
export async function authorStats(f: AnalyticsFilters, limit = 10) {
  const params: unknown[] = [f.days];
  const filter = docFilter(f, params);
  params.push(limit);
  return q(
    `SELECT d.author,
            COUNT(DISTINCT d.id)::int AS docs,
            COUNT(v.id)::int AS views,
            COUNT(DISTINCT v.user_id)::int AS unique_viewers,
            COALESCE(ROUND(AVG(NULLIF(v.duration_seconds, 0))), 0)::int AS avg_seconds,
            ROUND(COUNT(v.id)::numeric / GREATEST(COUNT(DISTINCT d.id), 1), 1)::float AS views_per_doc
     FROM documents d
     LEFT JOIN doc_views v ON v.document_id = d.id AND v.viewed_at > now() - ($1 * interval '1 day')
     WHERE d.status = 'published' AND ${filter}
     GROUP BY d.author
     ORDER BY views DESC, docs DESC LIMIT $${params.length}`,
    params
  );
}

/** Latest view / search / download events, merged, for the activity feed. */
export async function recentActivity(f: AnalyticsFilters, limit = 15) {
  const params: unknown[] = [f.days];
  const filter = docFilter(f, params);
  params.push(limit);
  return q(
    `SELECT * FROM (
       SELECT 'view' AS kind, v.viewed_at AS at, u.name AS user_name, v.source,
              d.id AS doc_id, d.title AS doc_title, NULL AS detail
       FROM doc_views v ${DOC_JOIN} LEFT JOIN users u ON u.id = v.user_id
       WHERE v.viewed_at > now() - ($1 * interval '1 day') AND ${filter}
       UNION ALL
       SELECT 'search', se.searched_at, u.name, se.source, NULL, NULL,
              se.query || ' (' || se.results || ')'
       FROM search_events se LEFT JOIN users u ON u.id = se.user_id
       WHERE se.searched_at > now() - ($1 * interval '1 day')
       UNION ALL
       SELECT 'download', e.downloaded_at, u.name, 'app', d.id, d.title, e.filename
       FROM download_events e JOIN documents d ON d.id = e.document_id
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.downloaded_at > now() - ($1 * interval '1 day') AND ${filter}
     ) x ORDER BY at DESC LIMIT $${params.length}`,
    params
  );
}

/** Per-document drill-down: daily views, top readers, and totals. */
export async function documentDetail(documentId: number, days: number) {
  const [daily, readers, [totals], downloads] = await Promise.all([
    q(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day,
              COALESCE(app_views, 0)::int AS app_views,
              COALESCE(public_views, 0)::int AS public_views
       FROM generate_series(
         date_trunc('day', now() - (($2 - 1) * interval '1 day')),
         date_trunc('day', now()), interval '1 day') AS day
       LEFT JOIN (
         SELECT date_trunc('day', viewed_at) AS d,
                COUNT(*) FILTER (WHERE source = 'app') AS app_views,
                COUNT(*) FILTER (WHERE source = 'public') AS public_views
         FROM doc_views WHERE document_id = $1 AND viewed_at > now() - ($2 * interval '1 day')
         GROUP BY 1
       ) x ON x.d = day ORDER BY day`,
      [documentId, days]
    ),
    q(
      `SELECT u.name, u.username, COUNT(*)::int AS views,
              COALESCE(SUM(v.duration_seconds), 0)::int AS seconds
       FROM doc_views v JOIN users u ON u.id = v.user_id
       WHERE v.document_id = $1 AND v.viewed_at > now() - ($2 * interval '1 day')
       GROUP BY u.id, u.name, u.username ORDER BY views DESC LIMIT 8`,
      [documentId, days]
    ),
    q(
      `SELECT COUNT(*)::int AS views,
              COUNT(DISTINCT COALESCE(user_id::text, 'anon-' || id::text))::int AS unique_viewers,
              COUNT(*) FILTER (WHERE source = 'public')::int AS public_views,
              COALESCE(ROUND(AVG(NULLIF(duration_seconds, 0))), 0)::int AS avg_seconds
       FROM doc_views WHERE document_id = $1 AND viewed_at > now() - ($2 * interval '1 day')`,
      [documentId, days]
    ),
    q(
      `SELECT COUNT(*)::int AS downloads FROM download_events
       WHERE document_id = $1 AND downloaded_at > now() - ($2 * interval '1 day')`,
      [documentId, days]
    ),
  ]);
  return { daily, readers, totals: { ...totals, downloads: downloads[0].downloads } };
}
