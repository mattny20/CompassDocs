// Helpdesk 1.19.3: outbound HTTP for asset sources (Snipe-IT now; Intune
// next). One request at a time through lib/safe-fetch's one-hop
// safeFetchOnce (the SSRF guard and the HTTPS_PROXY routing the rest of the
// app uses), with what an admin-typed integration address needs on top:
//
//   https only    a non-https URL is refused before anything is sent
//   redirects     followed only to the same https host (GET only, at most
//                 three); anything else is an error naming the target
//   timeout       10 seconds for the whole exchange, body included
//   size cap      the answer is read up to 12 MB, then dropped
//   errors        AssetHttpError with a sentence an admin can act on, by
//                 status (401, 403, 404, 429 with Retry-After, 5xx) or by
//                 kind (timeout, not JSON, too large); every "no answer"
//                 cause (unknown name, refused, certificate, blocked) is one
//                 sentence, so the wording maps no internal network
//   the key       sent only in the Authorization header; never logged, and
//                 scrubbed from any message that could echo it
//
// Tests swap the transport (setAssetTransportForTests) for one that sends
// the same requests to an in-process server. Server-only.

import "server-only";

export type AssetTransport = (url: string, init: RequestInit) => Promise<Response>;

let testTransport: AssetTransport | null = null;

/** Tests: send every request through `t` instead of safeFetchOnce (null restores it). */
export function setAssetTransportForTests(t: AssetTransport | null): void {
  testTransport = t;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  if (testTransport) return testTransport(url, init);
  const { safeFetchOnce } = await import("../../safe-fetch");
  return safeFetchOnce(url, init);
}

export type AssetHttpErrorCode = "http" | "timeout" | "network" | "blocked" | "redirect" | "too_large" | "not_json";

export class AssetHttpError extends Error {
  constructor(
    message: string,
    /** The HTTP status, 0 when nothing came back. */
    public status: number,
    public code: AssetHttpErrorCode,
    /** A 429's Retry-After, in ms. */
    public retryAfterMs: number | null = null,
    /** The source's own sentence (JSON messages), already scrubbed. */
    public detail = ""
  ) {
    super(message);
  }
}

export const ASSET_HTTP_DEFAULTS = { timeoutMs: 10_000, maxBytes: 12 * 1024 * 1024, maxRedirects: 3 } as const;

export interface AssetRequest {
  url: string;
  method?: "GET" | "POST";
  token: string;
  body?: unknown;
  /** Who answers, for the messages ("Snipe-IT"). */
  label: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Replace every copy of the key (and of its first 12 characters) with "[key]". */
export function scrub(text: string, token: string): string {
  let out = text;
  if (token) {
    out = out.split(token).join("[key]");
    if (token.length > 16) out = out.split(token.slice(0, 12)).join("[key]");
  }
  return out;
}

function retryAfter(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** The source's own error sentence out of a JSON body ({ messages: "…" } or { messages: { field: ["…"] } }). */
export function sourceMessage(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const o = json as Record<string, unknown>;
  const m = o.messages ?? o.message ?? o.error;
  if (typeof m === "string") return m.slice(0, 300);
  if (m && typeof m === "object") {
    const parts: string[] = [];
    for (const v of Object.values(m as Record<string, unknown>)) {
      if (typeof v === "string") parts.push(v);
      else if (Array.isArray(v)) parts.push(...v.filter((x): x is string => typeof x === "string"));
    }
    return parts.join(" ").slice(0, 300);
  }
  return "";
}

function statusError(status: number, label: string, detail: string, retry: number | null): AssetHttpError {
  const tail = detail ? ` ${label} said: ${detail}` : "";
  if (status === 401) return new AssetHttpError(`${label} refused the API key (401). Check that it hasn't expired or been revoked.`, status, "http", null, detail);
  if (status === 403) return new AssetHttpError(`The API key isn't allowed to do that in ${label} (403). Check the key's permissions.${tail}`, status, "http", null, detail);
  if (status === 404) return new AssetHttpError(`${label} answered "not found" (404). Check the address points at ${label}.`, status, "http", null, detail);
  if (status === 429) return new AssetHttpError(`${label} is limiting requests right now (429). Try again in a minute.`, status, "http", retry, detail);
  if (status >= 500) return new AssetHttpError(`${label} had a problem (error ${status}). Try again shortly.`, status, "http", null, detail);
  return new AssetHttpError(`${label} refused the request (error ${status}).${tail}`, status, "http", null, detail);
}

/**
 * Why a request never got an answer. One sentence for every cause (an
 * unknown name, a refused or timed-out connection, a certificate that
 * didn't match, an address the server won't call): telling them apart
 * would let whoever types the address map which internal hosts and ports
 * answer. The code keeps the cause for the server's own checks.
 */
function causeError(e: unknown, label: string, host: string, timedOut = false): AssetHttpError {
  const msg = e instanceof Error ? e.message : "";
  const code: AssetHttpErrorCode = timedOut ? "timeout" : /^Blocked (host|address)/.test(msg) ? "blocked" : "network";
  return new AssetHttpError(
    `Couldn't reach ${label} at ${host}, or it didn't answer in time. Check the address, and that this server can reach it (an address on a private network also needs COMPASSDOCS_FETCH_ALLOW_PRIVATE=1 on the server).`,
    0,
    code
  );
}

/** Read the body up to `max` bytes; undefined when it is larger. */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * One JSON request to a source. Resolves with the status and the parsed
 * body for any 2xx; throws AssetHttpError otherwise (a 404's caller may
 * catch it to mean "no such asset").
 */
export async function assetRequest(r: AssetRequest): Promise<{ status: number; json: unknown }> {
  const timeoutMs = r.timeoutMs ?? ASSET_HTTP_DEFAULTS.timeoutMs;
  const maxBytes = r.maxBytes ?? ASSET_HTTP_DEFAULTS.maxBytes;
  const method = r.method ?? "GET";
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    throw new AssetHttpError(`The ${r.label} address isn't a web address.`, 0, "network");
  }
  if (url.protocol !== "https:") throw new AssetHttpError(`Use an https:// address for ${r.label}.`, 0, "blocked");
  const host = url.host;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    let res: Response | null = null;
    for (let hop = 0; ; hop++) {
      try {
        res = await send(url.toString(), {
          method,
          headers: {
            authorization: `Bearer ${r.token}`,
            accept: "application/json",
            ...(r.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: r.body !== undefined ? JSON.stringify(r.body) : undefined,
          signal: ctrl.signal,
          redirect: "manual",
        });
      } catch (e) {
        // No answer yet: one sentence whatever the cause, a timeout included (causeError).
        throw causeError(e, r.label, host, timedOut);
      }
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new AssetHttpError(`${r.label} answered with a redirect but no address.`, res.status, "redirect");
      const next = new URL(loc, url);
      if (next.protocol !== "https:" || next.host !== host) {
        throw new AssetHttpError(`${r.label} redirected to ${next.protocol}//${next.host}. Use that address instead, if it's right.`, res.status, "redirect");
      }
      if (method !== "GET" || hop >= ASSET_HTTP_DEFAULTS.maxRedirects) throw new AssetHttpError(`${r.label} kept redirecting. Check the address.`, res.status, "redirect");
      url = next;
    }
    let text: string | undefined;
    try {
      text = await readCapped(res, maxBytes);
    } catch (e) {
      if (timedOut) throw new AssetHttpError(`${r.label} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`, 0, "timeout");
      throw causeError(e, r.label, host);
    }
    if (text === undefined) throw new AssetHttpError(`${r.label}'s answer was too large to read.`, res.status, "too_large");
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    if (res.status >= 400) throw statusError(res.status, r.label, scrub(sourceMessage(json), r.token), retryAfter(res));
    if (json === undefined) throw new AssetHttpError(`That address didn't answer like the ${r.label} API. Check it's the address you open ${r.label} at.`, res.status, "not_json");
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}
