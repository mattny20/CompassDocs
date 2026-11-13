// Lightweight in-memory rate limiting for expensive endpoints (AI calls, the
// PlantUML render proxy). Per-process — like the login throttle, this assumes
// the documented single-container deployment; multi-instance setups get
// per-instance limits, which is still a meaningful backstop against a single
// client hammering one node. Not a security boundary on its own — a cost/DoS
// guard layered on top of auth.

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();
const MAX_KEYS = 20_000; // memory cap; evict oldest-reset entries when exceeded

function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  let w = buckets.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + windowMs };
    buckets.set(key, w);
  }
  w.count++;
  if (buckets.size > MAX_KEYS) {
    // Cheap eviction: drop everything already expired.
    for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  }
  return w.count > max;
}

/** Like limited(), but answers how many seconds remain in the window (0 when allowed). */
function limitedFor(key: string, max: number, windowMs: number): number {
  if (!limited(key, max, windowMs)) return 0;
  const w = buckets.get(key);
  return w ? Math.max(1, Math.ceil((w.resetAt - Date.now()) / 1000)) : 1;
}

/**
 * The sign-in page's account lookup (1.16.0, /api/auth/lookup): 20 a minute
 * and 100 an hour per IP, counted only for lookups that read an account.
 * Answers the seconds to wait, or 0. Separate from the login throttle: a
 * lookup is not a failed sign-in.
 */
export function signInLookupRetryAfter(ip: string): number {
  return Math.max(limitedFor(`lookup-m:${ip}`, 20, 60_000), limitedFor(`lookup-h:${ip}`, 100, 3_600_000));
}

/** AI question/generation calls: 20 per minute per key (e.g. per user). */
export function aiRateLimited(key: string): boolean {
  return limited(`ai:${key}`, 20, 60_000);
}

/**
 * Document search: 60 per minute per key (e.g. per user). /api/search can cost
 * an uncached embeddings provider call per request, so it needs a ceiling — a
 * debounced typeahead cannot come close to this in normal use.
 */
export function searchRateLimited(key: string): boolean {
  return limited(`search:${key}`, 60, 60_000);
}

/** Directory typeahead: 60 per minute per key (e.g. per user). */
export function directoryRateLimited(key: string): boolean {
  return limited(`dir:${key}`, 60, 60_000);
}

/** PlantUML render proxy: 30 per minute per key (e.g. per client IP). */
export function plantumlRateLimited(key: string): boolean {
  return limited(`puml:${key}`, 30, 60_000);
}

/**
 * Image drop links (/upload/<token>): 20 attempts per minute per client IP.
 *
 * The token is the only credential these have, so the ceiling is what stops
 * someone guessing at 24 random bytes — and 20/min is far above what a person
 * dropping one screenshot ever needs.
 */
export function uploadTicketRateLimited(key: string): boolean {
  return limited(`ticket:${key}`, 20, 60_000);
}

/**
 * Directory exports: 30 per minute per user. Rendering a PDF is the one
 * request in the app that costs real CPU for a real fraction of a second;
 * an admin trying presets, a zip per office and a who's who in one sitting
 * fits, a script pulling the directory in a loop does not (1.3.4 — it was
 * 12, which the Export page alone could reach).
 */
export function exportRateLimited(key: string): boolean {
  return limited(`export:${key}`, 30, 60_000);
}

/** Public REST API (/api/v1): 120 requests per minute per token user. */
export function apiV1RateLimited(key: string): boolean {
  return limited(`v1:${key}`, 120, 60_000);
}

/**
 * Desk background artwork uploads (1.19.4, lib/helpdesk/appearance): 20 an
 * hour per person. Each one decodes a picture of up to 100 megapixels and
 * writes four WebP copies; trying a few pictures fits, a loop does not.
 */
export function deskArtUploadRateLimited(key: string): boolean {
  return limited(`desk-art:${key}`, 20, 60 * 60_000);
}

/**
 * Starting the Duo step (1.20.5, /api/auth/duo/start and the admin test):
 * each start can send a push to someone's phone, so one session cannot ask
 * for more than 10 in five minutes. Keyed on the session AND the account,
 * not the account alone: someone else who knows the password must not be
 * able to use up the real person's (or the admin test's) allowance from
 * another session.
 */
export function duoStartRateLimited(userId: number, sid: string): boolean {
  return limited(`duo-start:${userId}:${sid}`, 10, 5 * 60_000);
}

/**
 * Duo's callback (1.20.5, /api/auth/duo/callback) writes an audit row for
 * every refusal, so one session gets 20 callbacks in five minutes. Past
 * that it is turned away before anything is read or written.
 */
export function duoCallbackRateLimited(sid: string): boolean {
  return limited(`duo-callback:${sid}`, 20, 5 * 60_000);
}
