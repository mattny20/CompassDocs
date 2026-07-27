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

/** AI question/generation calls: 20 per minute per key (e.g. per user). */
export function aiRateLimited(key: string): boolean {
  return limited(`ai:${key}`, 20, 60_000);
}

/** PlantUML render proxy: 30 per minute per key (e.g. per client IP). */
export function plantumlRateLimited(key: string): boolean {
  return limited(`puml:${key}`, 30, 60_000);
}
