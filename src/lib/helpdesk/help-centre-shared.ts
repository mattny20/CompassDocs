// Helpdesk 1.19.4 (C3): the customer portal help centre's shared rules.
// Pure: the admin page, the portal pages and the server
// (lib/helpdesk/help-centre) read one set of definitions. Safe in client
// components.
//
// What is public is NOT decided here: lib/helpdesk/help-centre
// publicHelpArticles is the one function that answers it. This module only
// shapes the settings the admin chooses and the words and limits the pages
// share.

/** The tag that makes a document public under "Documents tagged public". */
export const HC_PUBLIC_TAG = "public";

export const HC_LIMITS = {
  /** Chosen spaces. */
  spaces: 100,
  /** Category keys kept in order or hidden. */
  categories: 500,
  /** A search as typed. */
  q: 120,
  /** A query as stored for the stats. */
  storedQ: 100,
  /** Suggestions as you type, and under the request form's subject. */
  suggest: 6,
  /** Articles a category page lists. */
  category: 300,
  /** Search results on the results page. */
  results: 30,
} as const;

/** How long a journey may sit before "opened an article, raised nothing" counts as answered. */
export const HC_ANSWERED_AFTER_MS = 30 * 60_000;
/** The stats window. */
export const HC_STATS_DAYS = 30;

export interface HelpCentreSettings {
  /** "Show a help centre". */
  enabled: boolean;
  /** "Documents in chosen spaces". */
  from_spaces: boolean;
  /** The chosen spaces (space ids). Private spaces never count, whatever is stored. */
  spaces: number[];
  /** "Documents tagged public", from any space that is not private. */
  tagged: boolean;
  /** Category keys in the order the help centre shows them (unknown ones follow, by name). */
  order: string[];
  /** Category keys switched off: their articles are not public. */
  hidden: string[];
  /** "Let search engines index the help centre" (default off: noindex). */
  indexing: boolean;
}

export const DEFAULT_HELP_CENTRE_SETTINGS: HelpCentreSettings = {
  enabled: false,
  from_spaces: true,
  spaces: [],
  tagged: false,
  order: [],
  hidden: [],
  indexing: false,
};

/**
 * A category key: "c<id>" is a folder (space_categories row), "s<id>" is
 * the documents of space <id> that sit in no folder (shown under the
 * space's name).
 */
export const CATEGORY_KEY_RE = /^[cs][1-9]\d{0,9}$/;

export function isCategoryKey(v: unknown): v is string {
  return typeof v === "string" && CATEGORY_KEY_RE.test(v);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function idList(raw: unknown, max: number): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const x of raw) {
    const n = typeof x === "number" ? x : typeof x === "string" && /^\d+$/.test(x) ? Number(x) : NaN;
    if (Number.isInteger(n) && n > 0 && n <= 2_147_483_647 && !out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

function keyList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (isCategoryKey(x) && !out.includes(x)) out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

/** Settings as stored or as sent, cleaned to the shape. Never throws. */
export function cleanHelpCentreSettings(raw: unknown): HelpCentreSettings {
  const v = isObj(raw) ? raw : {};
  return {
    enabled: v.enabled === true,
    from_spaces: v.from_spaces === undefined ? DEFAULT_HELP_CENTRE_SETTINGS.from_spaces : v.from_spaces === true,
    spaces: idList(v.spaces, HC_LIMITS.spaces),
    tagged: v.tagged === true,
    order: keyList(v.order, HC_LIMITS.categories),
    hidden: keyList(v.hidden, HC_LIMITS.categories),
    indexing: v.indexing === true,
  };
}

/** A search as typed: search operators a customer did not mean dropped, quotes gone, spaces collapsed, clamped. */
export function cleanHelpQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(space|type|tag|author|status):\S*/gi, " ")
    .replace(/["“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, HC_LIMITS.q);
}

/** The words of a query, for a prefix search (letters and digits only, at most eight). */
export function queryWords(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length <= 40).slice(0, 8);
}

/**
 * A query as the stats keep it: lower-case, with anything that looks like
 * an email address or a long number (an order, a phone) replaced, so a
 * customer who types their own details leaves none behind.
 */
export function redactQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{5,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, HC_LIMITS.storedQ);
}

/** A browser tab's journey id: what the page makes with crypto.randomUUID (or similar), nothing else. */
export function cleanJourneyId(raw: unknown): string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(raw) ? raw : "";
}

/** "exporting-reports-to-csv" from a stored slug or a title, for the address. */
export function articleSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function articleHref(id: number, slugOrTitle: string): string {
  const s = articleSlug(slugOrTitle);
  return `/support/articles/${id}${s ? `-${s}` : ""}`;
}

/** The article id at the front of "/support/articles/<id>-<slug>"'s segment, or null. */
export function articleIdFrom(segment: string): number | null {
  const m = /^(\d{1,10})(?:-[a-z0-9-]*)?$/.exec(segment);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n <= 2_147_483_647 ? n : null;
}

export function categoryHref(key: string): string {
  return `/support/categories/${key}`;
}

/** "1 article", "8 articles". */
export function articleCount(n: number): string {
  return n === 1 ? "1 article" : `${n.toLocaleString("en")} articles`;
}

/** What a public suggestion carries: never an author, a space id, tags or text beyond the summary. */
export interface HelpSuggestion {
  id: number;
  title: string;
  href: string;
  category: string;
  summary: string;
}

export interface HelpCentreStats {
  searches: number;
  /** Journeys that searched or opened a suggestion, settled (older than 30 minutes). */
  journeys: number;
  /** Of those, the share that opened an article and raised no request; null with none. */
  answered_pct: number | null;
  /** The most frequent search; null with none. */
  top_search: string | null;
}
