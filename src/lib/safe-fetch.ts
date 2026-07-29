// SSRF-guarded fetch for server-side requests to URLs an admin typed in
// (link icons, workspace logos, webhooks) or that AI/embeddings endpoints use.
// Secure by default: it refuses cloud-metadata endpoints, link-local and
// loopback addresses, AND RFC1918/CGNAT/ULA private ranges. Deployments that
// intentionally point quick links or webhooks at internal tools can opt back
// in with COMPASSDOCS_FETCH_ALLOW_PRIVATE=1. Redirects are followed manually so
// every hop is re-validated.
//
// Locked-down networks: when HTTPS_PROXY/HTTP_PROXY is set, outbound requests
// go through that proxy (NO_PROXY exclusions honored). Proxied requests skip
// the local DNS/IP resolution check — the server often *can't* resolve
// external names on such networks, and the proxy is the egress policy —
// while hostname-level blocks (localhost, metadata endpoints, literal
// private IPs) still apply. Server-only.

import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

const MAX_REDIRECTS = 4;

// --- Outbound proxy (HTTPS_PROXY / HTTP_PROXY / NO_PROXY) ------------------------

function proxyEnv(): string {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ""
  ).trim();
}

let envAgent: EnvHttpProxyAgent | null | undefined;
function proxyAgent(): EnvHttpProxyAgent | null {
  if (envAgent === undefined) {
    envAgent = proxyEnv() ? new EnvHttpProxyAgent() : null;
  }
  return envAgent;
}

/** True when this host's request will be routed through the configured proxy
 * (mirrors EnvHttpProxyAgent's NO_PROXY semantics for the SSRF-check skip). */
function willProxy(host: string): boolean {
  if (!proxyEnv()) return false;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").trim();
  if (noProxy === "*") return false;
  const h = host.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase().replace(/^\./, "").replace(/:\d+$/, "");
    if (!entry) continue;
    if (h === entry || h.endsWith(`.${entry}`)) return false;
  }
  return true;
}

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data", // legacy AWS alias
]);

function ipBlocked(ip: string, blockPrivate: boolean): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 0) return true;
    if (blockPrivate) {
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    }
    return false;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true; // loopback / unspecified
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb"))
      return true; // link-local fe80::/10
    if (low.startsWith("::ffff:")) return ipBlocked(low.slice(7), blockPrivate); // v4-mapped
    if (blockPrivate && (low.startsWith("fc") || low.startsWith("fd"))) return true; // ULA
    return false;
  }
  return true; // not an IP at all — refuse
}

function blockPrivateRanges(): boolean {
  // Secure by default. Opt out on trusted networks that fetch internal hosts.
  if (process.env.COMPASSDOCS_FETCH_ALLOW_PRIVATE === "1") return false;
  if (process.env.COMPASSDOCS_FETCH_BLOCK_PRIVATE === "0") return false; // legacy opt-out
  return true;
}

/** Throws when the URL points somewhere server-side fetches must not go. */
export async function assertPublicTarget(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host) || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`Blocked host: ${host}`);
  }
  const blockPrivate = blockPrivateRanges();
  if (isIP(host)) {
    if (ipBlocked(host, blockPrivate)) throw new Error(`Blocked address: ${host}`);
    return url;
  }
  // A proxied request never touches an address this server resolves — the
  // proxy resolves and connects. Skip local resolution (which may not even
  // work on egress-locked networks); the hostname checks above still apply.
  if (willProxy(host)) return url;
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  for (const a of addrs) {
    if (ipBlocked(a.address, blockPrivate)) {
      throw new Error(`Blocked address for ${host}: ${a.address}`);
    }
  }
  return url;
}

/**
 * fetch() with SSRF validation on the initial URL and on every redirect hop.
 * Pass init as usual; `redirect` is managed internally. With HTTPS_PROXY set,
 * requests route through the proxy (undici's fetch + EnvHttpProxyAgent — the
 * dispatcher must come from the same undici build as the fetch that uses it).
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  let url = await assertPublicTarget(rawUrl);
  const agent = proxyAgent();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = agent
      ? ((await undiciFetch(url.toString(), {
          ...(init as any),
          redirect: "manual",
          dispatcher: agent,
        })) as unknown as Response)
      : await fetch(url, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      if (hop === MAX_REDIRECTS) throw new Error("Too many redirects");
      url = await assertPublicTarget(new URL(loc, url).toString());
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}
