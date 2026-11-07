// Helpdesk 1.19.4: outbound HTTP for the chat apps (Microsoft's sign-in and
// Bot Connector, Slack's Web API). One hop through lib/safe-fetch's
// safeFetchOnce (the SSRF guard, DNS pinning and HTTPS_PROXY routing the
// rest of the app uses), with:
//
//   https only    anything else is refused before a byte is sent
//   hosts         only the hosts the caller allows (allowHost); a redirect
//                 is never followed (none of these services redirect)
//   timeout       8 seconds for the whole exchange, body included
//   size cap      1 MB, then dropped
//   errors        ChatHttpError with a sentence; a token or secret is never
//                 in it (the caller's `secrets` are scrubbed out) and never
//                 logged
//
// Tests swap the transport (setChatTransportForTests) for one that sends the
// same requests to an in-process fake (test/support/fake-chat). Server-only.

import "server-only";

export type ChatTransport = (url: string, init: RequestInit) => Promise<Response>;

let testTransport: ChatTransport | null = null;

/** Tests: send every request through `t` instead of safeFetchOnce (null restores it). */
export function setChatTransportForTests(t: ChatTransport | null): void {
  testTransport = t;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  if (testTransport) return testTransport(url, init);
  const { safeFetchOnce } = await import("../../safe-fetch");
  return safeFetchOnce(url, init);
}

export class ChatHttpError extends Error {
  constructor(
    message: string,
    /** The HTTP status; 0 when nothing came back. */
    public status: number,
    /** Slack's `error` code, or Microsoft's `error`, when the answer named one. */
    public code = ""
  ) {
    super(message);
  }
}

export const CHAT_HTTP = { timeoutMs: 8_000, maxBytes: 1024 * 1024 } as const;

export interface ChatRequest {
  url: string;
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  /** A string body (JSON or form-encoded: set content-type in headers). */
  body?: string;
  /** Who answers, for messages ("Slack"). */
  label: string;
  /** Hosts this call may reach (exact, or ".suffix" for any subdomain). */
  allowHosts: string[];
  /** Values that must never appear in an error message. */
  secrets?: string[];
  timeoutMs?: number;
}

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((a) => (a.startsWith(".") ? h.endsWith(a) && h.length > a.length : h === a));
}

export function scrubSecrets(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[secret]");
  return out;
}

async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!res.body) return "";
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
  return Buffer.concat(chunks).toString("utf8");
}

/** One request; resolves with the status, headers and parsed JSON (null for an empty body) for any 2xx. */
export async function chatRequest(r: ChatRequest): Promise<{ status: number; json: unknown; headers: Headers }> {
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    throw new ChatHttpError(`${r.label}: that isn't a web address.`, 0);
  }
  if (url.protocol !== "https:") throw new ChatHttpError(`${r.label}: only https addresses are called.`, 0);
  if (!hostAllowed(url.hostname, r.allowHosts)) throw new ChatHttpError(`${r.label}: ${url.hostname} isn't one of ${r.label}'s addresses.`, 0);
  const ctrl = new AbortController();
  let timedOut = false;
  const timeoutMs = r.timeoutMs ?? CHAT_HTTP.timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      res = await send(url.toString(), { method: r.method ?? "GET", headers: r.headers, body: r.body, signal: ctrl.signal, redirect: "manual" });
    } catch {
      throw new ChatHttpError(timedOut ? `${r.label} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` : `Couldn't reach ${r.label}. Check this server can reach ${url.hostname}.`, 0);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new ChatHttpError(`${r.label} answered with a redirect, which isn't followed.`, res.status);
    }
    let text: string | undefined;
    try {
      text = await readCapped(res, CHAT_HTTP.maxBytes);
    } catch {
      throw new ChatHttpError(timedOut ? `${r.label} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` : `${r.label}'s answer was cut off.`, 0);
    }
    if (text === undefined) throw new ChatHttpError(`${r.label}'s answer was too large to read.`, res.status);
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (res.status >= 400) {
      const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
      const err = o.error;
      const code = typeof err === "string" ? err : typeof (err as Record<string, unknown>)?.code === "string" ? String((err as Record<string, unknown>).code) : "";
      const said = typeof o.error_description === "string" ? o.error_description : typeof (err as Record<string, unknown>)?.message === "string" ? String((err as Record<string, unknown>).message) : "";
      const tail = said ? ` ${r.label} said: ${scrubSecrets(said.split(/\r?\n/)[0].slice(0, 200), r.secrets)}` : "";
      throw new ChatHttpError(`${r.label} refused the request (error ${res.status}).${tail}`, res.status, code);
    }
    if (json === undefined) throw new ChatHttpError(`${r.label} didn't answer with JSON.`, res.status);
    return { status: res.status, json, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}
