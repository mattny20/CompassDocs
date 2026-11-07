// Helpdesk 1.19.3 assets on tickets with Snipe-IT (lib/helpdesk/assets).
// A fake Snipe-IT runs in-process (node:http on 127.0.0.1); the asset
// transport (setAssetTransportForTests) sends every request the client
// makes for https://snipe.test there, so the real client code, its headers,
// paging, timeouts, size cap, redirect rule and error mapping are all
// exercised over HTTP. Covered:
//
//   http       401/403/404/429/5xx, timeout, not JSON, too large, redirect to
//              another host refused / same host followed, http refused, a
//              loopback address blocked by safeFetchOnce, the key scrubbed
//              from messages and never logged
//   client     paging (sort by id, 500 a page, 429 back-off), bytag,
//              byserial, users?search → users/{id}/assets, hardware/{id},
//              maintenances list, POST maintenances (fields; 200 "error"),
//              suppliers; HTML-escaped strings
//   cache      full sync (upsert, unlinked rows deleted, linked rows gone),
//              not due within 30 minutes, one run at a time, the failure
//              recorded without the key, the sweep
//   links      the picker (requester's assets first, live lookup when the
//              cache has none, search incl. a live tag lookup), link and
//              unlink (timeline + audit, 409s, ten at most), who may
//              (agents who work the ticket; search-all off narrows)
//   page       visible tickets and a count of the rest, maintenance, the
//              live refresh, the notice when the source fails
//   solve      the offer, logging after the solve (note with #N), the
//              failure note, never twice
//   settings   the route (settings.manage; key never returned, sealed at
//              rest, a new address needs the key again, Test connection
//              never sends a saved key to a new host, disconnect; audited)
//   privacy    merge moves links, anonymising drops them, the personal
//              export lists tag + name; requesters' Device picker shows
//              only their own; connector read + lookup
//   limits     merge moves every link (13 on the kept ticket is fine), an
//              11th by hand is refused; solving it: the offer lists all
//              13, a record for the first ten logs ten, 11 ids give 400
//   offline    after a disconnect the cache is history only: no link,
//              picker (connected: false), Device picker or maintenance; unlinking still works;
//              search and the asset page keep linked assets readable;
//              reconnecting the same address keeps the cache
//
// Parallel-safe: teams, people, tickets and asset rows are this file's own
// (STAMP; the cache rows live under provider "snipeit:<STAMP>"). Asset
// settings are overridden in-process; the one test of the settings route
// writes the real row under an advisory lock and restores it.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-assets.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { fakeHardware, fakePerson, fakeSnipeItTransport, startFakeSnipeIt, type FakeSnipeItState, type Obj } from "./support/fake-snipeit";
import { pool, getSetting, createSession, getUserById } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-assets.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-assets.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const assets = require("../src/lib/helpdesk/assets") as typeof import("../src/lib/helpdesk/assets");
const shared = require("../src/lib/helpdesk/assets-shared") as typeof import("../src/lib/helpdesk/assets-shared");
const httpMod = require("../src/lib/helpdesk/assets/http") as typeof import("../src/lib/helpdesk/assets/http");
const snipe = require("../src/lib/helpdesk/assets/snipeit") as typeof import("../src/lib/helpdesk/assets/snipeit");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const periodic = require("../src/lib/periodic") as typeof import("../src/lib/periodic");
const withTx = (require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core")).withTx;
const adminRoute = require("../src/app/api/helpdesk/admin/assets/route") as typeof import("../src/app/api/helpdesk/admin/assets/route");
const adminTestRoute = require("../src/app/api/helpdesk/admin/assets/test/route") as typeof import("../src/app/api/helpdesk/admin/assets/test/route");
const adminSyncRoute = require("../src/app/api/helpdesk/admin/assets/sync/route") as typeof import("../src/app/api/helpdesk/admin/assets/sync/route");
const ticketAssetsRoute = require("../src/app/api/helpdesk/tickets/[number]/assets/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/assets/route");
const ticketAssetRoute = require("../src/app/api/helpdesk/tickets/[number]/assets/[assetId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/assets/[assetId]/route");
const optionsRoute = require("../src/app/api/helpdesk/tickets/[number]/assets/options/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/assets/options/route");
const solveRoute = require("../src/app/api/helpdesk/tickets/[number]/assets/solve/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/assets/solve/route");
const assetRoute = require("../src/app/api/helpdesk/assets/[id]/route") as typeof import("../src/app/api/helpdesk/assets/[id]/route");
const searchRoute = require("../src/app/api/helpdesk/assets/route") as typeof import("../src/app/api/helpdesk/assets/route");
const mineRoute = require("../src/app/api/helpdesk/assets/mine/route") as typeof import("../src/app/api/helpdesk/assets/mine/route");
const requestsRoute = require("../src/app/api/helpdesk/requests/route") as typeof import("../src/app/api/helpdesk/requests/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any; text: string }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, text };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`http://localhost/api/helpdesk${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// The Snipe-IT key is sealed at rest: give secretbox a key so it never needs
// the uploads key file (CI has no writable /uploads), as the push tests do.
process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

const STAMP = `hdas-${Date.now()}-${process.pid}`;
const TAGP = `T${Date.now().toString(36)}${process.pid}`.toUpperCase();
const KEY = `snipe-key-${STAMP}-0123456789abcdefghijklmnop`;
const PROVIDER = `snipeit:${STAMP}`;
const P: Record<string, { id: number; session: string; name: string; email: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const ticketIds: number[] = [];

// --- The fake Snipe-IT (test/support/fake-snipeit) -----------------------------------------------

let fake: FakeSnipeItState;
let closeFake: () => Promise<void> = async () => {};
let port = 0;
const hw = (id: number, extra: Obj = {}) => fakeHardware(id, TAGP, extra);
const person = fakePerson;

async function startFake(): Promise<void> {
  const f = await startFakeSnipeIt(KEY);
  fake = f.state;
  port = f.port;
  closeFake = f.close;
}

/** The fake's addresses as the client sees them: https://snipe.test/… → the local server. */
function useFake() {
  httpMod.setAssetTransportForTests(fakeSnipeItTransport(port));
}

const SETTINGS = (over: Partial<import("../src/lib/helpdesk/assets").AssetSettings["snipeit"]> = {}, searchAll = true): import("../src/lib/helpdesk/assets").AssetSettings => ({
  snipeit: { url: "https://snipe.test", token: KEY, on_solve: "offer_maintenance", ...over },
  agents_search_all: searchAll,
});

// --- Fixtures -----------------------------------------------------------------------------

async function personRow(key: string, deskRole: string | null) {
  const name = `${key} ${STAMP}`;
  const mail = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${key}`, name, mail]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[key] = { id, session, name, email: mail };
}

async function ticket(subject: string, who = "req", team = "A", status = "open"): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source) VALUES ($1, $2, $3, $4, $5, $6, 'portal') RETURNING id, number",
    [`${subject} ${STAMP}`, P[who].id, P[who].name, P[who].email, T[team], status]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

const lines = async (ticketId: number) =>
  (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows as { kind: string; body: string }[];
const auditRows = async (action: string) =>
  (await pool().query("SELECT actor_id, details FROM audit_log WHERE action = $1 AND (actor_id = ANY($2) OR target_label LIKE $3) ORDER BY id", [action, userIds, `%${STAMP}%`])).rows;
const cacheId = async (externalId: number) =>
  (await pool().query("SELECT id FROM hd_assets WHERE provider = $1 AND external_id = $2", [PROVIDER, String(externalId)])).rows[0]?.id as number | undefined;

const SYNC_KEY = `helpdesk_assets_sync:${PROVIDER}`;
/** Set the sync record's times to "<interval> ago" on the database's clock. */
async function setSync(v: { started_at: string; heartbeat_at: string; at: string | null; run_id?: string }) {
  const ago = (i: string | null) => (i === null ? "NULL::text" : `to_char((now() - interval '${i}') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  await pool().query(
    `INSERT INTO settings (key, value) SELECT $1, jsonb_build_object('run_id', $2::text, 'started_at', ${ago(v.started_at)}, 'heartbeat_at', ${ago(v.heartbeat_at)}, 'at', ${ago(v.at)}, 'ok', true, 'error', '', 'total', 0)::text
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SYNC_KEY, v.run_id ?? "old"]
  );
}

const REQ_ASSET = 5001;
const REQ2_ASSET = 5002;
const MONITOR = 5003;

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  email.setHelpdeskTransportForTests(async () => {});
  await startFake();
  useFake();
  assets.setSnipeItCacheKeyForTests(PROVIDER);
  assets.setAssetSettingsForTests(SETTINGS());
  for (const k of ["A", "B"]) {
    const r = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9400) RETURNING id", [`${STAMP} ${k}`]);
    T[k] = r.rows[0].id;
  }
  await personRow("agent", "agent");
  await personRow("other", "agent");
  await personRow("admin", "admin");
  await personRow("req", null);
  await personRow("req2", null);
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($3, $4, 'agent')", [T.A, P.agent.id, T.B, P.other.id]);
  for (let i = 1; i <= 1203; i++) fake.hardware.push(hw(i));
  fake.users.push(person(77, P.req.email, "Daniel Okafor"), person(78, P.req2.email, "Priya Natarajan"));
  fake.hardware.push(
    hw(REQ_ASSET, {
      name: "MacBook Pro 14 (2024)",
      asset_tag: `${TAGP}-REQ1`,
      serial: `C02${TAGP}`,
      assigned_to: person(77, P.req.email.toUpperCase(), "Daniel Okafor"),
      status_label: { id: 2, name: "Ready to Deploy", status_type: "deployable", status_meta: "deployed" },
    }),
    hw(REQ2_ASSET, { name: "ThinkPad X1", asset_tag: `${TAGP}-REQ2`, assigned_to: person(78, P.req2.email, "Priya Natarajan") }),
    hw(MONITOR, { name: "Dell U2723QE monitor", asset_tag: `${TAGP}-MON`, model: { id: 2, name: "U2723QE" }, category: { id: 2, name: "Monitors" } })
  );
  fake.suppliers.push({ id: 3, name: "Apple Store &amp; Repairs" }, { id: 4, name: "CDW" });
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  email.setHelpdeskTransportForTests(null);
  httpMod.setAssetTransportForTests(null);
  assets.setAssetSettingsForTests(null);
  assets.setSnipeItCacheKeyForTests(null);
  assets.setAssetTimeoutForTests(null);
  await closeFake();
  const children = await pool().query("SELECT id FROM hd_tickets WHERE id = ANY($1) OR team_id = ANY($2) OR requester_id = ANY($3)", [ticketIds, Object.values(T), userIds]);
  const all = [...new Set([...ticketIds, ...children.rows.map((r) => r.id as number)])];
  await pool().query("UPDATE hd_tickets SET merged_into = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_assets WHERE provider = $1 OR provider LIKE $2", [PROVIDER, `${PROVIDER}:retired:%`]);
  await pool().query("DELETE FROM settings WHERE key = $1", [`helpdesk_assets_sync:${PROVIDER}`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Pure -----------------------------------------------------------------------------------

describe("checks and wording (pure)", () => {
  test("the address: https only, no credentials or query; /api/v1 and slashes dropped", () => {
    assert.deepEqual(shared.checkSnipeItUrl(" https://assets.acme.com/ "), { ok: true, value: "https://assets.acme.com" });
    assert.deepEqual(shared.checkSnipeItUrl("assets.acme.com/snipe/api/v1/"), { ok: true, value: "https://assets.acme.com/snipe" });
    assert.deepEqual(shared.checkSnipeItUrl(""), { ok: true, value: "" });
    const bad = (s: string) => {
      const r = shared.checkSnipeItUrl(s);
      return r.ok ? "" : r.error;
    };
    assert.match(bad("http://assets.acme.com"), /https/);
    assert.match(bad("https://me:pw@assets.acme.com"), /user name and password/);
    assert.match(bad("https://assets.acme.com/?x=1"), /\?/);
    assert.match(bad("https://assets"), /full host name/);
    assert.match(bad("ftp://assets.acme.com"), /https/);
  });

  test("the key: one line; a pasted Bearer prefix is dropped", () => {
    assert.deepEqual(shared.checkApiKey("Bearer abc.def"), { ok: true, value: "abc.def" });
    assert.equal(shared.checkApiKey("").ok, false);
    assert.equal(shared.checkApiKey("two words").ok, false);
  });

  test("the note always carries the ticket number; the title is the number and the type, never the subject", () => {
    assert.equal(shared.noteWithTicket("Re-paired the VPN client", 1047), "Re-paired the VPN client. CompassDocs #1047.");
    assert.equal(shared.noteWithTicket("Fixed. CompassDocs #1047.", 1047), "Fixed. CompassDocs #1047.");
    assert.equal(shared.noteWithTicket("See #10470", 1047), "See #10470. CompassDocs #1047.", "#10470 is not #1047");
    assert.equal(shared.noteWithTicket("  ", 9), "CompassDocs #9.");
    assert.equal(shared.maintenanceNotePrefill(1047), "CompassDocs #1047.");
    assert.equal(shared.maintenanceTitle(1047, "Software support"), "CompassDocs #1047: Software support");
    assert.equal(shared.maintenanceTitle(1, "x".repeat(300)).length, 100);
    assert.deepEqual(shared.ticketRefs("CompassDocs #1047: Repair\nSee #988 and #988, not #12345678901"), [1047, 988]);
    assert.deepEqual(shared.ticketRefs("Battery replaced"), []);
  });

  test("status, warranty, icon and earlier-tickets wording", () => {
    assert.equal(shared.statusText({ status_kind: "deployed", status_label: "Ready to Deploy" }), "Deployed");
    assert.equal(shared.statusText({ status_kind: "pending", status_label: "In repair" }), "In repair");
    assert.equal(shared.statusTone("deployed"), "ok");
    const now = new Date("2026-11-06T12:00:00Z");
    assert.equal(shared.warrantyLabel("2027-03-11", now), "Until Mar 2027");
    assert.equal(shared.warrantyLabel("2024-03-11", now), "Ended Mar 2024");
    assert.equal(shared.warrantyLabel(null, now), "");
    assert.equal(shared.assetIcon({ category: "Laptops", model: "", name: "" }), "laptop");
    assert.equal(shared.assetIcon({ category: "Monitors", model: "", name: "" }), "monitor");
    assert.equal(shared.assetIcon({ category: "Mobile Phones", model: "iPhone 15", name: "" }), "phone");
    assert.equal(shared.earlierTicketsLabel(3), "3 earlier tickets on this asset");
    assert.equal(shared.earlierTicketsLabel(1), "1 earlier ticket on this asset");
  });

  test("a hardware row: HTML-escaping undone, a person's address lower-cased, custom fields never kept", () => {
    const a = snipe.normaliseHardware(
      hw(9, { name: "Dan&#039;s &amp; Co laptop", assigned_to: { id: 1, name: "Dan O&#039;Neil", email: "Dan@Acme.COM", type: "user" } }),
      "https://snipe.test"
    )!;
    assert.equal(a.name, "Dan's & Co laptop");
    assert.equal(a.assigned_email, "dan@acme.com");
    assert.equal(a.assigned_name, "Dan O'Neil");
    assert.equal(a.url, "https://snipe.test/hardware/9");
    assert.equal(a.purchase_date, "2024-03-11");
    assert.equal(a.warranty_end, "2027-03-11");
    assert.ok(!JSON.stringify(a).includes("should never be cached"));
    const atLocation = snipe.normaliseHardware(hw(10, { assigned_to: { id: 3, name: "Store room", type: "location" } }), "https://snipe.test")!;
    assert.equal(atLocation.assigned_email, "", "checked out to a location is nobody's");
    assert.equal(snipe.normaliseHardware({ nope: 1 }, "https://x"), null);
    const odd = snipe.normaliseHardware(hw(11, { purchase_date: { date: "0000-00-00" }, warranty_expires: "2027-02-30" }), "https://snipe.test")!;
    assert.equal(odd.purchase_date, null, "not a date");
    assert.equal(odd.warranty_end, null, "no 30 February");
  });

  test("the sync lock has its own key", () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const keys = [
      (require("../src/lib/helpdesk/db-sla") as typeof import("../src/lib/helpdesk/db-sla")).SLA_SWEEP_LOCK,
      (require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars")).CALENDAR_RECOMPUTE_LOCK,
      (require("../src/lib/helpdesk/assignment/engine") as typeof import("../src/lib/helpdesk/assignment/engine")).ASSIGNMENT_SWEEP_LOCK,
      (require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention")).RETENTION_LOCK,
      (require("../src/lib/helpdesk/recurring") as typeof import("../src/lib/helpdesk/recurring")).RECURRING_SWEEP_LOCK,
      (require("../src/lib/helpdesk/status-teams") as typeof import("../src/lib/helpdesk/status-teams")).STATUS_TEAMS_LOCK,
      7_281_962,
      assets.ASSETS_SYNC_LOCK,
    ];
    /* eslint-enable @typescript-eslint/no-require-imports */
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(periodic.HELPDESK_SWEEPS.some((s) => s.name === "hd_assets"));
  });
});

// --- HTTP ---------------------------------------------------------------------------------

describe("the HTTP layer", () => {
  const get = (p: string, extra: Partial<import("../src/lib/helpdesk/assets/http").AssetRequest> = {}) =>
    httpMod.assetRequest({ url: `https://snipe.test/api/v1${p}`, token: KEY, label: "Snipe-IT", ...extra });
  const failWith = async (p: string, extra: Partial<import("../src/lib/helpdesk/assets/http").AssetRequest> = {}) => {
    try {
      await get(p, extra);
    } catch (e) {
      return e as InstanceType<typeof httpMod.AssetHttpError>;
    }
    assert.fail("expected an error");
  };

  test("statuses map to sentences an admin can act on", async () => {
    fake.fail.set("/api/v1/suppliers", { status: 403, times: 1 });
    assert.match((await failWith("/suppliers")).message, /isn't allowed to do that in Snipe-IT \(403\)/);
    assert.match((await failWith("/nothing-here")).message, /"not found" \(404\)/);
    fake.fail.set("/api/v1/suppliers", { status: 429, headers: { "retry-after": "7" }, times: 1 });
    const limited = await failWith("/suppliers");
    assert.match(limited.message, /limiting requests right now \(429\)/);
    assert.equal(limited.retryAfterMs, 7000);
    fake.fail.set("/api/v1/suppliers", { status: 502, body: "<html>bad gateway</html>", times: 1 });
    assert.match((await failWith("/suppliers")).message, /had a problem \(error 502\)/);
    const wrongKey = await failWith("/suppliers", { token: "not-the-key" });
    assert.equal(wrongKey.status, 401);
    assert.match(wrongKey.message, /refused the API key \(401\)/);
  });

  test("a slow answer times out; HTML is not the API; a large answer is dropped", async () => {
    const slow = await failWith("/slow", { timeoutMs: 200 });
    assert.equal(slow.code, "timeout");
    assert.match(slow.message, /^Couldn't reach Snipe-IT at snipe\.test, or it didn't answer in time\./, "the same sentence as any other no-answer");
    const html = await failWith("/html");
    assert.equal(html.code, "not_json");
    assert.match(html.message, /didn't answer like the Snipe-IT API/);
    const big = await failWith("/big", { maxBytes: 1024 * 1024 });
    assert.equal(big.code, "too_large");
    assert.equal((await failWith("/big-declared")).code, "too_large", "a declared length over the cap is refused before reading");
  });

  test("redirects: to another host or to http refused; within the host followed", async () => {
    const out = await failWith("/redirect-out");
    assert.equal(out.code, "redirect");
    assert.match(out.message, /redirected to https:\/\/evil\.test/);
    assert.equal((await failWith("/redirect-http")).code, "redirect");
    const inside = await get("/redirect-in");
    assert.equal(inside.status, 200);
    assert.ok((inside.json as any).total > 0);
    assert.ok(!fake.seen.some((s) => s.path.includes("evil")));
  });

  test("http:// is refused before sending; the real transport blocks loopback", async () => {
    const before = fake.seen.length;
    const plain = await failWith("", { url: "http://snipe.test/api/v1/hardware" });
    assert.equal(plain.code, "blocked");
    assert.equal(fake.seen.length, before, "nothing was sent");
    httpMod.setAssetTransportForTests(null);
    try {
      const loop = await failWith("", { url: `https://127.0.0.1:${port}/api/v1/hardware` });
      assert.equal(loop.code, "blocked");
      const unknown = await failWith("", { url: "https://no-such-host.invalid/api/v1/hardware", timeoutMs: 3000 });
      assert.notEqual(unknown.code, "blocked");
      // Blocked, unknown, refused, bad certificate or silent: one sentence, so the wording maps no internal network.
      assert.equal(loop.message.replace("127.0.0.1:" + port, "H"), unknown.message.replace("no-such-host.invalid", "H"));
    } finally {
      useFake();
    }
  });

  test("DNS rebinding: the real transport connects to the address it checked, never to a second DNS answer", async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const tls = require("node:tls") as { connect: (...a: any[]) => any };
    const safe = require("../src/lib/safe-fetch") as typeof import("../src/lib/safe-fetch");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const lk = safe.pinnedLookup("203.0.113.10", 4);
    lk("x", { all: true }, (err: unknown, list: unknown) => assert.deepEqual([err, list], [null, [{ address: "203.0.113.10", family: 4 }]]));
    lk("x", {}, (err: unknown, addr: unknown, fam: unknown) => assert.deepEqual([err, addr, fam], [null, "203.0.113.10", 4]));
    const envKeys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
    const savedEnv = envKeys.map((k) => process.env[k]);
    for (const k of envKeys) delete process.env[k];
    const origConnect = tls.connect;
    let resolutions = 0;
    const connects: { host: string; servername: string; lookup: unknown }[] = [];
    // The check gets a public address; any second resolution would get loopback.
    safe.setSafeFetchResolverForTests(async (host: string) => {
      if (host !== "rebind.test") throw new Error("unexpected lookup");
      resolutions++;
      return [{ address: resolutions === 1 ? "203.0.113.10" : "127.0.0.1", family: 4 }];
    });
    tls.connect = (...a: any[]) => {
      const o = a.find((x) => x && typeof x === "object") ?? {};
      connects.push({ host: o.host, servername: o.servername, lookup: o.lookup });
      return origConnect.apply(tls, a);
    };
    try {
      const err = await safe.safeFetchOnce("https://rebind.test:4443/api/v1/hardware", { signal: AbortSignal.timeout(800) }).then(
        () => null,
        (e: any) => e
      );
      assert.ok(err, "nothing answers there");
      const said = String(err?.cause?.message ?? "");
      assert.ok(!said.includes("127.0.0.1"), `never the second answer: ${said}`);
    } finally {
      safe.setSafeFetchResolverForTests(null);
      tls.connect = origConnect;
      envKeys.forEach((k, i) => (savedEnv[i] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[i])));
    }
    assert.equal(resolutions, 1, "resolved once, by the check");
    assert.equal(connects.length, 1);
    assert.equal(connects[0].servername, "rebind.test", "the certificate is still checked against the name");
    assert.equal(typeof connects[0].lookup, "function", "the socket resolves through the pinned lookup");
    const got = await new Promise((resolve) => (connects[0].lookup as any)("rebind.test", {}, (_e: unknown, addr: string) => resolve(addr)));
    assert.equal(got, "203.0.113.10", "the checked address, not a second answer");
  });

  test("the key goes only in the Authorization header, is scrubbed from echoed messages and never logged", async () => {
    const logged: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const k of ["log", "error", "warn", "info"] as const) console[k] = (...a: unknown[]) => logged.push(a.map(String).join(" "));
    try {
      const echo = await failWith("/echo-key");
      assert.ok(!echo.message.includes(KEY), echo.message);
      assert.match(echo.message, /\[key\]/);
      fake.fail.set("/api/v1/hardware", { status: 500, times: 1 });
      const r = await assets.syncProvider(PROVIDER, { force: true });
      assert.equal(r.ok, false);
      assert.ok(!JSON.stringify(r).includes(KEY));
      const state = await getSetting(`helpdesk_assets_sync:${PROVIDER}`);
      assert.ok(state && !state.includes(KEY));
    } finally {
      Object.assign(console, orig);
    }
    assert.ok(!logged.join("\n").includes(KEY), "nothing logged the key");
    const last = fake.seen.at(-1)!;
    assert.equal(last.auth, `Bearer ${KEY}`);
    assert.ok(!last.path.includes(KEY), "never in the address");
  });
});

// --- The client and the cache ------------------------------------------------------------------

describe("the Snipe-IT client and the cache", () => {
  test("a full sync pages by id, 500 at a time, backs off on 429, and upserts everything", async () => {
    fake.seen.length = 0;
    fake.fail.set("/api/v1/hardware", { status: 429, headers: { "retry-after": "0" }, times: 1 });
    const r = await assets.syncProvider(PROVIDER, { force: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.seen, 1206);
    const pages = fake.seen.filter((s) => s.path.startsWith("/api/v1/hardware?limit=500"));
    assert.deepEqual(
      pages.map((s) => new URL(s.path, "http://x").searchParams.get("offset")),
      ["0", "0", "500", "1000"],
      "the 429 was retried, then three pages"
    );
    assert.ok(pages.every((s) => s.path.includes("sort=id&order=asc")));
    const n = await pool().query("SELECT count(*)::int AS n FROM hd_assets WHERE provider = $1", [PROVIDER]);
    assert.equal(n.rows[0].n, 1206);
    const mine = (await pool().query("SELECT * FROM hd_assets WHERE provider = $1 AND external_id = $2", [PROVIDER, String(REQ_ASSET)])).rows[0];
    assert.equal(mine.assigned_email, P.req.email, "lower-cased");
    assert.equal(mine.status_kind, "deployed");
    assert.deepEqual(Object.keys(mine.raw).sort(), ["manufacturer", "model_number", "status_type"]);
    const st = await assets.syncState(PROVIDER);
    assert.equal(st.ok, true);
    assert.equal(st.count, 1206);
    assert.equal(st.running, false);
  });

  test("not due within 30 minutes (the database's clock); one run at a time; the sweep only syncs when due", async () => {
    assert.deepEqual(await assets.syncProvider(PROVIDER), { ran: false, skipped: "not_due" });
    const [a, b] = await Promise.all([assets.syncProvider(PROVIDER, { force: true }), assets.syncProvider(PROVIDER, { force: true })]);
    assert.equal([a, b].filter((x) => x.skipped === "running").length, 1, "the second waits its turn");
    const rec = JSON.parse((await getSetting(SYNC_KEY))!);
    assert.ok(rec.at >= rec.started_at && rec.heartbeat_at >= rec.started_at, "every time from one clock: a finished run never looks live");
    assert.equal((await assets.syncState(PROVIDER)).running, false);
    assert.deepEqual(await assets.assetsSweep(), [{ ran: false, skipped: "not_due" }]);
    await setSync({ started_at: "32 minutes", heartbeat_at: "32 minutes", at: "31 minutes" });
    const later = await assets.assetsSweep();
    assert.equal(later[0].ran, true);
  });

  test("a run is live while its heartbeat is fresh, taken over once it's stale, and a run taken over writes nothing", async () => {
    await setSync({ started_at: "20 minutes", heartbeat_at: "1 minute", at: null, run_id: "other" });
    assert.deepEqual(await assets.syncProvider(PROVIDER, { force: true }), { ran: false, skipped: "running" }, "a long run with a fresh heartbeat");
    assert.equal((await assets.syncState(PROVIDER)).running, true);
    await setSync({ started_at: "20 minutes", heartbeat_at: "6 minutes", at: null, run_id: "other" });
    assert.equal((await assets.syncProvider(PROVIDER, { force: true })).ok, true, "a stale heartbeat: the run died");
    fake.fail.set("/api/v1/hardware", { status: 429, headers: { "retry-after": "1" }, times: 1 });
    const run = assets.syncProvider(PROVIDER, { force: true });
    await new Promise((r) => setTimeout(r, 400));
    await pool().query(`UPDATE settings SET value = jsonb_set(value::jsonb, '{run_id}', '"thief"')::text WHERE key = $1`, [SYNC_KEY]);
    const r = await run;
    assert.equal(r.error, "Another sync took over.");
    const after = JSON.parse((await getSetting(SYNC_KEY))!);
    assert.equal(after.run_id, "thief");
    assert.ok(!after.at || after.at < after.started_at, "it didn't write its result over the other run's record");
    await setSync({ started_at: "40 minutes", heartbeat_at: "40 minutes", at: "39 minutes" });
  });

  test("an asset the source dropped: missed by two complete syncs, then deleted, or marked gone once Snipe-IT says so by id", async () => {
    const t = await ticket("Gone");
    const linkedId = (await cacheId(1))!;
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2)", [t.id, linkedId]);
    const dropped = fake.hardware.splice(0, 2);
    try {
      const first = await assets.syncProvider(PROVIDER, { force: true });
      assert.equal(first.complete, true);
      assert.equal(first.removed, 0, "missed once: kept");
      assert.ok(await cacheId(2));
      assert.equal((await assets.getAsset(linkedId))!.gone, false);
      const second = await assets.syncProvider(PROVIDER, { force: true });
      assert.equal(second.removed, 1);
      assert.equal(second.gone, 1);
      assert.equal(await cacheId(2), undefined, "unlinked: deleted");
      assert.ok((await assets.getAsset(linkedId))!.gone, "linked: kept, gone");
      assert.ok(fake.seen.some((x) => x.path === "/api/v1/hardware/1"), "asked by id first");
    } finally {
      fake.hardware.unshift(...dropped);
    }
    await assets.syncProvider(PROVIDER, { force: true });
    assert.equal((await assets.getAsset(linkedId))!.gone, false, "back in the source: not gone");
  });

  test("a linked asset the list skipped but Snipe-IT still has by id is never marked gone", async () => {
    const t = await ticket("Skipped");
    const id = (await cacheId(3))!;
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2)", [t.id, id]);
    fake.hideFromList.add(3);
    try {
      await assets.syncProvider(PROVIDER, { force: true });
      const r = await assets.syncProvider(PROVIDER, { force: true });
      assert.equal(r.gone, 0);
      assert.equal((await assets.getAsset(id))!.gone, false);
      assert.equal((await pool().query("SELECT missing_since FROM hd_assets WHERE id = $1", [id])).rows[0].missing_since, null, "found by id: seen");
    } finally {
      fake.hideFromList.delete(3);
    }
  });

  test("a pass cut short (the page cap, or fewer rows than the reported total) removes nothing", async () => {
    const dropped = fake.hardware.splice(0, 2);
    try {
      await pool().query("UPDATE hd_assets SET missing_since = now() - interval '1 hour' WHERE provider = $1 AND external_id IN ('1', '2')", [PROVIDER]);
      snipe.setSnipeItPagingForTests({ page: 500, maxPages: 1 });
      const capped = await assets.syncProvider(PROVIDER, { force: true });
      snipe.setSnipeItPagingForTests(null);
      assert.equal(capped.complete, false);
      assert.equal(capped.ok, false);
      assert.match(capped.error!, /stopped after 500 of 1,20\d assets, so nothing was removed/);
      assert.ok(await cacheId(2), "not removed");
      fake.extraTotal = 5;
      const short = await assets.syncProvider(PROVIDER, { force: true });
      assert.equal(short.complete, false, "an empty page before the reported total");
      assert.ok(await cacheId(2), "still not removed");
      assert.equal((await assets.syncState(PROVIDER)).ok, false);
    } finally {
      snipe.setSnipeItPagingForTests(null);
      fake.extraTotal = 0;
      fake.hardware.unshift(...dropped);
    }
    assert.equal((await assets.syncProvider(PROVIDER, { force: true })).ok, true);
  });

  test("lookups: bytag (found, 200-error), byserial, a person's assets, one asset, maintenance and suppliers", async () => {
    const p = (await assets.providerFor(PROVIDER))!;
    assert.equal((await p.byTag(`${TAGP}-REQ1`))!.external_id, String(REQ_ASSET));
    assert.equal(await p.byTag("NOPE-404"), null);
    assert.equal((await p.bySerial(`C02${TAGP}`))[0].external_id, String(REQ_ASSET));
    assert.deepEqual(await p.bySerial("NOPE"), []);
    const theirs = (await p.forEmail(P.req.email.toUpperCase()))!;
    assert.deepEqual(theirs.map((a) => a.external_id), [String(REQ_ASSET)]);
    assert.ok(fake.seen.some((s) => s.path.startsWith(`/api/v1/users?search=${encodeURIComponent(P.req.email)}`)));
    assert.ok(fake.seen.some((s) => s.path === "/api/v1/users/77/assets"));
    assert.equal(await p.forEmail("nobody@example.test"), null);
    assert.equal((await p.get(String(MONITOR)))!.name, "Dell U2723QE monitor");
    assert.equal(await p.get("999999"), null);
    assert.deepEqual(await p.maintenance!.suppliers(), [
      { id: 3, name: "Apple Store & Repairs" },
      { id: 4, name: "CDW" },
    ]);
  });
});

// --- Links, the picker and who may -----------------------------------------------------------------

describe("linking assets to tickets", () => {
  let t: { id: number; number: number };
  before(async () => {
    assets.setAssetSettingsForTests(SETTINGS());
    t = await ticket("Laptop won't connect to VPN from home");
  });

  test("the card: configured, nothing linked, the requester named", async () => {
    const r = await call(ticketAssetsRoute.GET, req(`/tickets/${t.number}/assets`, P.agent.session), { number: String(t.number) });
    assert.equal(r.status, 200);
    assert.equal(r.body.configured, true);
    assert.equal(r.body.can_edit, true);
    assert.deepEqual(r.body.assets, []);
    assert.equal(r.body.requester.email, P.req.email);
    assert.equal(r.body.search_all, true);
  });

  test("the picker: the requester's assets first; a search; an exact tag the cache lacks is looked up live", async () => {
    const o = await call(optionsRoute.GET, req(`/tickets/${t.number}/assets/options`, P.agent.session), { number: String(t.number) });
    assert.equal(o.status, 200);
    assert.deepEqual(o.body.assigned.map((a: any) => a.tag), [`${TAGP}-REQ1`]);
    assert.deepEqual(o.body.results, []);
    const s = await call(optionsRoute.GET, req(`/tickets/${t.number}/assets/options?q=${TAGP}-MON`, P.agent.session), { number: String(t.number) });
    assert.deepEqual(s.body.results.map((a: any) => a.name), ["Dell U2723QE monitor"]);
    fake.hardware.push(hw(6000, { name: "New iPad", asset_tag: `${TAGP}-NEW`, category: { id: 3, name: "Tablets" } }));
    try {
      const live = await call(optionsRoute.GET, req(`/tickets/${t.number}/assets/options?q=${TAGP.toLowerCase()}-new`, P.agent.session), { number: String(t.number) });
      assert.deepEqual(live.body.results.map((a: any) => a.tag), [`${TAGP}-NEW`], "found in Snipe-IT and cached");
      assert.ok(fake.seen.some((x) => x.path === `/api/v1/hardware/bytag/${TAGP.toLowerCase()}-new`));
    } finally {
      fake.hardware.pop();
    }
  });

  test("a requester with nothing cached is looked up live (users?search, then their assets)", async () => {
    const t2 = await ticket("Second requester", "req2");
    await pool().query("DELETE FROM hd_assets WHERE provider = $1 AND external_id = $2", [PROVIDER, String(REQ2_ASSET)]);
    fake.seen.length = 0;
    const o = await call(optionsRoute.GET, req(`/tickets/${t2.number}/assets/options`, P.agent.session), { number: String(t2.number) });
    assert.deepEqual(o.body.assigned.map((a: any) => a.name), ["ThinkPad X1"]);
    assert.ok(fake.seen.some((x) => x.path === "/api/v1/users/78/assets"));
    fake.seen.length = 0;
    await pool().query("DELETE FROM hd_assets WHERE provider = $1 AND external_id = $2", [PROVIDER, String(REQ2_ASSET)]);
    await call(optionsRoute.GET, req(`/tickets/${t2.number}/assets/options`, P.agent.session), { number: String(t2.number) });
    assert.equal(fake.seen.length, 0, "not again within ten minutes");
  });

  test("link: timeline and audit; again is 409; unlink; the agent of another team gets 404; a requester 403", async () => {
    const id = (await cacheId(REQ_ASSET))!;
    const r = await call(ticketAssetsRoute.POST, req(`/tickets/${t.number}/assets`, P.agent.session, { asset_id: id }), { number: String(t.number) });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.assets[0].name, "MacBook Pro 14 (2024)");
    assert.equal(r.body.assets[0].provider_label, "Snipe-IT");
    assert.match((await lines(t.id)).at(-1)!.body, /^Linked asset MacBook Pro 14 \(2024\) \(.*-REQ1\) from Snipe-IT\.$/);
    assert.equal((await lines(t.id)).at(-1)!.kind, "internal");
    const audit = (await auditRows("helpdesk.asset.linked")).at(-1);
    assert.equal(audit.actor_id, P.agent.id);
    assert.equal(audit.details.tag, `${TAGP}-REQ1`);
    const again = await call(ticketAssetsRoute.POST, req(`/tickets/${t.number}/assets`, P.agent.session, { asset_id: id }), { number: String(t.number) });
    assert.equal(again.status, 409);
    const outsider = await call(ticketAssetsRoute.POST, req(`/tickets/${t.number}/assets`, P.other.session, { asset_id: id }), { number: String(t.number) });
    assert.equal(outsider.status, 404);
    const requester = await call(ticketAssetsRoute.GET, req(`/tickets/${t.number}/assets`, P.req.session), { number: String(t.number) });
    assert.equal(requester.status, 403);
    const mon = (await cacheId(MONITOR))!;
    await call(ticketAssetsRoute.POST, req(`/tickets/${t.number}/assets`, P.agent.session, { asset_id: mon }), { number: String(t.number) });
    const un = await call(ticketAssetRoute.DELETE, req(`/tickets/${t.number}/assets/${mon}`, P.agent.session, undefined, "DELETE"), { number: String(t.number), assetId: String(mon) });
    assert.equal(un.status, 200);
    assert.deepEqual(un.body.assets.map((a: any) => a.id), [id]);
    assert.equal((await auditRows("helpdesk.asset.unlinked")).length, 1);
    const none = await call(ticketAssetRoute.DELETE, req(`/tickets/${t.number}/assets/${mon}`, P.agent.session, undefined, "DELETE"), { number: String(t.number), assetId: String(mon) });
    assert.equal(none.status, 404);
  });

  test("ten at most; a closed ticket is read-only", async () => {
    const t3 = await ticket("Many");
    for (let i = 10; i < 20; i++) await assets.linkAsset({ id: P.agent.id, role: "viewer" } as never, (await ticketOf(t3.id))!, (await cacheId(i))!, { id: P.agent.id, name: "A" });
    await assert.rejects(assets.linkAsset({ id: P.agent.id, role: "viewer" } as never, (await ticketOf(t3.id))!, (await cacheId(30))!, { id: P.agent.id, name: "A" }), /up to 10/);
    const closed = await ticket("Closed", "req", "A", "closed");
    const r = await call(ticketAssetsRoute.POST, req(`/tickets/${closed.number}/assets`, P.agent.session, { asset_id: (await cacheId(31))! }), { number: String(closed.number) });
    assert.equal(r.status, 409);
  });

  test("earlier tickets: counted per asset, by when the tickets were opened", async () => {
    const id = (await cacheId(REQ_ASSET))!;
    const old = await ticket("Battery drains overnight");
    await pool().query("UPDATE hd_tickets SET created_at = now() - interval '60 days' WHERE id = $1", [old.id]);
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2)", [old.id, id]);
    const v = await call(ticketAssetsRoute.GET, req(`/tickets/${t.number}/assets`, P.agent.session), { number: String(t.number) });
    assert.equal(v.body.assets[0].earlier_tickets, 1);
    const oldView = await assets.ticketAssetsView((await ticketOf(old.id))!);
    assert.equal(oldView.assets[0].earlier_tickets, 0, "the newer ticket is not earlier");
  });

  test("with search-all off: search finds only the agent's people's assets; the requester's own can still be linked", async () => {
    await assets.syncProvider(PROVIDER, { force: true });
    assets.setAssetSettingsForTests(SETTINGS({}, false));
    try {
      const tb = await ticket("Team B ticket", "req2", "B");
      const s = await call(optionsRoute.GET, req(`/tickets/${tb.number}/assets/options?q=${TAGP}`, P.other.session), { number: String(tb.number) });
      assert.deepEqual(s.body.results.map((a: any) => a.tag).sort(), [], "nothing beyond their people's (req2's is in Assigned)");
      assert.deepEqual(s.body.assigned.map((a: any) => a.name), ["ThinkPad X1"]);
      const mon = (await cacheId(MONITOR))!;
      const refused = await call(ticketAssetsRoute.POST, req(`/tickets/${tb.number}/assets`, P.other.session, { asset_id: mon }), { number: String(tb.number) });
      assert.equal(refused.status, 404);
      const page = await call(assetRoute.GET, req(`/assets/${mon}`, P.other.session), { id: String(mon) });
      assert.equal(page.status, 404, "the page too");
      const reqAsset = (await cacheId(REQ_ASSET))!;
      assert.equal((await call(assetRoute.GET, req(`/assets/${reqAsset}`, P.other.session), { id: String(reqAsset) })).status, 404, "another team's requester's asset");
      assert.equal((await call(assetRoute.GET, req(`/assets/${reqAsset}`, P.agent.session), { id: String(reqAsset) })).status, 200, "their own people's");
      const search = await call(searchRoute.GET, req(`/assets?q=${TAGP}-MON`, P.agent.session));
      assert.deepEqual(search.body.assets, []);
    } finally {
      assets.setAssetSettingsForTests(SETTINGS());
    }
  });
});

async function ticketOf(id: number) {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  return (require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets")).getTicketById(id);
}

// --- The asset page --------------------------------------------------------------------------------

describe("the asset page", () => {
  test("visible tickets listed, the rest counted; maintenance from the source; refreshed live", async () => {
    const id = (await cacheId(REQ_ASSET))!;
    const tb = await ticket("Someone else's team", "req", "B");
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [tb.id, id]);
    await pool().query("INSERT INTO hd_time_entries (ticket_id, user_id, minutes) SELECT ticket_id, $2, 43 FROM hd_ticket_assets WHERE asset_id = $1 LIMIT 1", [id, P.agent.id]);
    const mine = await ticket("Battery drains overnight");
    const anon = await ticket("Anonymised one");
    await pool().query("UPDATE hd_tickets SET anonymised_at = now() WHERE id = $1", [anon.id]);
    fake.maintenances.push({ id: 1, asset: { id: REQ_ASSET }, title: `CompassDocs #${mine.number}: Repair`, asset_maintenance_type: "Repair", supplier: { id: 3, name: "Apple Store &amp; Repairs" }, start_date: { date: "2026-09-15" }, completion_date: { date: "2026-09-15" }, notes: "Battery replaced." });
    fake.maintenances.push({ id: 2, asset: { id: 1 }, title: "another asset's", asset_maintenance_type: "Repair", start_date: { date: "2026-09-01" } });
    // Records naming a ticket the viewer can't open (an old build put the subject in the title), or an anonymised one.
    fake.maintenances.push({ id: 3, asset: { id: REQ_ASSET }, title: `#${tb.number} Disciplinary investigation, laptop seized`, asset_maintenance_type: "Repair", start_date: { date: "2026-08-01" }, notes: "" });
    fake.maintenances.push({ id: 4, asset: { id: REQ_ASSET }, title: "CompassDocs maintenance", asset_maintenance_type: "Upgrade", start_date: { date: "2026-07-01" }, notes: `From #${anon.number}, and see #${mine.number}` });
    // Snipe-IT's own record, naming no ticket.
    fake.maintenances.push({ id: 5, asset: { id: REQ_ASSET }, title: "Annual PAT test", asset_maintenance_type: "PAT test", start_date: { date: "2026-06-01" }, notes: "" });
    const renamed = fake.hardware.find((h) => h.id === REQ_ASSET)!;
    renamed.location = { id: 9, name: "Home office" };
    const r = await call(assetRoute.GET, req(`/assets/${id}`, P.agent.session), { id: String(id) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.asset.location, "Home office", "refreshed from the source");
    assert.ok(r.body.tickets.length >= 2);
    assert.ok(!r.body.tickets.some((x: any) => x.number === tb.number), "team B's ticket is not named");
    assert.equal(r.body.hidden_tickets, 1);
    assert.ok(r.body.tickets.some((x: any) => x.minutes === 43));
    assert.deepEqual(r.body.maintenance.map((m: any) => [m.type, m.title, m.supplier]), [
      ["PAT test", "Annual PAT test", ""],
      ["Repair", `CompassDocs #${mine.number}: Repair`, "Apple Store & Repairs"],
    ]);
    assert.equal(r.body.hidden_maintenance, 2, "counted, never shown");
    assert.ok(!r.text.includes("Disciplinary") && !r.text.includes(`#${anon.number}`), "neither title nor notes reach the browser");
    assert.equal(r.body.notice, null);
    const lead = await call(assetRoute.GET, req(`/assets/${id}`, P.admin.session), { id: String(id) });
    assert.equal(lead.body.hidden_maintenance, 1, "a desk admin opens team B's ticket; the anonymised one stays hidden");
    fake.fail.set(`/api/v1/hardware/${REQ_ASSET}`, { status: 503, times: 1 });
    fake.fail.set("/api/v1/maintenances", { status: 503, times: 1 });
    const down = await call(assetRoute.GET, req(`/assets/${id}`, P.agent.session), { id: String(id) });
    assert.equal(down.status, 200);
    assert.match(down.body.notice, /Showing what was synced last: Snipe-IT had a problem \(error 503\)/);
    assert.equal(down.body.maintenance, null);
    assert.equal(down.body.asset.location, "Home office", "the cached details");
  });
});

// --- Solving with a maintenance record ---------------------------------------------------------------

describe("solve with a maintenance record", () => {
  let t: { id: number; number: number };
  before(async () => {
    t = await ticket("Keyboard keys sticking");
    await assets.linkAsset({ id: P.agent.id, role: "viewer" } as never, (await ticketOf(t.id))!, (await cacheId(REQ_ASSET))!, { id: P.agent.id, name: P.agent.name });
  });

  test("the offer: only with the setting on and a linked asset; with Snipe-IT's types and suppliers", async () => {
    assets.setAssetSettingsForTests(SETTINGS({ on_solve: "nothing" }));
    const off = await call(solveRoute.GET, req(`/tickets/${t.number}/assets/solve`, P.agent.session), { number: String(t.number) });
    assert.equal(off.body.offer, null);
    assets.setAssetSettingsForTests(SETTINGS());
    const on = await call(solveRoute.GET, req(`/tickets/${t.number}/assets/solve`, P.agent.session), { number: String(t.number) });
    assert.equal(on.body.offer.provider_label, "Snipe-IT");
    assert.deepEqual(on.body.offer.assets.map((a: any) => a.name), ["MacBook Pro 14 (2024)"]);
    assert.equal(on.body.offer.note, `CompassDocs #${t.number}.`);
    assert.ok(on.body.offer.types.some((x: any) => x.value === "Software Support"));
    assert.deepEqual(on.body.offer.suppliers.map((s: any) => s.name), ["Apple Store & Repairs", "CDW"]);
    const bare = await ticket("Nothing linked");
    assert.equal((await call(solveRoute.GET, req(`/tickets/${bare.number}/assets/solve`, P.agent.session), { number: String(bare.number) })).body.offer, null);
  });

  test("posted only once solved; the record carries the type, supplier, #N title and note; timeline, audit, never twice", async () => {
    const assetId = (await cacheId(REQ_ASSET))!;
    const body = { asset_ids: [assetId], type: "Software Support", supplier_id: 3, note: "Re-paired the VPN client after a phone change." };
    const early = await call(solveRoute.POST, req(`/tickets/${t.number}/assets/solve`, P.agent.session, body), { number: String(t.number) });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /Solve the ticket first/);
    const solved = await call(ticketRoute.PATCH, req(`/tickets/${t.number}`, P.agent.session, { status: "solved" }, "PATCH"), { number: String(t.number) });
    assert.equal(solved.status, 200, solved.text);
    const before = fake.maintenances.length;
    const r = await call(solveRoute.POST, req(`/tickets/${t.number}/assets/solve`, P.agent.session, body), { number: String(t.number) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.logged.length, 1);
    assert.deepEqual(r.body.failed, []);
    const rec = fake.seen.filter((s) => s.method === "POST" && s.path === "/api/v1/maintenances").at(-1)!.body!;
    assert.deepEqual(
      { ...rec, start_date: "d", completion_date: "d" },
      {
        asset_id: REQ_ASSET,
        asset_maintenance_type: "Software Support",
        title: `CompassDocs #${t.number}: Software support`,
        start_date: "d",
        completion_date: "d",
        notes: `Re-paired the VPN client after a phone change. CompassDocs #${t.number}.`,
        is_warranty: 0,
        supplier_id: 3,
      }
    );
    assert.match(rec.start_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!JSON.stringify(rec).includes("Keyboard keys sticking"), "the subject never goes to Snipe-IT");
    const claim = (await pool().query("SELECT record_id, claimed_by FROM hd_asset_maintenance_log WHERE ticket_id = $1", [t.id])).rows;
    assert.deepEqual(claim, [{ record_id: String(r.body.logged[0].record_id), claimed_by: P.agent.id }]);
    assert.match((await lines(t.id)).at(-1)!.body, /^Logged a software support maintenance record in Snipe-IT for MacBook Pro 14/);
    assert.equal((await auditRows("helpdesk.asset.maintenance_logged")).at(-1).details.type, "Software Support");
    const twice = await call(solveRoute.POST, req(`/tickets/${t.number}/assets/solve`, P.agent.session, body), { number: String(t.number) });
    assert.equal(twice.status, 200);
    assert.deepEqual(twice.body.skipped.map((x: any) => x.asset_id), [assetId]);
    assert.equal(fake.maintenances.length, before + 1, "a second request logs nothing");
  });

  test("tied to the solve: two requests at once post once; another agent, or a solve over 15 minutes old, is refused", async () => {
    const t3 = await ticket("Fan noise");
    const assetId = (await cacheId(60))!;
    await assets.linkAsset({ id: P.agent.id, role: "viewer" } as never, (await ticketOf(t3.id))!, assetId, { id: P.agent.id, name: P.agent.name });
    const body = { asset_ids: [assetId], type: "Repair", supplier_id: null, note: "Fan replaced." };
    const post = (who: string) => call(solveRoute.POST, req(`/tickets/${t3.number}/assets/solve`, P[who].session, body), { number: String(t3.number) });
    assert.equal((await call(ticketRoute.PATCH, req(`/tickets/${t3.number}`, P.agent.session, { status: "solved" }, "PATCH"), { number: String(t3.number) })).status, 200);
    const other = await post("admin");
    assert.equal(other.status, 409, "the agent who solved it sends it");
    assert.match(other.body.error, /from the solve dialog/);
    const before = fake.maintenances.length;
    const [a, b] = await Promise.all([post("agent"), post("agent")]);
    assert.equal(a.body.logged.length + b.body.logged.length, 1);
    assert.equal(a.body.skipped.length + b.body.skipped.length, 1);
    assert.equal(fake.maintenances.length, before + 1, "posted once");
    // Reopened and solved again: a new solve may log its own record; an old one can't.
    const t4 = await ticket("Old solve");
    await assets.linkAsset({ id: P.agent.id, role: "viewer" } as never, (await ticketOf(t4.id))!, assetId, { id: P.agent.id, name: P.agent.name });
    await call(ticketRoute.PATCH, req(`/tickets/${t4.number}`, P.agent.session, { status: "solved" }, "PATCH"), { number: String(t4.number) });
    await pool().query("UPDATE hd_tickets SET solved_at = solved_at - interval '20 minutes' WHERE id = $1", [t4.id]);
    await pool().query("UPDATE hd_messages SET created_at = created_at - interval '20 minutes' WHERE ticket_id = $1", [t4.id]);
    const late = await call(solveRoute.POST, req(`/tickets/${t4.number}/assets/solve`, P.agent.session, body), { number: String(t4.number) });
    assert.equal(late.status, 409);
    assert.equal(fake.maintenances.length, before + 1);
  });

  test("a refusal from Snipe-IT: an internal note says why, the ticket stays solved, audited", async () => {
    const t2 = await ticket("Battery swollen");
    await assets.linkAsset({ id: P.agent.id, role: "viewer" } as never, (await ticketOf(t2.id))!, (await cacheId(MONITOR))!, { id: P.agent.id, name: P.agent.name });
    assert.equal((await call(ticketRoute.PATCH, req(`/tickets/${t2.number}`, P.agent.session, { status: "solved" }, "PATCH"), { number: String(t2.number) })).status, 200);
    fake.rejectMaintenance = "The supplier id field is required.";
    try {
      const r = await call(solveRoute.POST, req(`/tickets/${t2.number}/assets/solve`, P.agent.session, { asset_ids: [(await cacheId(MONITOR))!], type: "Repair", supplier_id: null, note: "" }), {
        number: String(t2.number),
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.failed.length, 1);
      assert.match(r.body.failed[0].error, /didn't save the maintenance record\. It said: The supplier id field is required\./);
    } finally {
      fake.rejectMaintenance = null;
    }
    const note = (await lines(t2.id)).at(-1)!;
    assert.equal(note.kind, "internal");
    assert.match(note.body, /^Couldn't log the maintenance record in Snipe-IT for .*supplier id field is required.*The ticket is solved all the same/);
    assert.equal((await pool().query("SELECT status FROM hd_tickets WHERE id = $1", [t2.id])).rows[0].status, "solved");
    assert.equal((await auditRows("helpdesk.asset.maintenance_failed")).length, 1);
    assert.equal((await pool().query("SELECT 1 FROM hd_asset_maintenance_log WHERE ticket_id = $1", [t2.id])).rowCount, 0, "the claim is released");
    const retry = await call(solveRoute.POST, req(`/tickets/${t2.number}/assets/solve`, P.agent.session, { asset_ids: [(await cacheId(MONITOR))!], type: "Repair", supplier_id: 4, note: "" }), {
      number: String(t2.number),
    });
    assert.equal(retry.body.logged.length, 1, "so a retry from the dialog can still log it");
  });

  test("checks: an unknown type is refused; so is an asset not on the ticket", async () => {
    const bad = await call(solveRoute.POST, req(`/tickets/${t.number}/assets/solve`, P.agent.session, { asset_ids: [1], type: "Polish", note: "" }), { number: String(t.number) });
    assert.equal(bad.status, 400);
    const notOn = await call(solveRoute.POST, req(`/tickets/${t.number}/assets/solve`, P.agent.session, { asset_ids: [(await cacheId(40))!], type: "Repair", note: "" }), { number: String(t.number) });
    assert.equal(notOn.status, 409);
  });
});

// --- Settings ----------------------------------------------------------------------------------------

describe("Desk settings → Assets", () => {
  test("settings.manage only; the key is never returned, sealed at rest; a new address needs it again; audited; disconnect", async () => {
    assert.equal((await call(adminRoute.GET, req("/admin/assets", P.agent.session))).status, 403);
    const lock = await pool().connect();
    await lock.query("SELECT pg_advisory_lock(hashtext('helpdesk_assets_settings_test'))");
    const saved = (await pool().query("SELECT key, value FROM settings WHERE key = ANY($1)", [["helpdesk_assets"]])).rows;
    // Start from nothing saved, so no earlier address counts as this cache's source.
    await pool().query("DELETE FROM settings WHERE key = 'helpdesk_assets'");
    assets.setAssetSettingsForTests(null);
    try {
      const put = await call(adminRoute.PUT, req("/admin/assets", P.admin.session, { url: "https://snipe.test/", api_key: KEY, on_solve: "offer_maintenance", agents_search_all: false }, "PUT"));
      assert.equal(put.status, 200, put.text);
      assert.equal(put.body.snipeit.url, "https://snipe.test");
      assert.equal(put.body.snipeit.key_set, true);
      assert.ok(!put.text.includes(KEY));
      const raw = (await pool().query("SELECT value FROM settings WHERE key = 'helpdesk_assets'")).rows[0].value as string;
      assert.ok(!raw.includes(KEY) && raw.includes("enc:v1:"), "sealed");
      const get = await call(adminRoute.GET, req("/admin/assets", P.admin.session));
      assert.ok(!get.text.includes(KEY));
      assert.equal(get.body.agents_search_all, false);
      const moved = await call(adminRoute.PUT, req("/admin/assets", P.admin.session, { url: "https://other.example.com" }, "PUT"));
      assert.equal(moved.status, 400);
      assert.match(moved.body.error, /Paste the API key again/);
      const blankKey = await call(adminRoute.PUT, req("/admin/assets", P.admin.session, { url: "https://other.example.com", api_key: "" }, "PUT"));
      assert.equal(blankKey.status, 400, "an empty key is no key");
      const httpUrl = await call(adminRoute.PUT, req("/admin/assets", P.admin.session, { url: "http://snipe.test" }, "PUT"));
      assert.equal(httpUrl.status, 400);
      const audits = await auditRows("helpdesk.assets.settings_changed");
      assert.deepEqual(audits.at(-1).details.changed, ["url", "api_key", "on_solve", "agents_search_all"]);
      assert.ok(!JSON.stringify(audits).includes(KEY));
      // Test connection: the saved key, its own address; never to a new one.
      const ok = await call(adminTestRoute.POST, req("/admin/assets/test", P.admin.session, {}));
      assert.deepEqual(ok.body, { ok: true, total: fake.hardware.length });
      const seenBefore = fake.seen.length;
      const elsewhere = await call(adminTestRoute.POST, req("/admin/assets/test", P.admin.session, { url: "https://evil.example.com" }));
      assert.equal(elsewhere.body.ok, false);
      assert.match(elsewhere.body.error, /only ever sent to the address it was saved for/);
      assert.equal(fake.seen.length, seenBefore);
      const wrong = await call(adminTestRoute.POST, req("/admin/assets/test", P.admin.session, { api_key: "wrong" }));
      assert.match(wrong.body.error, /refused the API key \(401\)/);
      const off = await call(adminRoute.PUT, req("/admin/assets", P.admin.session, { disconnect: true }, "PUT"));
      assert.equal(off.body.snipeit.key_set, false);
      assert.equal(off.body.snipeit.url, "");
      assert.equal((await auditRows("helpdesk.assets.disconnected")).length, 1);
      const sync = await call(adminSyncRoute.POST, req("/admin/assets/sync", P.admin.session, {}));
      assert.equal(sync.status, 409, "nothing to sync");
    } finally {
      await pool().query("DELETE FROM settings WHERE key = 'helpdesk_assets'");
      for (const r of saved) await pool().query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [r.key, r.value]);
      assets.setAssetSettingsForTests(SETTINGS());
      await lock.query("SELECT pg_advisory_unlock(hashtext('helpdesk_assets_settings_test'))");
      lock.release();
    }
  });

  test("Sync now: audited, answers with the result", async () => {
    const r = await call(adminSyncRoute.POST, req("/admin/assets/sync", P.admin.session, {}));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.running, false);
    assert.ok(r.body.seen > 1000);
    assert.ok(!r.text.includes(KEY));
    assert.equal((await auditRows("helpdesk.assets.synced")).at(-1).details.ok, true);
  });
});

// --- Privacy, merge, requesters, the connector ----------------------------------------------------------

describe("privacy and the rest of the helpdesk", () => {
  test("merge moves the links; anonymising drops them; the export lists tag and name for their own requests", async () => {
    const keep = await ticket("Keep");
    const dup = await ticket("Dup");
    const a1 = (await cacheId(REQ_ASSET))!;
    const a2 = (await cacheId(50))!;
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2), ($3, $2), ($3, $4)", [keep.id, a1, dup.id, a2]);
    await merge.mergeTickets({ id: P.agent.id, role: "viewer" as never, name: P.agent.name }, { keep: keep.number, merge: [dup.number], notify: false });
    const kept = (await pool().query("SELECT asset_id FROM hd_ticket_assets WHERE ticket_id = $1 ORDER BY asset_id", [keep.id])).rows.map((r) => r.asset_id);
    assert.deepEqual(kept, [a1, a2].sort((x, y) => x - y));
    assert.equal((await pool().query("SELECT 1 FROM hd_ticket_assets WHERE ticket_id = $1", [dup.id])).rowCount, 0);

    const exp = await retention.personalHelpdeskExport(P.req.id);
    if (exp.included) {
      const mine = exp.requests.find((r) => r.number === keep.number)!;
      assert.deepEqual(
        [...mine.assets!].sort((x, y) => x.tag.localeCompare(y.tag)),
        [
          { tag: `${TAGP}-00050`, name: "Laptop 50" },
          { tag: `${TAGP}-REQ1`, name: "MacBook Pro 14 (2024)" },
        ]
      );
      assert.deepEqual(Object.keys(mine.assets![0]).sort(), ["name", "tag"]);
    }
    const other = await retention.personalHelpdeskExport(P.req2.id);
    assert.ok(!JSON.stringify(other).includes(`${TAGP}-REQ1`), "nobody else's");

    await pool().query("UPDATE hd_tickets SET status = 'closed' WHERE id = $1", [keep.id]);
    await withTx((c) => retention.anonymiseTicketTx(c, keep.id));
    assert.equal((await pool().query("SELECT 1 FROM hd_ticket_assets WHERE ticket_id = $1", [keep.id])).rowCount, 0);
    assert.ok(await assets.getAsset(a1), "the asset itself stays in the cache");
  });

  test("Get help: the Device picker lists only their own; a request takes their own device and refuses anyone else's", async () => {
    const mine = await call(mineRoute.GET, req("/assets/mine", P.req.session));
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.assets.map((a: any) => a.tag), [`${TAGP}-REQ1`]);
    assert.deepEqual(Object.keys(mine.body.assets[0]).sort(), ["category", "id", "model", "name", "tag"]);
    const other = (await cacheId(REQ2_ASSET)) ?? (await cacheId(MONITOR))!;
    const refused = await call(requestsRoute.POST, req("/requests", P.req.session, { subject: `Not mine ${STAMP}`, body: "x", asset_id: other }));
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /your own devices/);
    const own = (await cacheId(REQ_ASSET))!;
    const ok = await call(requestsRoute.POST, req("/requests", P.req.session, { subject: `VPN fails ${STAMP}`, body: "Since this morning.", asset_id: own }));
    assert.equal(ok.status, 201, ok.text);
    const row = (await pool().query("SELECT id FROM hd_tickets WHERE number = $1", [ok.body.ticket.number])).rows[0];
    ticketIds.push(row.id);
    assert.equal((await pool().query("SELECT 1 FROM hd_ticket_assets WHERE ticket_id = $1 AND asset_id = $2", [row.id, own])).rowCount, 1);
    const said = await lines(row.id);
    assert.ok(said.some((l) => l.kind === "internal" && /picked their device MacBook Pro 14/.test(l.body)));
    assert.ok(!JSON.stringify(ok.body).includes(TAGP), "the requester's answer names no asset");
  });

  test("a self-set or shared address matches nobody: no Device picker, no asset_id, no requester group for agents", async () => {
    const own = (await cacheId(REQ_ASSET))!;
    const t = await ticket("Self-set address");
    await pool().query("UPDATE users SET email_self_set = 1 WHERE id = $1", [P.req.id]);
    try {
      const mine = await call(mineRoute.GET, req("/assets/mine", P.req.session));
      assert.deepEqual(mine.body.assets, [], "an address they typed themselves shows them nothing");
      const refused = await call(requestsRoute.POST, req("/requests", P.req.session, { subject: `Typed ${STAMP}`, body: "x", asset_id: own }));
      assert.equal(refused.status, 400);
      const o = await call(optionsRoute.GET, req(`/tickets/${t.number}/assets/options`, P.agent.session), { number: String(t.number) });
      assert.deepEqual(o.body.assigned, []);
      const v = await call(ticketAssetsRoute.GET, req(`/tickets/${t.number}/assets`, P.agent.session), { number: String(t.number) });
      assert.equal(v.body.requester, null);
      assets.setAssetSettingsForTests(SETTINGS({}, false));
      const page = await call(assetRoute.GET, req(`/assets/${own}`, P.agent.session), { id: String(own) });
      assets.setAssetSettingsForTests(SETTINGS());
      const linkedToAgentTicket = (await pool().query("SELECT 1 FROM hd_ticket_assets l JOIN hd_tickets t ON t.id = l.ticket_id WHERE l.asset_id = $1 AND t.team_id = $2", [own, T.A])).rowCount;
      if (!linkedToAgentTicket) assert.equal(page.status, 404, "not one of their people's by that address");
    } finally {
      await pool().query("UPDATE users SET email_self_set = 0 WHERE id = $1", [P.req.id]);
    }
    // Another account holding the same address: matches nobody either.
    const twin = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Twin', $2, 'viewer', 'active') RETURNING id`, [`${STAMP}-twin`, P.req.email.toUpperCase()]);
    userIds.push(twin.rows[0].id);
    try {
      assert.deepEqual((await call(mineRoute.GET, req("/assets/mine", P.req.session))).body.assets, []);
      assert.equal(await assets.isRequesterAsset({ id: P.req.id }, own), false);
    } finally {
      await pool().query("DELETE FROM users WHERE id = $1", [twin.rows[0].id]);
    }
    assert.equal(await assets.isRequesterAsset({ id: P.req.id }, own), true, "confirmed and unique again: theirs");
  });

  test("anonymising drops the device from the ticket's asset audit rows and its maintenance claims", async () => {
    const t = await ticket("To anonymise");
    const id = (await cacheId(70))!;
    assert.equal((await call(ticketAssetsRoute.POST, req(`/tickets/${t.number}/assets`, P.agent.session, { asset_id: id }), { number: String(t.number) })).status, 201);
    assert.equal((await call(ticketAssetRoute.DELETE, req(`/tickets/${t.number}/assets/${id}`, P.agent.session, undefined, "DELETE"), { number: String(t.number), assetId: String(id) })).status, 200);
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2)", [t.id, id]);
    await pool().query("UPDATE hd_tickets SET status = 'closed', solved_at = now() WHERE id = $1", [t.id]);
    await pool().query("INSERT INTO hd_asset_maintenance_log (ticket_id, asset_id, solved_at, record_id) SELECT id, $2, solved_at, '7' FROM hd_tickets WHERE id = $1", [t.id, id]);
    const rows = async () => (await pool().query("SELECT action, details FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = $1 AND action LIKE 'helpdesk.asset.%'", [String(t.id)])).rows;
    assert.ok((await rows()).every((r) => r.details.tag === `${TAGP}-00070`));
    await withTx((c) => retention.anonymiseTicketTx(c, t.id));
    const after = await rows();
    assert.equal(after.length, 2, "the actions stay");
    for (const r of after) for (const k of ["asset_id", "tag", "name"]) assert.ok(!(k in r.details), `${r.action} lost ${k}`);
    assert.ok(!JSON.stringify(after).includes(TAGP));
    assert.equal((await pool().query("SELECT 1 FROM hd_asset_maintenance_log WHERE ticket_id = $1", [t.id])).rowCount, 0);
  });

  test("the Claude connector: hd_read_ticket lists linked assets; hd_asset_lookup searches; requesters can't", async () => {
    const t = await ticket("Connector");
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2)", [t.id, (await cacheId(REQ_ASSET))!]);
    const user = (await getUserById(P.agent.id))!;
    const ctx = { origin: "http://localhost", ip: null };
    const read = await hdTools.callHelpdeskTool(user, "hd_read_ticket", { number: t.number }, ctx);
    assert.equal(read.isError, false, read.content[0].text);
    const out = JSON.parse(read.content[0].text);
    assert.equal(out.assets[0].tag, `${TAGP}-REQ1`);
    assert.equal(out.assets[0].status, "Deployed");
    assert.equal(out.assets[0].source, "Snipe-IT");
    const look = await hdTools.callHelpdeskTool(user, "hd_asset_lookup", { query: `${TAGP}-MON` }, ctx);
    assert.equal(look.isError, false, look.content[0].text);
    assert.equal(JSON.parse(look.content[0].text).assets[0].name, "Dell U2723QE monitor");
    const reqUser = (await getUserById(P.req.id))!;
    const asReq = await hdTools.callHelpdeskTool(reqUser, "hd_asset_lookup", { query: `${TAGP}-MON` }, ctx);
    assert.equal(asReq.isError, true);
    assert.ok(!hdTools.HELPDESK_TOOL_DEFS.find((d) => d.name === "hd_asset_lookup")!.write, "read only");
  });
});

// --- Merge and the ten-asset limit --------------------------------------------------------------------

describe("merge and the ten-asset limit", () => {
  const actor = () => ({ id: P.agent.id, role: "viewer" as never, name: P.agent.name });
  const linksOf = async (ticketId: number) =>
    (await pool().query("SELECT a.external_id FROM hd_ticket_assets l JOIN hd_assets a ON a.id = l.asset_id WHERE l.ticket_id = $1 ORDER BY l.linked_at, l.asset_id", [ticketId])).rows.map((r) => Number(r.external_id));
  /** Link source assets `ext` to the ticket, the first the oldest link (a minute apart, a day back). */
  async function linkAll(ticketId: number, ext: number[]) {
    for (const [i, e] of ext.entries()) {
      const id = await cacheId(e);
      assert.ok(id, `asset ${e} cached`);
      await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id, linked_at) VALUES ($1, $2, now() - interval '1 day' + make_interval(mins => $3))", [ticketId, id, i]);
    }
  }

  before(async () => {
    assets.setAssetSettingsForTests(SETTINGS());
    await assets.syncProvider(PROVIDER, { force: true });
  });

  test("merging 6 + 7 links: all 13 move to the kept ticket (the limit is for linking by hand); an 11th by hand is refused", async () => {
    const keep = await ticket("Keep six");
    const dup = await ticket("Dup seven");
    const keepExt = [300, 301, 302, 303, 304, 305];
    const dupExt = [306, 307, 308, 309, 310, 311, 312];
    await linkAll(keep.id, keepExt);
    await linkAll(dup.id, dupExt);
    const r = await merge.mergeTickets(actor(), { keep: keep.number, merge: [dup.number], notify: false });
    assert.equal(r.already, false);
    const kept = await linksOf(keep.id);
    assert.equal(kept.length, 13);
    assert.deepEqual([...kept].sort((a, b) => a - b), [...keepExt, ...dupExt]);
    assert.deepEqual(await linksOf(dup.id), [], "nothing stays on the merged ticket");
    assert.ok(!(await lines(keep.id)).some((l) => / stayed on #/.test(l.body)), "no note naming devices");
    // The card lists all 13; Link is for a connected source on an open ticket, the card disables it at ten.
    const v = await assets.ticketAssetsView((await ticketOf(keep.id))!);
    assert.equal(v.assets.length, 13);
    assert.equal(v.can_unlink, true);
    assert.equal(v.assets.length, shared.ASSET_LIMITS.perTicket + 3, "three past the limit");
    // Linking one more by hand is refused with the limit's sentence, and nothing is added.
    const err = await assets.linkAsset({ id: P.agent.id, role: "viewer" } as never, (await ticketOf(keep.id))!, (await cacheId(313))!, { id: P.agent.id, name: "A" }).catch((e) => e);
    assert.ok(err instanceof assets.AssetError);
    assert.equal(err.status, 409);
    assert.equal(err.message, "A ticket can have up to 10 assets.");
    assert.equal((await linksOf(keep.id)).length, 13);
    // Unlinking still works on a ticket over the limit, and it stays over ten until it drops below.
    const first = (await cacheId(300))!;
    assert.ok(await assets.unlinkAsset((await ticketOf(keep.id))!, first, { id: P.agent.id, name: "A" }));
    assert.equal((await linksOf(keep.id)).length, 12);
    await assert.rejects(assets.linkAsset({ id: P.agent.id, role: "viewer" } as never, (await ticketOf(keep.id))!, first, { id: P.agent.id, name: "A" }), /up to 10/);
  });

  test("a link already on both tickets is not duplicated", async () => {
    const keep = await ticket("Keep nine");
    const dup = await ticket("Dup with a shared one");
    await linkAll(keep.id, [320, 321, 322, 323, 324, 325, 326, 327, 328]);
    await linkAll(dup.id, [320, 329, 330]);
    await merge.mergeTickets(actor(), { keep: keep.number, merge: [dup.number], notify: false });
    const kept = await linksOf(keep.id);
    assert.deepEqual([...kept].sort((a, b) => a - b), [320, 321, 322, 323, 324, 325, 326, 327, 328, 329, 330]);
    assert.equal(new Set(kept).size, kept.length, "one link per asset");
    assert.deepEqual(await linksOf(dup.id), []);
  });

  test("moveAssetLinksTx on the merge's client moves every link and returns how many were added", async () => {
    const keep = await ticket("Over the limit");
    const dup = await ticket("Two more");
    await linkAll(keep.id, [340, 341, 342, 343, 344, 345, 346, 347, 348, 349, 350]);
    await linkAll(dup.id, [350, 351, 352]);
    const n = await withTx((c) => assets.moveAssetLinksTx(c, dup.id, keep.id));
    assert.equal(n, 2, "the shared one isn't added again");
    assert.equal((await linksOf(keep.id)).length, 13);
    assert.deepEqual(await linksOf(dup.id), []);
  });

  test("solving a merged ticket with 13 links: the offer lists all 13, a record for the first ten logs ten, eleven is refused", async () => {
    const keep = await ticket("Keep six, then solve");
    const dup = await ticket("Dup seven, then solve");
    const keepExt = [360, 361, 362, 363, 364, 365];
    const dupExt = [366, 367, 368, 369, 370, 371, 372];
    await linkAll(keep.id, keepExt);
    await linkAll(dup.id, dupExt);
    // The duplicate's links are the newer ones, so oldest first is the kept ticket's six, then the duplicate's.
    await pool().query("UPDATE hd_ticket_assets SET linked_at = linked_at + interval '1 hour' WHERE ticket_id = $1", [dup.id]);
    await merge.mergeTickets(actor(), { keep: keep.number, merge: [dup.number], notify: false });
    assert.deepEqual(await linksOf(keep.id), [...keepExt, ...dupExt]);
    const solved = await call(ticketRoute.PATCH, req(`/tickets/${keep.number}`, P.agent.session, { status: "solved" }, "PATCH"), { number: String(keep.number) });
    assert.equal(solved.status, 200, solved.text);

    // The offer: all 13, oldest link first (the dialog ticks the first ten).
    const extOf = new Map<number, number>();
    for (const e of [...keepExt, ...dupExt]) extOf.set((await cacheId(e))!, e);
    const offer = await assets.solveOffer((await ticketOf(keep.id))!);
    assert.ok(offer);
    assert.equal(offer.assets.length, 13);
    assert.deepEqual(offer.assets.map((a) => extOf.get(a.id)), [...keepExt, ...dupExt]);
    const viaRoute = await call(solveRoute.GET, req(`/tickets/${keep.number}/assets/solve`, P.agent.session), { number: String(keep.number) });
    assert.equal(viaRoute.body.offer.assets.length, 13);

    // Eleven distinct assets: refused before anything is sent or claimed.
    const ids = offer.assets.map((a) => a.id);
    const before = fake.maintenances.length;
    const eleven = await call(solveRoute.POST, req(`/tickets/${keep.number}/assets/solve`, P.agent.session, { asset_ids: ids.slice(0, 11), type: "Repair", supplier_id: null, note: "" }), {
      number: String(keep.number),
    });
    assert.equal(eleven.status, 400, eleven.text);
    assert.equal(eleven.body.error, "Choose up to 10 assets.");
    assert.equal(fake.maintenances.length, before);
    assert.equal((await pool().query("SELECT 1 FROM hd_asset_maintenance_log WHERE ticket_id = $1", [keep.id])).rowCount, 0);

    // The first ten, as the dialog sends them: all ten logged on the fake, one record each.
    const seenBefore = fake.seen.length;
    const ten = await call(solveRoute.POST, req(`/tickets/${keep.number}/assets/solve`, P.agent.session, { asset_ids: ids.slice(0, 10), type: "Repair", supplier_id: null, note: "Docking stations swapped." }), {
      number: String(keep.number),
    });
    assert.equal(ten.status, 200, ten.text);
    assert.deepEqual(ten.body.failed, []);
    assert.deepEqual(ten.body.skipped, []);
    assert.deepEqual(ten.body.logged.map((l: any) => l.asset_id), ids.slice(0, 10));
    assert.equal(fake.maintenances.length, before + 10);
    const posted = fake.seen.slice(seenBefore).filter((s) => s.method === "POST" && s.path === "/api/v1/maintenances");
    assert.deepEqual(
      posted.map((s) => s.body!.asset_id),
      [...keepExt, ...dupExt].slice(0, 10)
    );
    assert.ok(posted.every((s) => s.body!.title === `CompassDocs #${keep.number}: Repair`));
    assert.equal((await pool().query("SELECT 1 FROM hd_asset_maintenance_log WHERE ticket_id = $1", [keep.id])).rowCount, 10);
  });

  test("a maintenance record for more than ten assets: 'Choose up to 10 assets.'; none or a bad id keeps the old sentence", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    assert.deepEqual(assets.checkMaintenanceRequest({ asset_ids: ids(11), type: "Repair" }), { ok: false, error: "Choose up to 10 assets." });
    assert.deepEqual(assets.checkMaintenanceRequest({ asset_ids: [], type: "Repair" }), { ok: false, error: "Choose the assets to log it for." });
    assert.deepEqual(assets.checkMaintenanceRequest({ asset_ids: [1, "x"], type: "Repair" }), { ok: false, error: "Choose the assets to log it for." });
    assert.deepEqual(assets.checkMaintenanceRequest({ asset_ids: [...ids(10), 1], type: "Repair" }).ok, true, "ten, once duplicates are dropped");
  });
});

// --- Disconnected: the cache is history only ------------------------------------------------------------

describe("after Snipe-IT is disconnected", () => {
  let t: { id: number; number: number };
  let solved: { id: number; number: number };
  let linkedId = 0;
  let unlinkedId = 0;
  let wrongId = 0;
  const agent = () => ({ id: P.agent.id, role: "viewer" }) as never;

  before(async () => {
    // As stored after a first save: the cache remembers its address, so reconnecting it is no new source.
    assets.setAssetSettingsForTests({ ...SETTINGS(), cache_source: "https://snipe.test" });
    await assets.syncProvider(PROVIDER, { force: true });
    linkedId = (await cacheId(400))!;
    unlinkedId = (await cacheId(401))!;
    wrongId = (await cacheId(402))!;
    assert.ok(linkedId && unlinkedId && wrongId);
    t = await ticket("Disconnected later");
    await assets.linkAsset(agent(), (await ticketOf(t.id))!, linkedId, { id: P.agent.id, name: P.agent.name });
    // Linked by mistake; removed after the disconnect.
    await assets.linkAsset(agent(), (await ticketOf(t.id))!, wrongId, { id: P.agent.id, name: P.agent.name });
    // Solved while connected, so the maintenance record is due when Snipe-IT goes away.
    solved = await ticket("Solved just before the disconnect");
    await assets.linkAsset(agent(), (await ticketOf(solved.id))!, linkedId, { id: P.agent.id, name: P.agent.name });
    const s = await call(ticketRoute.PATCH, req(`/tickets/${solved.number}`, P.agent.session, { status: "solved" }, "PATCH"), { number: String(solved.number) });
    assert.equal(s.status, 200, s.text);
    const off = await assets.saveAssetSettings({ disconnect: true });
    assert.deepEqual(off.changed, ["disconnected"]);
    assert.equal(await assets.assetsConnected(), false);
    // 1.19.4 review: the unlinked rows can never be shown again, so they go; linked ones stay as history.
    assert.equal(await assets.getAsset(unlinkedId), undefined, "an unlinked row is deleted");
    assert.ok(await assets.getAsset(linkedId), "a linked row is kept");
    assert.equal((await pool().query("SELECT 1 FROM settings WHERE key = $1", [`helpdesk_assets_sync:${PROVIDER}`])).rowCount, 0, "and the sync record");
  });

  after(() => {
    assets.setAssetSettingsForTests(SETTINGS());
  });

  test("linkAsset refuses with 409 and says how to connect it; so does the route", async () => {
    const err = await assets.linkAsset(agent(), (await ticketOf(t.id))!, unlinkedId, { id: P.agent.id, name: P.agent.name }).catch((e) => e);
    assert.ok(err instanceof assets.AssetError);
    assert.equal(err.status, 409);
    assert.equal(err.message, "Snipe-IT isn't connected. An admin can connect it in Desk settings, Assets.");
    assert.equal(err.message, assets.NOT_CONNECTED);
    const r = await call(ticketAssetsRoute.POST, req(`/tickets/${t.number}/assets`, P.agent.session, { asset_id: unlinkedId }), { number: String(t.number) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, assets.NOT_CONNECTED);
    assert.deepEqual((await assets.linkedAssets(t.id)).map((a) => a.id).sort((a, b) => a - b), [linkedId, wrongId].sort((a, b) => a - b));
  });

  test("the ticket card keeps its history; no Link, but Unlink stays: a wrong link is removed, audited, while disconnected", async () => {
    const v = await assets.ticketAssetsView((await ticketOf(t.id))!);
    assert.equal(v.configured, true);
    assert.equal(v.can_edit, false, "no Link without a source");
    assert.equal(v.can_unlink, true, "Unlink needs no source");
    assert.equal(v.assets.length, 2);
    const before = (await auditRows("helpdesk.asset.unlinked")).filter((x) => x.details.asset_id === wrongId).length;
    const r = await call(ticketAssetRoute.DELETE, req(`/tickets/${t.number}/assets/${wrongId}`, P.agent.session, undefined, "DELETE"), { number: String(t.number), assetId: String(wrongId) });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.assets.map((a: any) => a.id), [linkedId]);
    assert.equal(r.body.can_unlink, true);
    assert.equal(r.body.can_edit, false);
    const rows = (await auditRows("helpdesk.asset.unlinked")).filter((x) => x.details.asset_id === wrongId);
    assert.equal(rows.length, before + 1, "the route audits it as before");
    assert.equal(rows.at(-1).actor_id, P.agent.id);
    assert.ok((await lines(t.id)).some((l) => l.kind === "internal" && /^Unlinked asset .*00402/.test(l.body)), "the timeline says who");
    assert.deepEqual((await assets.linkedAssets(t.id)).map((a) => a.id), [linkedId]);
    // Not linked any more: 404, as when connected.
    const again = await call(ticketAssetRoute.DELETE, req(`/tickets/${t.number}/assets/${wrongId}`, P.agent.session, undefined, "DELETE"), { number: String(t.number), assetId: String(wrongId) });
    assert.equal(again.status, 404);
  });

  test("the link picker offers nothing, with the notice", async () => {
    const o = await assets.assetOptions(agent(), (await ticketOf(t.id))!, `${TAGP}-00401`);
    assert.deepEqual(o.assigned, []);
    assert.deepEqual(o.results, []);
    assert.equal(o.connected, false, "the picker shows only the notice");
    assert.equal(o.notice, assets.NOT_CONNECTED);
    const r = await call(optionsRoute.GET, req(`/tickets/${t.number}/assets/options?q=${TAGP}-00401`, P.agent.session), { number: String(t.number) });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.assigned, r.body.results], [[], []]);
    assert.equal(r.body.connected, false);
  });

  test("search (the desk's and hd_asset_lookup) finds linked assets only, and says why", async () => {
    const linked = await assets.searchAssets(agent(), `${TAGP}-00400`);
    assert.deepEqual(linked.rows.map((x) => x.id), [linkedId]);
    assert.match(linked.notice!, /isn't connected, so only assets linked to tickets are listed/);
    assert.deepEqual((await assets.searchAssets(agent(), `${TAGP}-00401`)).rows, [], "an unlinked row of the stale cache");
    const r = await call(searchRoute.GET, req(`/assets?q=${TAGP}-0040`, P.agent.session));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.assets.map((x: any) => x.id), [linkedId]);
    const mcp = await assets.assetLookupForMcp(agent(), `${TAGP}-0040`);
    assert.deepEqual(mcp.assets.map((x: any) => x.id), [linkedId]);
    assert.ok(mcp.notice);
  });

  test("the asset page: a linked asset's history stays readable (with the notice); an unlinked one is not found", async () => {
    const page = await assets.assetPage(agent(), linkedId);
    assert.ok(page);
    assert.match(page.notice!, /isn't connected now, so this is what was synced last/);
    assert.ok(page.tickets.some((x) => x.number === t.number));
    assert.equal(await assets.assetPage(agent(), unlinkedId), undefined);
    assert.equal((await call(assetRoute.GET, req(`/assets/${unlinkedId}`, P.agent.session), { id: String(unlinkedId) })).status, 404);
    assert.equal((await call(assetRoute.GET, req(`/assets/${linkedId}`, P.agent.session), { id: String(linkedId) })).status, 200);
  });

  test("Get help: no Device picker; a stale form's device is dropped and the request still goes in", async () => {
    const own = (await cacheId(REQ_ASSET))!;
    assert.deepEqual(await assets.myAssets({ id: P.req.id }), []);
    assert.equal(await assets.isRequesterAsset({ id: P.req.id }, own), false);
    const ok = await call(requestsRoute.POST, req("/requests", P.req.session, { subject: `After the disconnect ${STAMP}`, body: "Laptop again.", asset_id: own }));
    assert.equal(ok.status, 201, ok.text);
    const row = (await pool().query("SELECT id FROM hd_tickets WHERE number = $1", [ok.body.ticket.number])).rows[0];
    ticketIds.push(row.id);
    assert.equal((await pool().query("SELECT 1 FROM hd_ticket_assets WHERE ticket_id = $1", [row.id])).rowCount, 0, "nothing linked");
    assert.equal(await assets.linkRequesterAsset(row.id, own, { id: P.req.id, name: P.req.name }), false);
    assert.equal((await pool().query("SELECT 1 FROM hd_ticket_assets WHERE ticket_id = $1", [row.id])).rowCount, 0);
    assert.equal((await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.asset.linked' AND target_id = $1", [String(row.id)])).rowCount, 0, "no link audited");
  });

  test("solving: no maintenance offer, and a record sent anyway is refused with the same sentence", async () => {
    assert.equal(await assets.solveOffer((await ticketOf(solved.id))!), null);
    const r = await call(solveRoute.POST, req(`/tickets/${solved.number}/assets/solve`, P.agent.session, { asset_ids: [linkedId], type: "Repair", note: "" }), { number: String(solved.number) });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.error, assets.NOT_CONNECTED);
  });

  test("reconnected to the same address (saveAssetSettings): nothing retired, the links keep their source, linking works", async () => {
    const on = await assets.saveAssetSettings({ url: "https://snipe.test", api_key: KEY });
    assert.equal(on.retired, 0);
    assert.ok(!on.changed.includes("source_changed"), on.changed.join());
    assert.ok(on.changed.includes("url") && on.changed.includes("api_key"));
    assert.equal(await assets.assetsConnected(), true);
    const row = (await pool().query("SELECT provider, gone_at FROM hd_assets WHERE id = $1", [linkedId])).rows[0];
    assert.equal(row.provider, PROVIDER);
    assert.equal(row.gone_at, null);
    const card = await assets.ticketAssetsView((await ticketOf(t.id))!);
    assert.equal(card.assets[0].gone, false);
    assert.equal(card.can_edit, true);
    const o = await assets.assetOptions(agent(), (await ticketOf(t.id))!, `${TAGP}-00401`);
    assert.equal(o.connected, true, "the picker's groups are back");
    // Its row went at the disconnect; the exact tag is looked up live again.
    const again = (await cacheId(401))!;
    assert.ok(again && again !== unlinkedId);
    assert.deepEqual(o.results.map((x) => x.id), [again]);
    const a = await assets.linkAsset(agent(), (await ticketOf(t.id))!, again, { id: P.agent.id, name: P.agent.name });
    assert.equal(a.id, again);
    assert.deepEqual((await assets.linkedAssets(t.id)).map((x) => x.id).sort((x, y) => x - y), [linkedId, again].sort((x, y) => x - y));
  });
});

// --- A new address is a new source (last: it retires this file's cache) --------------------------------

describe("changing the Snipe-IT address", () => {
  test("the old rows are retired: linked ones kept as gone under a retired key, the rest deleted; a sync never re-points a link", async () => {
    await assets.syncProvider(PROVIDER, { force: true });
    const t = await ticket("Old instance");
    const oldId = (await cacheId(5))!;
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2)", [t.id, oldId]);
    assets.setAssetSettingsForTests({ ...SETTINGS(), cache_source: "https://snipe.test" });
    const sameAgain = await assets.saveAssetSettings({ url: "https://snipe.test", api_key: KEY });
    assert.ok(!sameAgain.changed.includes("source_changed"), "the same address keeps its cache");
    const moved = await assets.saveAssetSettings({ url: "https://new-snipe.example.com", api_key: KEY });
    assert.ok(moved.changed.includes("source_changed"));
    assert.ok(moved.retired >= 1, "this file's linked rows, the old asset 5 among them");
    const row = (await pool().query("SELECT provider, gone_at FROM hd_assets WHERE id = $1", [oldId])).rows[0];
    assert.match(row.provider, new RegExp(`^${PROVIDER}:retired:\\d+$`));
    assert.ok(row.gone_at);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_assets WHERE provider = $1", [PROVIDER])).rows[0].n, 0, "unlinked rows deleted");
    assert.equal(await getSetting(SYNC_KEY), undefined, "the sync record starts again");
    const linked = await assets.ticketAssetsView((await ticketOf(t.id))!);
    assert.equal(linked.assets[0].gone, true);
    assert.equal(linked.assets[0].provider_label, "Snipe-IT");
    // The new instance has its own asset 5: a sync adds it as a new row; the ticket keeps the old device.
    assets.setAssetSettingsForTests({ ...SETTINGS(), cache_source: "https://snipe.test" });
    await assets.syncProvider(PROVIDER, { force: true });
    assert.notEqual(await cacheId(5), oldId);
    assert.deepEqual((await pool().query("SELECT asset_id FROM hd_ticket_assets WHERE ticket_id = $1", [t.id])).rows.map((r) => r.asset_id), [oldId]);
    await pool().query("DELETE FROM hd_ticket_assets WHERE ticket_id = $1", [t.id]);
    await pool().query("DELETE FROM hd_assets WHERE provider LIKE $1", [`${PROVIDER}:retired:%`]);
  });
});
