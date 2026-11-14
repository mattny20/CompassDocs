// Helpdesk 1.20.7: the Microsoft Graph client of the Microsoft 365 mailbox
// connection (lib/helpdesk/m365/mail). App-only: it signs in as the
// workspace's own app registration with the client-credentials grant and
// calls Graph v1.0. Nothing here is EWS or IMAP.
//
//   hosts       fixed: login.microsoftonline.com for the token,
//               graph.microsoft.com for everything else. A link Graph hands
//               back (@odata.nextLink, @odata.deltaLink) is followed only
//               when it is on the Graph host and under /v1.0/ (graphLink);
//               a stored link is checked again each time it is used.
//   transport   lib/safe-fetch's one-hop safeFetchOnce (the SSRF guard and
//               proxy routing the rest of the app uses); no redirect is
//               followed. 20 seconds for a call, body included (a large
//               download may ask for longer); answers are read up to a cap.
//   tokens      cached in memory per (tenant, client ID, secret) until five
//               minutes before they expire. A 401 drops the token and tries
//               once more; a 403 drops it for the next call (a token keeps
//               the permissions it was issued with).
//   errors      M365Error with one sentence an admin can act on, Graph's
//               own error code, and whether Microsoft answered at all. The
//               secret and tokens are never logged or echoed.
//
// TEST ONLY. COMPASSDOCS_M365_MAIL_TEST_BASE points both hosts at a fake
// Microsoft on this machine (<base>/login and <base>/graph), so the suites
// and the e2e rig never contact Microsoft. It works only when explicitly
// set, and only for a loopback address (http://127.0.0.1:PORT or
// http://localhost:PORT): it cannot send the client secret to any other
// host. Never set it on a real install. Server-only.

import "server-only";
import { createHash } from "node:crypto";

const GRAPH_HOST = "https://graph.microsoft.com";
const LOGIN_HOST = "https://login.microsoftonline.com";

/** The loopback fake Microsoft the test seam names, or null (every real install). */
export function m365TestBase(): string | null {
  const raw = process.env.COMPASSDOCS_M365_MAIL_TEST_BASE;
  if (!raw) return null;
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(raw) ? raw : null;
}

const graphRoot = () => `${m365TestBase() ? `${m365TestBase()}/graph` : GRAPH_HOST}/v1.0`;
const loginRoot = () => (m365TestBase() ? `${m365TestBase()}/login` : LOGIN_HOST);

export type M365Transport = (url: string, init: RequestInit) => Promise<Response>;
let testTransport: M365Transport | null = null;
/** Tests: answer every request in process (null restores the real transport). */
export function setM365TransportForTests(t: M365Transport | null): void {
  testTransport = t;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  if (testTransport) return testTransport(url, init);
  // The seam is loopback, which the SSRF guard refuses by design: it is fetched directly.
  if (m365TestBase()) return fetch(url, { ...init, redirect: "manual" });
  const { safeFetchOnce } = await import("../../safe-fetch");
  return safeFetchOnce(url, init);
}

export type M365ErrorKind = "http" | "auth" | "timeout" | "network" | "blocked" | "too_large" | "not_json";

export class M365Error extends Error {
  constructor(
    message: string,
    /** The HTTP status; 0 when nothing came back. */
    public status: number,
    public kind: M365ErrorKind,
    /** Graph's own error code ("ErrorAccessDenied", "ResourceNotFound", "syncStateNotFound"), '' when none. */
    public code = "",
    public retryAfterMs: number | null = null
  ) {
    super(message);
  }
  /** Microsoft answered with a refusal (as opposed to no answer at all). */
  get answered(): boolean {
    return this.status > 0;
  }
}

export interface M365Credentials {
  tenant: string;
  clientId: string;
  secret: string;
}

export interface M365TokenClaims {
  /** The tenant ID the token signs in to (lower-cased GUID). */
  tid: string;
  /** The app's service principal (enterprise application) object ID. */
  oid: string;
  /** Graph application permissions granted in Entra itself. */
  roles: string[];
}

interface Token {
  value: string;
  expires: number;
  claims: M365TokenClaims;
}
const tokens = new Map<string, Token>();
const keyOf = (c: M365Credentials) => createHash("sha256").update(`${c.tenant}\n${c.clientId}\n${c.secret}`).digest("hex");

/** Tests: forget cached tokens. */
export function clearM365TokensForTests(): void {
  tokens.clear();
}

const GUIDISH = /^[0-9a-f-]{8,64}$/;

/** What an Entra app-only access token says about itself ('' / [] for anything unreadable). Not verified: it is our own token, fresh from Microsoft over TLS. */
export function tokenClaims(token: string): M365TokenClaims {
  const out: M365TokenClaims = { tid: "", oid: "", roles: [] };
  const part = token.split(".")[1];
  if (!part) return out;
  try {
    const c = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
    const tid = typeof c.tid === "string" ? c.tid.trim().toLowerCase() : "";
    const oid = typeof c.oid === "string" ? c.oid.trim().toLowerCase() : "";
    if (GUIDISH.test(tid)) out.tid = tid;
    if (GUIDISH.test(oid)) out.oid = oid;
    if (Array.isArray(c.roles)) out.roles = c.roles.filter((r): r is string => typeof r === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(r)).slice(0, 100);
  } catch {
    /* not a JWT: nothing known */
  }
  return out;
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[secret]");
  return out;
}

const TIMEOUT_MS = 20_000;
const JSON_CAP = 16 * 1024 * 1024;

async function readCapped(res: Response, max: number): Promise<Buffer | undefined> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function retryAfter(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  return Number.isFinite(secs) ? Math.max(0, Math.min(secs, 3600) * 1000) : null;
}

const NO_ANSWER = "Couldn't reach Microsoft 365, or it didn't answer in time. Check that this server can reach login.microsoftonline.com and graph.microsoft.com.";

async function exchange(url: string, init: RequestInit, max: number, timeoutMs = TIMEOUT_MS): Promise<{ res: Response; body: Buffer }> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      res = await send(url, { ...init, signal: ctrl.signal, redirect: "manual" });
    } catch (e) {
      const blocked = e instanceof Error && /^Blocked (host|address)/.test(e.message);
      throw new M365Error(NO_ANSWER, 0, timedOut ? "timeout" : blocked ? "blocked" : "network");
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new M365Error("Microsoft 365 answered with a redirect, which is not followed.", res.status, "blocked");
    }
    let body: Buffer | undefined;
    try {
      body = await readCapped(res, max);
    } catch {
      throw new M365Error(NO_ANSWER, 0, timedOut ? "timeout" : "network");
    }
    if (body === undefined) throw new M365Error("Microsoft 365 sent more than this server reads in one answer.", res.status, "too_large");
    return { res, body };
  } finally {
    clearTimeout(timer);
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const parse = (b: Buffer): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(b.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Sign in as the app. `fresh` skips the cache (the access check wants the permissions as they are now). */
export async function m365Token(c: M365Credentials, fresh = false): Promise<Token> {
  const key = keyOf(c);
  const cached = tokens.get(key);
  if (!fresh && cached && cached.expires > Date.now()) return cached;
  const { res, body } = await exchange(
    `${loginRoot()}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.secret, scope: "https://graph.microsoft.com/.default" }).toString(),
    },
    256 * 1024
  );
  const json = parse(body);
  if (!res.ok) {
    const code = str(json?.error);
    // AADSTS… codes say what is wrong without echoing anything secret; the description can, so only its code is kept.
    const aad = str(json?.error_description).match(/AADSTS\d+/)?.[0] ?? "";
    const why =
      aad === "AADSTS7000215" || aad === "AADSTS7000222"
        ? "the client secret is wrong or has expired"
        : aad === "AADSTS700016"
          ? "no app registration with that client ID exists in the tenant"
          : aad === "AADSTS90002" || code === "invalid_request"
            ? "the tenant was not found"
            : "check the tenant, the client ID and the secret";
    if (res.status === 429 || res.status >= 500) throw new M365Error("Microsoft 365 could not sign the app in just now. Try again shortly.", res.status, "http", aad || code, retryAfter(res));
    throw new M365Error(`Microsoft 365 refused the app's sign-in${aad ? ` (${aad})` : ""}: ${why}.`, res.status, "auth", aad || code);
  }
  const value = str(json?.access_token);
  if (!value) throw new M365Error("Microsoft 365 didn't hand out a token. Check the app registration.", 200, "not_json");
  const secs = Number(json?.expires_in) || 3600;
  const token: Token = { value, expires: Date.now() + Math.max(60, secs - 300) * 1000, claims: tokenClaims(value) };
  tokens.set(key, token);
  if (tokens.size > 20) tokens.delete(tokens.keys().next().value as string);
  return token;
}

/**
 * A link Graph handed back, checked before it is followed or stored: the
 * Graph host and nothing else, under /v1.0/. Throws for anything else, so a
 * tampered answer (or a tampered stored link) can never send the token to
 * another host.
 */
export function graphLink(link: string): string {
  const root = graphRoot();
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw new M365Error("Microsoft Graph sent a link that is not a web address. It was not followed.", 0, "blocked");
  }
  const want = new URL(root);
  if (u.origin !== want.origin || !u.pathname.startsWith(`${want.pathname}/`) || u.username || u.password) {
    throw new M365Error("Microsoft Graph sent a link to another address. It was not followed.", 0, "blocked");
  }
  return u.toString();
}

export interface GraphCall {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** A path under /v1.0 ("/users/…"), or `link`: a full nextLink / deltaLink (checked by graphLink). */
  path?: string;
  link?: string;
  body?: unknown;
  /** A raw text body (the MIME form of sendMail) with its content type. */
  text?: { value: string; type: string };
  prefer?: string[];
  /** "bytes": the answer as it is (an attachment's content). */
  as?: "json" | "bytes";
  maxBytes?: number;
  /** For a large download: the whole exchange may take this long instead of 20 seconds (at most 3 minutes). */
  timeoutMs?: number;
  /** What the call was for, for the sentence ("read the mailbox"). */
  what?: string;
}

/** One sentence for a refusal, from the status and Graph's code. */
function sentence(status: number, code: string, what: string): string {
  const lc = code.toLowerCase();
  if (status === 401) return "Microsoft 365 did not accept the app's sign-in. Check the client secret.";
  if (lc === "mailboxnotenabledforrestapi" || lc === "mailboxnotsupportedforrestapi") {
    return "That address has no Exchange Online mailbox the desk can read (it may be on-premises, unlicensed or switched off).";
  }
  if (status === 404 || lc === "errorinvaliduser" || lc === "resourcenotfound" || lc === "request_resourcenotfound") {
    return "Microsoft 365 found no mailbox with that address.";
  }
  if (status === 403) return `Microsoft 365 did not let the app ${what}. The app is not allowed to reach this mailbox (yet).`;
  if (status === 429) return "Microsoft 365 is limiting requests right now. The desk tries again shortly.";
  if (status === 413) return "Microsoft 365 said the request was too large.";
  if (status >= 500) return `Microsoft 365 had a problem (error ${status}). The desk tries again shortly.`;
  return `Microsoft 365 refused to ${what} (error ${status}${code ? `, ${code.slice(0, 60)}` : ""}).`;
}

/**
 * One Graph call as the app. Resolves with the parsed JSON (or the bytes)
 * for any 2xx; throws M365Error otherwise.
 */
export async function graph<T = Record<string, unknown>>(c: M365Credentials, call: GraphCall): Promise<T> {
  const url = call.link ? graphLink(call.link) : `${graphRoot()}${call.path ?? ""}`;
  const what = call.what ?? "do that";
  for (let attempt = 0; ; attempt++) {
    const token = await m365Token(c);
    const headers: Record<string, string> = { authorization: `Bearer ${token.value}`, accept: call.as === "bytes" ? "*/*" : "application/json" };
    if (call.prefer?.length) headers.prefer = call.prefer.join(", ");
    let body: string | undefined;
    if (call.text) {
      headers["content-type"] = call.text.type;
      body = call.text.value;
    } else if (call.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(call.body);
    }
    const { res, body: answer } = await exchange(url, { method: call.method ?? "GET", headers, body }, call.maxBytes ?? JSON_CAP, Math.min(180_000, Math.max(TIMEOUT_MS, call.timeoutMs ?? TIMEOUT_MS)));
    if (res.ok) {
      if (call.as === "bytes") return answer as unknown as T;
      if (!answer.length) return {} as T;
      const json = parse(answer);
      if (!json) throw new M365Error("Microsoft 365 sent an answer this server could not read.", res.status, "not_json");
      return json as T;
    }
    const err = parse(answer)?.error;
    const code = err && typeof err === "object" ? str((err as Record<string, unknown>).code).slice(0, 80) : "";
    if (res.status === 401 && attempt === 0) {
      tokens.delete(keyOf(c));
      continue;
    }
    if (res.status === 401 || res.status === 403) tokens.delete(keyOf(c));
    throw new M365Error(scrub(sentence(res.status, code, what), [c.secret, token.value]), res.status, "http", code, retryAfter(res));
  }
}

/** The mailbox part of a Graph path: the address, percent-encoded (it came through cleanMailboxAddress). */
export const userPath = (address: string) => `/users/${encodeURIComponent(address)}`;
