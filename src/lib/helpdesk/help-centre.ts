// Helpdesk 1.19.4 (C3): the customer portal help centre. Customers (anyone
// who can reach /support, signed in or not) search and read a chosen set
// of the workspace's documents before raising a request. Server-only.
//
// WHAT IS PUBLIC: one function decides, publicArticleScope below; its two
// readers (publicHelpArticles, publicHelpCounts) only add a SELECT. Every
// surface that shows a document to the portal goes through it: the help
// centre home (categories and their counts), a category page, search and
// the suggestions as you type, the request form's suggestions, an article
// page, the links between articles, and the files an article carries. No
// other code selects documents for the portal.
//
// A document is public when ALL of these hold:
//   - the help centre is on, and the portal is open (licensed and on);
//   - it is chosen: in one of the chosen spaces (while "Documents in chosen
//     spaces" is on), or tagged `public` (while "Documents tagged public"
//     is on);
//   - its category (folder, or the space's unfiled documents) is not
//     switched off on the settings page;
//   - and it is not restricted, nor is any page above it (parent_id, up to
//     20 levels): restricted is
//       * in the trash (deleted_at),
//       * a draft (status), or a draft branch of another document
//         (branch_of), whatever its status says,
//       * in a private space (whatever the settings name),
//       * handbook-only ("Where people find it", stored as handbook_only:
//         stricter than the app's no-orphans rule, which treats an orphan
//         as a space document),
//       * a policy people must confirm they have read (ack_required), or a
//         retired one (ack_retired_at): these are obligations for staff,
//       * a live training deck.
//
// What an article carries out is an allowlist (HelpArticle): id, title,
// summary, updated date, category name and, for the article page, the
// body. Never the author, an editor's or commenter's email, comments,
// version history, tags, the space's own settings or a reviewer. HTML
// comments (an author's notes to themselves) are removed from the body
// (publicBody), and search matches only the text the outside reads (title,
// summary, body without comments; never tags). Every address in the body
// is decided on the parsed tree (helpCentreUrl through MarkdownView's
// rewriteUrl): files point at the help centre's own file route, links to
// other documents point at their article when that article is public and
// keep only their text when not, any other address into the workspace is
// dropped, and other sites' addresses stay as written.
//
// Stats. Searches and "answered without a request" are counted without
// personal data (lib/helpdesk/help-centre-schema): no contact, account or
// network address, queries redacted, a random per-tab journey id. Only
// searches the help centre's own pages make count (never a link from
// elsewhere, never the request form's subject). A journey ends in a
// request when the portal's request route creates one carrying its id;
// the sign-in link carries the id to the browser that opens the email.

import "server-only";
import { getSetting, setSetting } from "../db";
import { getAppSettings } from "../settings-store";
import { spaceScopeFor } from "../access";
import { scopeAllows } from "../space-scope";
import type { Role } from "../types";
import { hq, hqOne } from "./db-core";
import { hdRateLimited } from "./access";
import { getPortalSettings, portalOpen, type PortalSettings } from "./portal";
import {
  DEFAULT_HELP_CENTRE_SETTINGS,
  HC_ANSWERED_AFTER_MS,
  HC_LIMITS,
  HC_PUBLIC_TAG,
  HC_STATS_DAYS,
  articleHref,
  cleanHelpCentreSettings,
  cleanHelpQuery,
  cleanJourneyId,
  isCategoryKey,
  queryWords,
  redactQuery,
  type HelpCentreSettings,
  type HelpCentreStats,
  type HelpSuggestion,
} from "./help-centre-shared";

export * from "./help-centre-shared";

// --- Settings ------------------------------------------------------------------------

export const HD_HELP_CENTRE_SETTINGS_KEY = "helpdesk_portal_hc";

export async function getHelpCentreSettings(): Promise<HelpCentreSettings> {
  try {
    const raw = await getSetting(HD_HELP_CENTRE_SETTINGS_KEY);
    return cleanHelpCentreSettings(raw ? JSON.parse(raw) : DEFAULT_HELP_CENTRE_SETTINGS);
  } catch {
    return cleanHelpCentreSettings(DEFAULT_HELP_CENTRE_SETTINGS);
  }
}

/** Save the settings (cleaned); answers what changed, by key. */
export async function saveHelpCentreSettings(raw: unknown): Promise<{ settings: HelpCentreSettings; changed: (keyof HelpCentreSettings)[] }> {
  const before = await getHelpCentreSettings();
  const next = cleanHelpCentreSettings(raw);
  const changed = (Object.keys(next) as (keyof HelpCentreSettings)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
  if (changed.length) await setSetting(HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(next));
  return { settings: next, changed };
}

/** The settings a caller already read, so one request reads them once (and tests pass their own). */
export interface HelpCentreContext {
  hc?: HelpCentreSettings;
  portal?: PortalSettings;
}

async function resolve(given?: HelpCentreContext): Promise<{ hc: HelpCentreSettings; portal: PortalSettings }> {
  const [hc, portal] = await Promise.all([given?.hc ?? getHelpCentreSettings(), given?.portal ?? getPortalSettings()]);
  return { hc, portal };
}

/** The help centre exists: the portal is open (licensed and on) and the help centre is switched on. */
export async function helpCentreOpen(given?: HelpCentreContext): Promise<boolean> {
  const { hc, portal } = await resolve(given);
  if (!hc.enabled) return false;
  try {
    return await portalOpen(portal);
  } catch {
    return false;
  }
}

// --- THE RULE ------------------------------------------------------------------------

/** What a public article carries out. An allowlist: add nothing here that the outside should not read. */
export interface HelpArticle {
  id: number;
  title: string;
  href: string;
  summary: string;
  updated_at: string;
  category: { key: string; name: string };
  /** The body as the outside reads it (publicBody); only when asked for. */
  body?: string;
}

export interface HelpArticleQuery {
  /** Only these documents. */
  ids?: number[];
  /** Matching this search (prefix words over the public text: title, summary and body without comments; title words too). */
  q?: string;
  /** With q: any of its words rather than all of them (the suggestions' second pass). */
  any?: boolean;
  /** Only this category key. */
  category?: string;
  /** At most this many (default 200, at most 5000). */
  limit?: number;
  /** Include the public body (an article page). */
  body?: boolean;
}

/**
 * True for a document row (`a`) that may never be public, whatever the
 * settings say. Every arm is listed in this module's header.
 */
function restrictedSql(a: string): string {
  return `(
    ${a}.deleted_at IS NOT NULL
    OR ${a}.status IS DISTINCT FROM 'published'
    OR ${a}.branch_of IS NOT NULL
    OR coalesce(${a}.find_mode, 'space') = 'handbook_only'
    OR coalesce(${a}.ack_required, 0) <> 0
    OR ${a}.ack_retired_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM spaces rs WHERE rs.id = ${a}.space_id AND rs.visibility IN ('public', 'internal'))
    OR EXISTS (SELECT 1 FROM training_decks rt WHERE rt.document_id = ${a}.id AND rt.archived_at IS NULL)
  )`;
}

const CATEGORY_KEY_SQL = `(CASE WHEN c.id IS NULL THEN 's' || d.space_id ELSE 'c' || c.id END)`;

/**
 * HTML comments, as publicBody removes them: from "<!--" to the first
 * "-->", or to the end when it never closes. The SQL twin (a PostgreSQL
 * ARE whose first quantifier is non-greedy, so the whole match is the
 * shortest, as in the JS) is COMMENT_SQL_RE.
 */
export const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
const COMMENT_SQL_RE = "<!--.*?(-->|$)";

/**
 * What a search may match: the text the outside reads. Title (A), summary
 * (B) and the body with its comments removed (C); never tags, never the
 * stored documents.search (which holds tags and the raw body).
 */
const PUBLIC_VECTOR_SQL = `(setweight(to_tsvector('english', coalesce(d.title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(d.summary, '')), 'B')
    || setweight(to_tsvector('english', regexp_replace(coalesce(d.content, ''), '${COMMENT_SQL_RE}', '', 'g')), 'C'))`;

interface PublicScope {
  hc: HelpCentreSettings;
  portal: PortalSettings;
  /** The WHERE over documents d, spaces s and space_categories c. */
  where: string;
  params: unknown[];
  /** "rank DESC, " for a search, else "". */
  rank: string;
}

/**
 * THE RULE: the one place that decides what the help centre may show.
 * Answers the SQL scope of the public articles matching `query` (over
 * documents d JOIN spaces s LEFT JOIN space_categories c), or null when
 * the help centre is closed or the query can match nothing. Both readers
 * below (the articles, and their counts by category) take their WHERE from
 * here and add nothing to it. See this module's header for the rule.
 */
export async function publicArticleScope(query: Omit<HelpArticleQuery, "limit" | "body"> = {}, given?: HelpCentreContext): Promise<PublicScope | null> {
  const { hc, portal } = await resolve(given);
  if (!(await helpCentreOpen({ hc, portal }))) return null;
  const spaces = hc.from_spaces ? hc.spaces : [];
  if (!spaces.length && !hc.tagged) return null;
  if (query.ids && !query.ids.length) return null;
  if (query.category !== undefined && !isCategoryKey(query.category)) return null;

  const params: unknown[] = [spaces, hc.tagged, hc.hidden, HC_PUBLIC_TAG];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [
    `NOT ${restrictedSql("d")}`,
    // No page above it is restricted either (a page under a draft, a
    // handbook-only policy or a document in the trash stays inside).
    `NOT EXISTS (
       WITH RECURSIVE up(id, parent_id, depth) AS (
         SELECT pd.id, pd.parent_id, 1 FROM documents pd WHERE pd.id = d.parent_id
         UNION ALL
         SELECT pd.id, pd.parent_id, up.depth + 1 FROM documents pd JOIN up ON pd.id = up.parent_id WHERE up.depth < 20
       )
       SELECT 1 FROM up JOIN documents a ON a.id = up.id WHERE ${restrictedSql("a")}
     )`,
    `((cardinality($1::int[]) > 0 AND d.space_id = ANY($1::int[]))
       OR ($2::boolean AND EXISTS (SELECT 1 FROM unnest(string_to_array(d.tags, ',')) tg(t) WHERE lower(btrim(tg.t)) = $4)))`,
    `NOT (${CATEGORY_KEY_SQL} = ANY($3::text[]))`,
  ];
  if (query.ids) where.push(`d.id = ANY(${p(query.ids.filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000))}::int[])`);
  if (query.category !== undefined) where.push(`${CATEGORY_KEY_SQL} = ${p(query.category)}`);

  let rank = "";
  if (query.q !== undefined) {
    const words = queryWords(cleanHelpQuery(query.q));
    if (!words.length) return null;
    const ts = p(words.map((w) => `${w}:*`).join(query.any ? " | " : " & "));
    const likes = p(words.map((w) => `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`));
    where.push(`(${PUBLIC_VECTOR_SQL} @@ to_tsquery('english', ${ts}) OR lower(d.title) LIKE ${query.any ? "ANY" : "ALL"}(${likes}::text[]))`);
    rank = `ts_rank(${PUBLIC_VECTOR_SQL}, to_tsquery('english', ${ts})) + (CASE WHEN lower(d.title) LIKE ALL(${likes}::text[]) THEN 1 ELSE 0 END) DESC, `;
  }
  return { hc, portal, where: where.join("\n        AND "), params, rank };
}

const FROM_SQL = `FROM documents d
       JOIN spaces s ON s.id = d.space_id
       LEFT JOIN space_categories c ON c.id = d.category_id AND c.space_id = d.space_id`;

/** The public articles matching `query` (publicArticleScope), or [] when the help centre is closed. */
export async function publicHelpArticles(query: HelpArticleQuery = {}, given?: HelpCentreContext): Promise<HelpArticle[]> {
  const scope = await publicArticleScope(query, given);
  if (!scope) return [];
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 200)), 5000);
  const rows = await hq<{
    id: number;
    title: string;
    slug: string;
    summary: string;
    updated_at: string;
    cat_key: string;
    cat_name: string;
    content?: string;
  }>(
    `SELECT d.id, d.title, d.slug, d.summary, d.updated_at,
            ${CATEGORY_KEY_SQL} AS cat_key, coalesce(c.name, s.name) AS cat_name
            ${query.body ? ", d.content" : ""}
       ${FROM_SQL}
      WHERE ${scope.where}
      ORDER BY ${scope.rank}coalesce(c.position, -1), lower(s.name), d.position, lower(d.title), d.id
      LIMIT ${limit}`,
    scope.params
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    href: articleHref(r.id, r.slug || r.title),
    summary: (r.summary ?? "").trim(),
    updated_at: r.updated_at,
    category: { key: r.cat_key, name: r.cat_name },
    ...(query.body ? { body: publicBody(r.content ?? "") } : {}),
  }));
}

export interface HelpCategory {
  key: string;
  name: string;
  count: number;
}

/** How many public articles each category holds (publicArticleScope; no row limit, no body). */
export async function publicHelpCounts(query: Pick<HelpArticleQuery, "category"> = {}, given?: HelpCentreContext): Promise<HelpCategory[]> {
  const scope = await publicArticleScope(query, given);
  if (!scope) return [];
  return hq<HelpCategory>(
    `SELECT ${CATEGORY_KEY_SQL} AS key, min(coalesce(c.name, s.name)) AS name, count(*)::int AS count
       ${FROM_SQL}
      WHERE ${scope.where}
      GROUP BY 1`,
    scope.params
  );
}

// --- The body as the outside reads it ----------------------------------------------------

/**
 * A published body for the outside: HTML comments (an author's notes to
 * themselves) removed, exactly as the search's public vector removes them.
 * Every address the body carries is then rewritten on the parsed tree by
 * helpCentreUrl (MarkdownView's rewriteUrl), after the sanitiser.
 */
export function publicBody(content: string): string {
  return content.replace(COMMENT_RE, "");
}

/**
 * Every document id the body might point at ("/doc/N" anywhere): a
 * superset, only used to look up which of them are public, so a link in
 * any form can be pointed at its article.
 */
export function linkedDocIds(content: string): number[] {
  const ids = new Set<number>();
  for (const m of content.matchAll(/\/doc\/(\d{1,10})/g)) ids.add(Number(m[1]));
  return [...ids].filter((n) => n > 0 && n <= 2_147_483_647);
}

export const HELP_FILE_PATH = "/support/api/help/files";

/** The host a relative address is resolved against (a stand-in: it is never a real host). */
const PORTAL_BASE = "http://portal.invalid/support/articles/";

export interface HelpUrlContext {
  /** Document id → its public article's address (only public ones). */
  publicHrefs: ReadonlyMap<number, string>;
  /** This workspace's own host names, lower-case (custom domain, the request's host). */
  ownHosts: ReadonlySet<string>;
}

/**
 * One address in a public article, decided on its parsed form (resolved
 * against the portal with dot segments normalised, so "/support/../doc/1"
 * is /doc/1): an address on another site stays as written; mailto: and tel:
 * stay; on this workspace (a relative address, or one of `ownHosts`):
 *   /doc/N              → its article when public, else dropped
 *   /api/attachments/N  → /support/api/help/files/N (served only for a public article)
 *   the portal's pages  → kept (/support and under it, its API excepted but
 *                         for the help centre's files)
 *   anything else       → dropped.
 * Null means drop: a link keeps its text, an image or video goes.
 */
export function helpCentreUrl(raw: string, ctx: HelpUrlContext): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (url.startsWith("#")) return /^#[\w-]{1,100}$/.test(url) ? url : null;
  let u: URL;
  try {
    u = new URL(url, PORTAL_BASE);
  } catch {
    return null;
  }
  if (u.protocol === "mailto:" || u.protocol === "tel:") return url;
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.host.toLowerCase();
  const own = host === "portal.invalid" || ctx.ownHosts.has(host) || ctx.ownHosts.has(u.hostname.toLowerCase());
  // Another site's address: left exactly as written (its /doc/N or
  // /api/attachments/N is not this workspace's).
  if (!own) return url;
  const path = u.pathname;
  const doc = /^\/doc\/(\d{1,10})\/?$/.exec(path);
  if (doc) {
    const href = ctx.publicHrefs.get(Number(doc[1]));
    return href ? `${href}${u.hash}` : null;
  }
  const att = /^\/api\/attachments\/(\d{1,10})$/.exec(path);
  if (att) return `${HELP_FILE_PATH}/${att[1]}`;
  if (/^\/support\/api\/help\/files\/\d{1,10}$/.test(path)) return path;
  if (path === "/support" || (path.startsWith("/support/") && !path.startsWith("/support/api/"))) return `${path}${u.search}${u.hash}`;
  return null;
}

/** This workspace's host names: its custom domain, and the host(s) the request came in on (comma-separated is fine). */
export async function helpCentreOwnHosts(requestHost: string | null | undefined): Promise<Set<string>> {
  const hosts = new Set<string>();
  const add = (h: string | null | undefined) => {
    const v = (h ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (v) {
      hosts.add(v);
      hosts.add(v.replace(/:\d+$/, ""));
    }
  };
  for (const h of (requestHost ?? "").split(",")) add(h);
  try {
    add((await getAppSettings()).custom_domain);
  } catch {
    /* no settings: the request's host only */
  }
  for (const env of [process.env.COMPASSDOCS_BASE_URL, process.env.NEXT_PUBLIC_BASE_URL]) add(env);
  return hosts;
}

// --- What the pages read -------------------------------------------------------------

/** Categories in the admin's order; ones not in it yet follow by name. */
export function orderCategories<T extends { key: string; name: string }>(cats: T[], order: readonly string[]): T[] {
  const pos = new Map(order.map((k, i) => [k, i]));
  return [...cats].sort((a, b) => {
    const pa = pos.get(a.key);
    const pb = pos.get(b.key);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key);
  });
}

/** The help centre home's categories with their true article counts, in the admin's order. */
export async function helpCentreCategories(given?: HelpCentreContext): Promise<HelpCategory[]> {
  const { hc, portal } = await resolve(given);
  return orderCategories(await publicHelpCounts({}, { hc, portal }), hc.order);
}

/** One category: its true count and its first HC_LIMITS.category articles; null when it shows nothing. */
export async function helpCentreCategory(
  key: string,
  given?: HelpCentreContext
): Promise<{ key: string; name: string; total: number; articles: HelpArticle[] } | null> {
  if (!isCategoryKey(key)) return null;
  const { hc, portal } = await resolve(given);
  const [count] = await publicHelpCounts({ category: key }, { hc, portal });
  if (!count) return null;
  const articles = await publicHelpArticles({ category: key, limit: HC_LIMITS.category }, { hc, portal });
  if (!articles.length) return null;
  return { key, name: count.name, total: count.count, articles };
}

/**
 * One article with its body, its files, and where the documents it links
 * to are public (`links`, for helpCentreUrl); null when it is not public.
 */
export async function helpCentreArticle(
  id: number,
  given?: HelpCentreContext
): Promise<(HelpArticle & { body: string; files: { id: number; filename: string; href: string }[]; links: [number, string][] }) | null> {
  const { hc, portal } = await resolve(given);
  const [a] = await publicHelpArticles({ ids: [id], body: true, limit: 1 }, { hc, portal });
  if (!a) return null;
  // Links to other documents survive only to articles this same rule makes public.
  const linked = linkedDocIds(a.body ?? "").slice(0, 500);
  const reachable = linked.length ? await publicHelpArticles({ ids: linked, limit: linked.length }, { hc, portal }) : [];
  const files = await hq<{ id: number; filename: string }>("SELECT id, filename FROM attachments WHERE document_id = $1 ORDER BY created_at DESC, id DESC", [a.id]);
  return {
    ...a,
    body: a.body ?? "",
    files: files.map((f) => ({ id: f.id, filename: f.filename, href: `${HELP_FILE_PATH}/${f.id}` })),
    links: reachable.map((r) => [r.id, r.href]),
  };
}

/** A file an article carries, when that article is public; null otherwise. */
export async function helpCentreFile(id: number, given?: HelpCentreContext): Promise<{ id: number; filename: string; stored_name: string; mime_type: string; size: number } | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const att = await hqOne<{ id: number; document_id: number; filename: string; stored_name: string; mime_type: string; size: number }>(
    "SELECT id, document_id, filename, stored_name, mime_type, size FROM attachments WHERE id = $1",
    [id]
  );
  if (!att) return null;
  const [doc] = await publicHelpArticles({ ids: [att.document_id], limit: 1 }, given);
  if (!doc) return null;
  const { document_id: _d, ...file } = att;
  return file;
}

export function toSuggestion(a: HelpArticle): HelpSuggestion {
  return { id: a.id, title: a.title, href: a.href, category: a.category.name, summary: a.summary.slice(0, 240) };
}

// --- Limits ----------------------------------------------------------------------------

/**
 * The address a search is counted against: the network address, or for
 * IPv6 its /64 (one household or office gets one /64, so rotating within
 * it buys nothing).
 */
export function searchClientKey(ip: string): string {
  const v = (ip || "unknown").trim().toLowerCase();
  if (!v.includes(":")) return v;
  const parts = v.split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const full = parts.length > 1 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  return `${full.slice(0, 4).map((h) => h.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * Searching (as you type, the results page and the request form's
 * suggestions): 40 a minute per network address (an IPv6 /64). There is
 * deliberately no workspace-wide bucket: a shared one let a handful of
 * addresses switch search off for every customer. Each search is one
 * indexed query over the chosen spaces, so the per-address limit is the
 * cost bound. In-memory, like the portal's other limits.
 */
export function helpSearchLimited(ip: string): boolean {
  return hdRateLimited(`hc-search:${searchClientKey(ip)}`, 40, 60_000);
}

/** Journey steps: 60 a minute from one network address. */
export function helpJourneyLimited(ip: string): boolean {
  return hdRateLimited(`hc-journey:${searchClientKey(ip)}`, 60, 60_000);
}

// --- Search, with the stats -------------------------------------------------------------

export type HelpSearchSource = "home" | "form";

/**
 * Search the help centre. Only the help centre's own search box counts
 * in the stats, and only when the caller says the page itself asked
 * (`record`): the request form's subject ("form") is never stored, since
 * it is the start of someone's request, not a search.
 */
export async function searchHelpCentre(
  raw: unknown,
  opts: { journey?: unknown; source?: HelpSearchSource; limit?: number; record?: boolean } = {},
  given?: HelpCentreContext
): Promise<HelpSuggestion[]> {
  const q = cleanHelpQuery(raw);
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(1, opts.limit ?? HC_LIMITS.suggest), HC_LIMITS.results);
  const hits = await publicHelpArticles({ q, limit }, given);
  // Fewer than asked with every word: fill up with articles holding some of
  // them ("export csv" also suggests "Why a large export times out"), after.
  if (hits.length < limit && queryWords(q).length > 1) {
    const seen = new Set(hits.map((h) => h.id));
    for (const h of await publicHelpArticles({ q, any: true, limit }, given)) {
      if (hits.length >= limit) break;
      if (!seen.has(h.id)) hits.push(h);
    }
  }
  if (opts.record === true && opts.source !== "form") {
    await recordSearch(cleanJourneyId(opts.journey), q, hits.length, "home").catch(() => {});
  }
  return hits.map(toSuggestion);
}

let lastPrune = 0;

/** Keep 90 days: the stats read 30. At most once an hour, as rows are written. */
async function pruneOld(): Promise<void> {
  if (Date.now() - lastPrune < 3_600_000) return;
  lastPrune = Date.now();
  await hq("DELETE FROM hd_hc_searches WHERE at < now() - interval '90 days'");
  await hq("DELETE FROM hd_hc_journeys WHERE started_at < now() - interval '90 days'");
}

/**
 * Count a search. Typing extends the journey's last search for 20 seconds
 * (the new query starts with the old or the reverse), so a word typed key
 * by key is one search.
 */
export async function recordSearch(journey: string, q: string, results: number, source: HelpSearchSource): Promise<void> {
  const stored = redactQuery(q);
  if (stored.length < 2) return;
  if (journey) {
    await hq(
      `INSERT INTO hd_hc_journeys (id, searched) VALUES ($1, true)
       ON CONFLICT (id) DO UPDATE SET searched = true, last_at = now()`,
      [journey]
    );
    const prev = await hqOne<{ id: number; q: string }>(
      `SELECT id, q FROM hd_hc_searches WHERE journey = $1 AND at > now() - interval '20 seconds' ORDER BY at DESC, id DESC LIMIT 1`,
      [journey]
    );
    if (prev && (stored.startsWith(prev.q) || prev.q.startsWith(stored))) {
      await hq("UPDATE hd_hc_searches SET q = $2, results = $3, at = now() WHERE id = $1", [prev.id, stored, results]);
      return;
    }
  }
  await hq("INSERT INTO hd_hc_searches (journey, q, results, source) VALUES ($1, $2, $3, $4)", [journey, stored, results, source]);
  await pruneOld().catch(() => {});
}

export type HelpJourneyEvent = "open" | "submit";

/**
 * A journey's step: "open" (an article opened from a search or a
 * suggestion; from the browser) or "submit" (a request raised afterwards;
 * from the server, when the portal's request route creates the request).
 * Best effort.
 */
export async function recordJourney(rawId: unknown, event: HelpJourneyEvent): Promise<boolean> {
  const id = cleanJourneyId(rawId);
  if (!id) return false;
  if (event === "open") {
    await hq(
      `INSERT INTO hd_hc_journeys (id, opened) VALUES ($1, 1)
       ON CONFLICT (id) DO UPDATE SET opened = least(hd_hc_journeys.opened + 1, 1000), last_at = now()`,
      [id]
    );
    await pruneOld().catch(() => {});
    return true;
  }
  const rows = await hq("UPDATE hd_hc_journeys SET submitted = true, last_at = now() WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}

/**
 * A request was raised in the portal: the journeys it ends. `formJourney`
 * is the tab's own (the form sends it); the sign-in link carries the tab's
 * journey through the email to the browser that opens it, which keeps it
 * (portal session route) and sends it the same way. Never throws.
 */
export async function journeyRaisedRequest(formJourney: unknown): Promise<void> {
  await recordJourney(formJourney, "submit").catch(() => false);
}

/** The settings page's "Last 30 days". */
export async function helpCentreStats(): Promise<HelpCentreStats> {
  const days = `${HC_STATS_DAYS} days`;
  const [count, top, j] = await Promise.all([
    hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_hc_searches WHERE at > now() - $1::interval", [days]),
    hqOne<{ q: string }>(
      `SELECT q FROM hd_hc_searches WHERE at > now() - $1::interval
        GROUP BY q ORDER BY count(*) DESC, max(at) DESC LIMIT 1`,
      [days]
    ),
    hqOne<{ total: number; answered: number }>(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE opened > 0 AND NOT submitted))::int AS answered
         FROM hd_hc_journeys
        WHERE started_at > now() - $1::interval AND last_at < now() - $2::interval AND (searched OR opened > 0)`,
      [days, `${HC_ANSWERED_AFTER_MS / 1000} seconds`]
    ),
  ]);
  const total = j?.total ?? 0;
  return {
    searches: count?.n ?? 0,
    journeys: total,
    answered_pct: total > 0 ? Math.round(((j?.answered ?? 0) / total) * 100) : null,
    top_search: top?.q ?? null,
  };
}

// --- The settings page ---------------------------------------------------------------

export interface HelpCentreSpaceOption {
  id: number;
  name: string;
  /** A private space: never public, listed only so a stored choice can be seen and removed. */
  private: boolean;
}

/**
 * The spaces the settings page offers and names: every space that is not
 * private, and of the private ones only those already chosen (stored) or
 * that this person can open. Never the name of a private space they could
 * not otherwise see (settings.manage is a desk capability, not a space
 * grant).
 */
export async function helpCentreSpaceOptions(user: { id: number; role: Role }, chosen: readonly number[]): Promise<HelpCentreSpaceOption[]> {
  const [rows, scope] = await Promise.all([
    hq<{ id: number; name: string; visibility: string }>("SELECT id, name, visibility FROM spaces ORDER BY lower(name), id"),
    spaceScopeFor(user),
  ]);
  return rows
    .filter((r) => r.visibility !== "private" || chosen.includes(r.id) || scopeAllows(scope, r.id))
    .map((r) => ({ id: r.id, name: r.name, private: r.visibility === "private" }));
}

export interface HelpCentreAdminCategory extends HelpCategory {
  hidden: boolean;
}

/**
 * The categories a selection would show, hidden ones included (marked), in
 * the admin's order: what the settings page lists to reorder and switch
 * off. Runs the same rule as the portal, as if the help centre and the
 * portal were on, so the page can be set up before either is switched on.
 */
export async function helpCentreAdminCategories(draft: HelpCentreSettings, portal?: PortalSettings): Promise<HelpCentreAdminCategory[]> {
  const p = portal ?? (await getPortalSettings());
  const counts = await publicHelpCounts({}, { hc: { ...draft, enabled: true, hidden: [] }, portal: { ...p, enabled: true } });
  const hidden = new Set(draft.hidden);
  return orderCategories(
    counts.map((c) => ({ ...c, hidden: hidden.has(c.key) })),
    draft.order
  );
}
