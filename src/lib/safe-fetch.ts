// SSRF-guarded fetch for server-side requests to URLs an admin typed in
// (link icons, workspace logos, webhooks). The default policy blocks the
// dangerous-by-construction targets — cloud metadata endpoints, link-local
// and loopback addresses — while still allowing RFC1918 intranet hosts,
// because pointing quick links or webhooks at internal tools is a legitimate,
// common setup. Set COMPASSDOCS_FETCH_BLOCK_PRIVATE=1 to also refuse private
// ranges on hardened deployments. Redirects are followed manually so every
// hop is re-validated. Server-only.

import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 4;

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
  return process.env.COMPASSDOCS_FETCH_BLOCK_PRIVATE === "1";
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
 * Pass init as usual; `redirect` is managed internally.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  let url = await assertPublicTarget(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, { ...init, redirect: "manual" });
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
