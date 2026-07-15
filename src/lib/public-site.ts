// The anonymous public site: instance-level configuration and a small
// rate limiter for its unauthenticated search endpoint. Server-only.
//
// Two settings, both defaulting OFF so external exposure is always an
// explicit admin choice:
//   public_site_enabled  — master switch; off = every /public route 404s
//   public_site_indexing — allow search engines (otherwise noindex)

import "server-only";
import { getSetting, setSetting } from "./db";

export interface PublicSiteConfig {
  enabled: boolean;
  indexing: boolean;
}

export async function getPublicSiteConfig(): Promise<PublicSiteConfig> {
  const [enabled, indexing] = await Promise.all([
    getSetting("public_site_enabled"),
    getSetting("public_site_indexing"),
  ]);
  return { enabled: enabled === "1", indexing: indexing === "1" };
}

export async function setPublicSiteConfig(patch: Partial<PublicSiteConfig>): Promise<void> {
  if (patch.enabled !== undefined) await setSetting("public_site_enabled", patch.enabled ? "1" : "0");
  if (patch.indexing !== undefined)
    await setSetting("public_site_indexing", patch.indexing ? "1" : "0");
}

// --- Search rate limiting -----------------------------------------------------
// Public search is the one anonymous endpoint that does real work per request,
// so it gets a sliding-window limiter: per-IP plus a global backstop (which
// also covers crawlers that rotate addresses). In-memory is fine — CompassDocs
// runs as a single instance, and worst case a restart resets the window.

const WINDOW_MS = 60_000;
const PER_IP = 30; // searches per minute per client
const GLOBAL = 300; // searches per minute across everyone

const ipHits = new Map<string, number[]>();
const globalHits: number[] = [];

export function searchRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  while (globalHits.length && globalHits[0] < cutoff) globalHits.shift();
  if (globalHits.length >= GLOBAL) return true;

  const hits = (ipHits.get(ip) ?? []).filter((t) => t >= cutoff);
  if (hits.length >= PER_IP) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  globalHits.push(now);

  // Opportunistic cleanup so the map can't grow unbounded.
  if (ipHits.size > 10_000) {
    for (const [k, v] of ipHits) if (!v.some((t) => t >= cutoff)) ipHits.delete(k);
  }
  return false;
}
