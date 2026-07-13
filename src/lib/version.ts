// Version + update checking for the admin console. We compare the running
// version against the latest published GitHub release and surface whether an
// update is available, plus release notes and the upgrade command. We never
// perform the upgrade from inside the container (that needs host Docker access);
// this is guidance only.
//
// Server-only: reads package.json and makes an outbound request to the GitHub
// API. The result is cached in-process to stay well under the unauthenticated
// rate limit.

import pkg from "../../package.json";

const REPO = process.env.COMPASSDOCS_REPO || "mattny20/CompassDocs";
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface ReleaseInfo {
  tag: string;
  name: string;
  url: string;
  publishedAt: string | null;
  notes: string;
}

export interface UpdateStatus {
  /** The running application version (from package.json). */
  current: string;
  /** The pinned image tag (COMPASSDOCS_VERSION), if any. */
  imageTag: string | null;
  /** The latest published release, or null if none / unreachable. */
  latest: ReleaseInfo | null;
  /** True when `latest` is strictly newer than `current`. */
  updateAvailable: boolean;
  /** The upgrade command for a Docker deployment. */
  upgradeCommand: string;
  /** The repo's releases page, for the "view all" link. */
  releasesUrl: string;
  /** Set when the check couldn't be completed (offline, rate-limited, none). */
  note?: string;
  /** When this status was computed (ISO). */
  checkedAt: string;
}

/** Parse a semver-ish string ("v1.2.3", "1.2.3") into comparable parts. */
function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** >0 if a>b, <0 if a<b, 0 if equal/uncomparable. */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function currentVersion(): string {
  return (pkg as { version?: string }).version || "0.0.0";
}

let cache: { at: number; release: ReleaseInfo | null; note?: string } | null = null;

async function fetchLatestRelease(force = false): Promise<{ release: ReleaseInfo | null; note?: string }> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    return { release: cache.release, note: cache.note };
  }
  let result: { release: ReleaseInfo | null; note?: string };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "CompassDocs",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 404) {
      result = { release: null, note: "No published releases yet." };
    } else if (res.status === 403) {
      result = { release: null, note: "Update check is rate-limited; try again later." };
    } else if (!res.ok) {
      result = { release: null, note: `Couldn't reach GitHub (HTTP ${res.status}).` };
    } else {
      const data: any = await res.json();
      result = {
        release: {
          tag: String(data.tag_name || ""),
          name: String(data.name || data.tag_name || ""),
          url: String(data.html_url || `https://github.com/${REPO}/releases`),
          publishedAt: data.published_at || null,
          notes: String(data.body || "").slice(0, 4000),
        },
      };
    }
  } catch (e: any) {
    result = { release: null, note: `Update check failed: ${e?.message || "network error"}` };
  }
  cache = { at: Date.now(), release: result.release, note: result.note };
  return result;
}

export async function getUpdateStatus(force = false): Promise<UpdateStatus> {
  const current = currentVersion();
  const { release, note } = await fetchLatestRelease(force);
  const updateAvailable = !!release && compareVersions(release.tag, current) > 0;
  return {
    current,
    imageTag: process.env.COMPASSDOCS_VERSION || null,
    latest: release,
    updateAvailable,
    upgradeCommand: "docker compose pull && docker compose up -d",
    releasesUrl: `https://github.com/${REPO}/releases`,
    note,
    checkedAt: new Date().toISOString(),
  };
}
