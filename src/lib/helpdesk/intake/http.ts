// Helpdesk 1.19.0, machine intake (agent P): POST /api/helpdesk/intake/<id>.
// No session: the integration's API key is the credential.
//
//   402  the helpdesk is not licensed
//   401  no such integration, an email integration, or a wrong key (one
//        answer for all three, so ids can't be probed); compared as sha256
//        hashes in constant time
//   403  the integration is turned off
//   429  over the integration's rate limit (per minute), or too many
//        failed keys: 30 a minute from one address, 120 a minute against
//        one integration (checked before any key is compared or any row
//        written)
//   413  a body over 256 KB
//   400  not JSON, or not this tool's payload
//   200  processed: {ok, outcome, ticket, results:[{dedup_key, outcome,
//        ticket, reason}]}; a retry of the same request: duplicate: true
//
// The key goes in `Authorization: Bearer <key>` (or `X-Api-Key`); tools
// that can't set a header (Azure Monitor action groups) may put it in
// `?key=`. The key is never logged or stored. A refused request writes at
// most one deliveries-log row per integration and reason a minute, so a
// flood of bad keys cannot push real deliveries out of the log. Server-only.

import "server-only";
import { logEvent } from "../../log";
import { helpdeskLicensed, HD_LICENCE_ERROR } from "../access";
import { adaptPayload, IntakePayloadError } from "./adapters";
import { getIntegration, keyMatches, recordDelivery } from "./integrations";
import { auditRejection, intakeLimited, processAlerts, requestKeys, type IntakeResponse } from "./intake";
import { HD_INTAKE_LIMITS } from "./shared";

class TooLarge extends Error {}

/** The body as text, refusing more than `max` bytes however it is sent. */
async function readCapped(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > max) throw new TooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export function presentedKey(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
  if (m) return m[1];
  const x = req.headers.get("x-api-key");
  if (x) return x.trim();
  return new URL(req.url).searchParams.get("key")?.trim() ?? "";
}

const fail = (status: number, error: string): IntakeResponse => ({ status, body: { ok: false, error } });

/** Failed-key budget (per minute): one address, one integration. */
export const INTAKE_AUTH_FAIL_LIMITS = { perIp: 30, perIntegration: 120 } as const;

// Failure counters are peeked before a request is looked at and bumped on
// a failure only, so a tool with the right key is never slowed by them.
const authFails = new Map<string, { count: number; resetAt: number }>();

function failCount(key: string, now = Date.now()): number {
  const w = authFails.get(key);
  return w && now < w.resetAt ? w.count : 0;
}

function bumpFail(key: string, now = Date.now()): void {
  let w = authFails.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + 60_000 };
    authFails.set(key, w);
  }
  w.count++;
  if (authFails.size > 10_000) for (const [k, v] of authFails) if (now >= v.resetAt) authFails.delete(k);
}

/** Tests: forget the failure counters. */
export function resetIntakeAuthFailuresForTests(): void {
  authFails.clear();
}

/** A refused request's deliveries-log row: at most one per integration and reason a minute. */
async function recordRejected(integrationId: number, status: number, reasonKey: string, reason: string): Promise<void> {
  if (intakeLimited(`delivery-reject:${integrationId}:${reasonKey}`, 1)) return;
  await recordDelivery({ integration_id: integrationId, status_code: status, outcome: "rejected", reason });
}

export async function handleIntakeRequest(req: Request, idParam: string, opts: { origin?: string; ip?: string | null } = {}): Promise<IntakeResponse> {
  if (!(await helpdeskLicensed())) return fail(402, HD_LICENCE_ERROR);
  const id = /^\d{1,10}$/.test(idParam) ? Number(idParam) : 0;
  const ipKey = `ip:${opts.ip || "unknown"}`;
  const intKey = `int:${id}`;
  // Too many wrong keys lately: refuse before any lookup or write.
  if (failCount(ipKey) >= INTAKE_AUTH_FAIL_LIMITS.perIp || (id && failCount(intKey) >= INTAKE_AUTH_FAIL_LIMITS.perIntegration)) {
    return { status: 429, body: { ok: false, error: "Too many failed attempts. Try again in a minute." } };
  }
  const integration = id ? await getIntegration(id) : undefined;
  const key = presentedKey(req);
  if (!integration || integration.kind === "email" || !keyMatches(key, integration.token_hash)) {
    bumpFail(ipKey);
    if (id) bumpFail(intKey);
    if (integration) {
      await recordRejected(integration.id, 401, key ? "bad_key" : "no_key", key ? "Wrong API key." : "No API key.");
      await auditRejection(integration, integration.id, key ? "bad_key" : "no_key", {}, opts.ip ?? null);
    }
    logEvent("warn", "helpdesk.intake_rejected", { reason: "auth", integration: id || null });
    return fail(401, "Unknown integration or wrong API key.");
  }
  if (integration.enabled !== 1) {
    await recordRejected(integration.id, 403, "disabled", "The integration is turned off.");
    await auditRejection(integration, integration.id, "disabled", {}, opts.ip ?? null);
    return fail(403, "This integration is turned off.");
  }
  if (intakeLimited(`intake:${integration.id}`, integration.rate_limit_per_minute)) {
    await recordRejected(integration.id, 429, "rate_limited", "Rate limit reached.");
    await auditRejection(integration, integration.id, "rate_limited", {}, opts.ip ?? null);
    return { status: 429, body: { ok: false, error: "Too many alerts. Try again shortly." } };
  }
  let raw: string;
  try {
    raw = await readCapped(req, HD_INTAKE_LIMITS.bodyBytes);
  } catch (e) {
    if (e instanceof TooLarge) {
      await recordDelivery({ integration_id: integration.id, status_code: 413, outcome: "rejected", reason: "Body over 256 KB." });
      return fail(413, "The payload is too large (256 KB at most).");
    }
    throw e;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    await recordDelivery({ integration_id: integration.id, status_code: 400, outcome: "rejected", reason: "Not JSON." });
    return fail(400, "The body must be JSON.");
  }
  let alerts;
  try {
    alerts = adaptPayload(integration.kind, body);
  } catch (e) {
    if (e instanceof IntakePayloadError) {
      await recordDelivery({ integration_id: integration.id, status_code: 400, outcome: "rejected", reason: e.message });
      return fail(400, e.message);
    }
    throw e;
  }
  const requestId = req.headers.get("idempotency-key") ?? req.headers.get("x-request-id");
  return processAlerts(integration, alerts, { requestKeys: requestKeys(raw, requestId), origin: opts.origin, ip: opts.ip ?? null });
}
