// A fake Microsoft identity platform + Microsoft Graph for tests (1.19.4,
// lib/helpdesk/assets/intune). Never call the real Microsoft: an in-process
// node:http server on 127.0.0.1 answers the two hosts the client uses:
//
//   login.microsoftonline.com  POST /{tenant}/oauth2/v2.0/token
//                              (client_credentials; checks tenant, client ID,
//                              secret and scope; AAD's error shape on a
//                              wrong secret)
//   graph.microsoft.com        GET /v1.0/deviceManagement/managedDevices
//                              ($top, $select, $filter on serialNumber /
//                              userPrincipalName / emailAddress eq, and
//                              startswith(deviceName,…); @odata.nextLink
//                              paging), GET …/managedDevices/{id}
//
// Tokens look like Entra's (a JWT whose payload carries `tid`, the tenant
// ID); `tenants` maps every name a tenant answers to (its GUID, its
// domains) to that tid, so two spellings of one tenant sign in to the same
// tid. `opaqueTokens` hands out tokens with no readable claims, and
// GET /v1.0/organization then says the tid.
//
// The bearer token is checked on every Graph call. `forbid` answers 403 the
// way Graph does without DeviceManagementManagedDevices.Read.All; `fail`
// cans a failure for one path; `expireTokens()` makes the issued tokens
// stale (a 401, as Graph does after expiry). Requests are recorded in `seen`
// with the secret never echoed.
//
// Point the asset transport at it with fakeIntuneTransport (the same
// setAssetTransportForTests the Snipe-IT fake uses); pass the Snipe-IT
// fake's transport as `fallback` to run both sources at once.
//
//   const fake = await startFakeIntune({ tenant, clientId, secret });
//   fake.state.devices.push(fakeDevice("d-1", { serialNumber: "C02XK2Q1MD6R" }));
//   setAssetTransportForTests(fakeIntuneTransport(fake.port, fakeSnipeItTransport(snipePort)));

import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

export interface FakeIntuneState {
  devices: Obj[];
  /** Answer every managedDevices call with Graph's 403 (the permission is missing). */
  forbid: boolean;
  /** path → a canned failure, used `times` times. */
  fail: Map<string, { status: number; body?: unknown; headers?: Record<string, string>; times: number }>;
  seen: { method: string; host: string; path: string; auth: string; body: string }[];
  tokensIssued: number;
  /** Leave the last page's nextLink pointing at another host (the client must refuse it). */
  foreignNextLink: boolean;
  /** Page size the server uses when $top is larger (Graph pages at 1000 at most). */
  maxPage: number;
  /** Every name a tenant signs in by (lower-cased) → its tenant ID. */
  tenants: Map<string, string>;
  /** App registrations (client IDs) that sign in with the secret. */
  clientIds: Set<string>;
  /** Hand out tokens whose claims can't be read (the client must ask /organization). */
  opaqueTokens: boolean;
  organizationCalls: number;
  /** Delay each device-list page this long (ms), to hold a sync mid-way. */
  pageDelayMs: number;
}

/** A managedDevice as Graph returns it. */
export function fakeDevice(id: string, extra: Obj = {}): Obj {
  return {
    id,
    deviceName: `DEVICE-${id}`,
    serialNumber: `SER-${id}`,
    model: "MacBook Pro 14 (2024)",
    manufacturer: "Apple",
    operatingSystem: "macOS",
    osVersion: "15.2",
    complianceState: "compliant",
    lastSyncDateTime: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    userPrincipalName: "",
    emailAddress: "",
    userDisplayName: "",
    // Fields the client never asks for (it $selects) must never be cached.
    imei: "35-000000-000000-0",
    ...extra,
  };
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Graph's $filter, the shapes the client sends. */
function matches(d: Obj, filter: string): boolean {
  const eq = /^(\w+) eq '((?:[^']|'')*)'$/.exec(filter);
  if (eq) return String(d[eq[1]] ?? "").toLowerCase() === eq[2].replace(/''/g, "'").toLowerCase();
  const sw = /^startswith\((\w+),'((?:[^']|'')*)'\)$/.exec(filter);
  if (sw) return String(d[sw[1]] ?? "").toLowerCase().startsWith(sw[2].replace(/''/g, "'").toLowerCase());
  throw new Error(`fake Graph: unsupported $filter ${filter}`);
}

function select(d: Obj, sel: string | null): Obj {
  if (!sel) return d;
  const out: Obj = {};
  for (const k of sel.split(",")) if (k in d) out[k] = d[k];
  return out;
}

/** A token shaped like Entra's: header.payload.signature, the payload carrying tid. */
function jwt(tid: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ typ: "JWT", alg: "RS256" })}.${b64({ aud: "https://graph.microsoft.com", tid, roles: ["DeviceManagementManagedDevices.Read.All"], jti: randomUUID() })}.c2lnbmF0dXJl`;
}

export async function startFakeIntune(creds: { tenant: string; clientId: string; secret: string; tid?: string }): Promise<{ state: FakeIntuneState; port: number; close: () => Promise<void>; expireTokens: () => void }> {
  const tid = (creds.tid ?? randomUUID()).toLowerCase();
  const fake: FakeIntuneState = {
    devices: [],
    forbid: false,
    fail: new Map(),
    seen: [],
    tokensIssued: 0,
    foreignNextLink: false,
    maxPage: 1000,
    tenants: new Map([
      [creds.tenant.toLowerCase(), tid],
      [tid, tid],
    ]),
    clientIds: new Set([creds.clientId]),
    opaqueTokens: false,
    organizationCalls: 0,
    pageDelayMs: 0,
  };
  /** token → the tenant ID it was issued for. */
  const valid = new Map<string, string>();
  const server = http.createServer(async (rq, rs) => {
    const host = String(rq.headers["x-fake-host"] ?? "");
    const u = new URL(rq.url ?? "/", "http://x");
    const p = u.pathname;
    let raw = "";
    for await (const chunk of rq) raw += chunk;
    fake.seen.push({ method: rq.method ?? "", host, path: `${p}${u.search}`, auth: String(rq.headers.authorization ?? ""), body: raw.split(creds.secret).join("[secret]") });
    for (const [where, f] of fake.fail) {
      if (p === where && f.times > 0) {
        f.times--;
        return json(rs, f.status, f.body ?? { error: { code: "InternalServerError", message: "Nope" } }, f.headers ?? {});
      }
    }

    if (host === "login.microsoftonline.com") {
      const m = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(p);
      if (!m || rq.method !== "POST") return json(rs, 404, { error: "not_found" });
      if (rq.headers["content-type"] !== "application/x-www-form-urlencoded") return json(rs, 400, { error: "invalid_request", error_description: "AADSTS900144: form body expected." });
      const f = new URLSearchParams(raw);
      const forTid = fake.tenants.get(decodeURIComponent(m[1]).toLowerCase());
      if (!forTid) return json(rs, 400, { error: "invalid_request", error_description: `AADSTS90002: Tenant '${m[1]}' not found.` });
      if (f.get("grant_type") !== "client_credentials" || f.get("scope") !== "https://graph.microsoft.com/.default") return json(rs, 400, { error: "invalid_scope" });
      if (!fake.clientIds.has(f.get("client_id") ?? "") || f.get("client_secret") !== creds.secret) {
        // AAD names the client, never echoes the secret; the client must not either.
        return json(rs, 401, { error: "invalid_client", error_description: `AADSTS7000215: Invalid client secret provided for ${f.get("client_secret")}.` });
      }
      const token = fake.opaqueTokens ? `fake-graph-${randomUUID()}` : jwt(forTid);
      valid.set(token, forTid);
      fake.tokensIssued++;
      return json(rs, 200, { token_type: "Bearer", expires_in: 3599, access_token: token });
    }

    if (host !== "graph.microsoft.com") return json(rs, 404, { error: "unknown host" });
    const auth = String(rq.headers.authorization ?? "");
    if (!auth.startsWith("Bearer ") || !valid.has(auth.slice(7))) {
      return json(rs, 401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." } });
    }
    if (fake.forbid && p.startsWith("/v1.0/deviceManagement/")) {
      return json(rs, 403, { error: { code: "Forbidden", message: "Application is not authorized to perform this operation. Application must have one of the following scopes: DeviceManagementManagedDevices.Read.All" } });
    }
    let m: RegExpExecArray | null;
    if (p === "/v1.0/organization") {
      fake.organizationCalls++;
      return json(rs, 200, { value: [{ id: valid.get(auth.slice(7)), displayName: "Fake tenant" }] });
    }
    if (p === "/v1.0/deviceManagement/managedDevices") {
      if (fake.pageDelayMs) await new Promise((r) => setTimeout(r, fake.pageDelayMs));
      const filter = u.searchParams.get("$filter");
      const sel = u.searchParams.get("$select");
      const top = Math.min(fake.maxPage, Number(u.searchParams.get("$top") ?? 100));
      const skip = Number(u.searchParams.get("$skiptoken") ?? 0);
      let rows = [...fake.devices];
      if (filter) rows = rows.filter((d) => matches(d, filter));
      const page = rows.slice(skip, skip + top).map((d) => select(d, sel));
      const body: Obj = { "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#deviceManagement/managedDevices", value: page };
      if (u.searchParams.get("$count") === "true") body["@odata.count"] = rows.length;
      if (skip + top < rows.length) {
        const next = new URL(`https://graph.microsoft.com${p}`);
        for (const [k, v] of u.searchParams) if (k !== "$skiptoken") next.searchParams.set(k, v);
        next.searchParams.set("$skiptoken", String(skip + top));
        body["@odata.nextLink"] = fake.foreignNextLink && skip + 2 * top >= rows.length ? next.toString().replace("graph.microsoft.com", "evil.test") : next.toString();
      }
      return json(rs, 200, body);
    }
    if ((m = /^\/v1\.0\/deviceManagement\/managedDevices\/([^/]+)$/.exec(p))) {
      const d = fake.devices.find((x) => x.id === decodeURIComponent(m![1]));
      return d ? json(rs, 200, select(d, u.searchParams.get("$select"))) : json(rs, 404, { error: { code: "ResourceNotFound", message: "Not found" } });
    }
    return json(rs, 404, { error: { code: "BadRequest", message: "Resource not found for the segment." } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    state: fake,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    expireTokens: () => valid.clear(),
  };
}

/**
 * A transport that sends https://login.microsoftonline.com/… and
 * https://graph.microsoft.com/… to the fake (the host in x-fake-host);
 * any other host goes to `fallback`, or fails like an unknown name.
 */
export function fakeIntuneTransport(port: number, fallback?: (url: string, init: RequestInit) => Promise<Response>): (url: string, init: RequestInit) => Promise<Response> {
  return (url, init) => {
    const u = new URL(url);
    if (u.host === "login.microsoftonline.com" || u.host === "graph.microsoft.com") {
      const headers = new Headers(init.headers);
      headers.set("x-fake-host", u.host);
      return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers });
    }
    if (fallback) return fallback(url, init);
    return Promise.reject(new Error(`Could not resolve host: ${u.host}`));
  };
}
