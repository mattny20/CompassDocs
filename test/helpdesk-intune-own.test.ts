// Helpdesk 1.20.2: Microsoft Intune with its own app registration
// (lib/helpdesk/assets), against the fake Microsoft identity platform and
// Graph (test/support/fake-intune):
//   - its own tenant, client ID and secret: checked, signed in with before
//     anything is saved, never returned, audited or logged;
//   - no dependency on the Microsoft 365 directory sync: it works while
//     directory sync is unlicensed and not set up;
//   - an install connected before 1.20.2 keeps signing in as the directory
//     sync's app, unchanged, until own credentials are entered; when that app
//     is gone the card says so;
//   - switching to own credentials in the same tenant keeps every device and
//     link; another tenant asks first, then retires the old devices;
//   - forgetting the credentials turns Intune off and never falls back;
//   - the stored secret is sealed (real settings row, under the assets
//     settings lock, restored after);
//   - 1.20.4, the core side of the one-click setup (the setup itself is the
//     enterprise overlay's): what it reads before it creates anything, the
//     save without a sign-in for an app Microsoft is still activating and
//     what that save refuses, and a 403 dropping the cached token.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-intune-own.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import { fakeDevice, fakeIntuneTransport, startFakeIntune, type FakeIntuneState } from "./support/fake-intune";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

// --- Stubs: the request scope, the licence, and the directory sync's settings ----------

let currentRequest: Request | null = null;
/** What the licence carries: the helpdesk always; directory sync only when a test says so. */
let directorySyncLicensed = false;
/** The directory sync's app registration as lib/directory-config would answer. */
let directoryConfig = { tenant: "", clientId: "", clientSecret: "" };
let directoryConfigReads = 0;

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-intune-own.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-intune-own.virtual.js");
const DIR_STUB = path.join(__dirname, "stubs", "directory-config.helpdesk-intune-own.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
const DIR_REAL = path.join(__dirname, "..", "src", "lib", "directory-config");
{
  const mk = (file: string, exports: unknown) => {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
  };
  mk(HEADERS_STUB, {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = new Map<string, string>();
      for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
      }
      return { get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined), getAll: () => [...jar].map(([name, value]) => ({ name, value })), has: (n: string) => jar.has(n) };
    },
    draftMode: async () => ({ isEnabled: false }),
  });
  const feature = async (f: string) => f === "helpdesk" || (f === "directory_sync" && directorySyncLicensed);
  mk(EE_STUB, { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: feature });
  mk(DIR_STUB, {
    getDirectoryGraphConfig: async () => {
      directoryConfigReads++;
      return directoryConfig;
    },
  });
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    const abs = parent?.filename && request.startsWith(".") ? path.resolve(path.dirname(parent.filename), request) : "";
    if (abs === EE_REAL) return EE_STUB;
    if (abs === DIR_REAL) return DIR_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const assets = require("../src/lib/helpdesk/assets") as typeof import("../src/lib/helpdesk/assets");
const httpMod = require("../src/lib/helpdesk/assets/http") as typeof import("../src/lib/helpdesk/assets/http");
const intune = require("../src/lib/helpdesk/assets/intune") as typeof import("../src/lib/helpdesk/assets/intune");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const auditLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const adminRoute = require("../src/app/api/helpdesk/admin/assets/route") as typeof import("../src/app/api/helpdesk/admin/assets/route");
const testRoute = require("../src/app/api/helpdesk/admin/assets/test/route") as typeof import("../src/app/api/helpdesk/admin/assets/test/route");
/* eslint-enable @typescript-eslint/no-require-imports */

type Settings = import("../src/lib/helpdesk/assets").AssetSettings;

const STAMP = `hdio${Date.now().toString(36)}${process.pid}`;
const INTUNE = `intune:${STAMP}`;
const TID = randomUUID();
const OTHER_TID = randomUUID();
const TENANT = `${STAMP}.onmicrosoft.com`;
const OTHER_TENANT = `other-${STAMP}.onmicrosoft.com`;
const OWN = { tenant: TENANT, client_id: randomUUID(), secret: `own-secret-${STAMP}-Zq8~very.long_value` };
/** The directory sync's app registration (same tenant, another client ID, the same fake's secret). */
const DIR = { tenant: TENANT, clientId: randomUUID(), clientSecret: OWN.secret };
let graph: FakeIntuneState;
const closers: (() => Promise<void>)[] = [];
const userIds: number[] = [];
const ticketIds: number[] = [];
let admin = { id: 0, session: "" };
let agent = { id: 0, session: "" };
let teamId = 0;
const logged: string[] = [];
const realLog = { log: console.log, warn: console.warn, error: console.error, info: console.info };

const BASE = (intuneOver: Settings["intune"] = { on: false, cache_source: "" }): Settings => ({
  snipeit: { url: "", token: "", on_solve: "nothing" },
  agents_search_all: true,
  cache_source: "",
  intune: intuneOver,
});

function req(pathname: string, session: string, body?: unknown, method = "GET"): Request {
  return new Request(`http://localhost/api/helpdesk${pathname}`, {
    method,
    headers: { "content-type": "application/json", cookie: `compass_session=${session}`, origin: "http://localhost", host: "localhost", "x-forwarded-for": "203.0.113.77" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(handler: unknown, r: Request): Promise<{ status: number; body: any; text: string }> {
  currentRequest = r;
  try {
    const res = await (handler as (q: Request) => Promise<Response>)(r);
    const text = await res.text();
    let body = null;
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
const put = (body: unknown, who = admin) => call(adminRoute.PUT, req("/admin/assets", who.session, body, "PUT"));
const view = async () => (await call(adminRoute.GET, req("/admin/assets", admin.session))).body;
const auditRows = async (action: string) => (await pool().query("SELECT details FROM audit_log WHERE action = $1 AND actor_id = ANY($2) ORDER BY id", [action, userIds])).rows.map((r) => r.details);
const rows = async () => (await pool().query("SELECT external_id, provider, gone_at FROM hd_assets WHERE provider LIKE $1 ORDER BY external_id", [`${INTUNE}%`])).rows;

async function person(key: string, role: string) {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${key}`, `${key} ${STAMP}`, `${STAMP}-${key}@example.test`]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2)", [id, role]);
  return { id, session };
}

/** Two cached Intune devices of TID: d-linked is on a ticket, d-loose is not. */
async function seedDevices() {
  await pool().query("DELETE FROM hd_assets WHERE provider LIKE $1", [`${INTUNE}%`]);
  const a = await pool().query("INSERT INTO hd_assets (provider, external_id, name, serial) VALUES ($1, 'd-linked', 'Linked MacBook', $2), ($1, 'd-loose', 'Loose iPhone', $3) RETURNING id, external_id", [INTUNE, `S1${STAMP}`, `S2${STAMP}`]);
  const t = await pool().query("INSERT INTO hd_tickets (subject, requester_name, requester_email, team_id, status, source) VALUES ($1, 'x', 'x@example.test', $2, 'open', 'portal') RETURNING id", [`${STAMP} device`, teamId]);
  ticketIds.push(t.rows[0].id);
  await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2)", [t.rows[0].id, a.rows.find((r) => r.external_id === "d-linked").id]);
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  const g = await startFakeIntune({ tenant: TENANT, clientId: OWN.client_id, secret: OWN.secret, tid: TID });
  graph = g.state;
  closers.push(g.close);
  graph.clientIds.add(DIR.clientId);
  graph.tenants.set(OTHER_TENANT.toLowerCase(), OTHER_TID).set(OTHER_TID, OTHER_TID);
  graph.devices.push(fakeDevice("d-1", { serialNumber: `S9${STAMP}` }));
  httpMod.setAssetTransportForTests(fakeIntuneTransport(g.port));
  assets.setIntuneCacheKeyForTests(INTUNE);
  assets.setIntuneCredentialsForTests(undefined); // the real path, always
  assets.setAssetSettingsForTests(BASE());
  teamId = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9410) RETURNING id", [`${STAMP} T`])).rows[0].id;
  admin = await person("admin", "admin");
  agent = await person("agent", "agent");
  // Everything written to the console while the tests run: the secret must never be in it.
  for (const k of ["log", "warn", "error", "info"] as const) {
    console[k] = (...a: unknown[]) => {
      logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    };
  }
});

after(async () => {
  Object.assign(console, realLog);
  assets.setAssetSettingsForTests(null);
  assets.setIntuneCacheKeyForTests(null);
  httpMod.setAssetTransportForTests(null);
  roles.setRoleMatrixForTests(null);
  for (const c of closers) await c();
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ticketIds]);
  await pool().query("DELETE FROM hd_assets WHERE provider LIKE $1", [`${INTUNE}%`]);
  await pool().query("DELETE FROM settings WHERE key LIKE $1", [`helpdesk_assets_sync:${INTUNE}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = $1", [teamId]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

describe("Intune's own app registration", () => {
  test("the shape of what is typed", () => {
    const ok = assets.checkIntuneCredentials({ tenant: ` ${TENANT} `, client_id: OWN.client_id.toUpperCase(), secret: " s3cret " });
    assert.deepEqual(ok, { ok: true, value: { tenant: TENANT, clientId: OWN.client_id.toUpperCase(), secret: "s3cret", mode: "own" } });
    assert.equal(assets.checkIntuneCredentials({ tenant: TID, client_id: OWN.client_id, secret: "x" }).ok, true, "a tenant ID works as well as a domain");
    const err = (raw: unknown, stored?: Settings["intune"]) => {
      const r = assets.checkIntuneCredentials(raw, stored);
      return r.ok ? "" : r.error;
    };
    assert.match(err({}), /Enter the tenant/);
    assert.match(err({ tenant: "not a tenant", client_id: OWN.client_id, secret: "x" }), /a GUID\) or a domain/);
    assert.match(err({ tenant: TENANT, client_id: "my-app", secret: "x" }), /application \(client\) ID is a GUID/);
    assert.match(err({ tenant: TENANT, client_id: OWN.client_id }), /Paste the client secret \(its Value/);
    // A saved secret stands in only for the app registration it was saved for.
    const stored = { on: true, tenant: TENANT, client_id: OWN.client_id, secret: "saved" };
    assert.equal((assets.checkIntuneCredentials({ tenant: TENANT.toUpperCase(), client_id: OWN.client_id }, stored) as { value: { secret: string } }).value.secret, "saved");
    assert.match(err({ tenant: TENANT, client_id: randomUUID() }, stored), /Paste the client secret again/);
    assert.match(err({ tenant: OTHER_TENANT, client_id: OWN.client_id }, stored), /Paste the client secret again/);
    assert.ok(auditLabels.hasActionLabel("helpdesk.assets.intune_credentials"));
  });

  test("not set up: no app registration, and directory sync (unlicensed here) is no part of it", async () => {
    assets.setAssetSettingsForTests(BASE());
    directoryConfigReads = 0;
    const v = await view();
    assert.deepEqual({ on: v.intune.on, mode: v.intune.mode, tenant: v.intune.tenant, client_id: v.intune.client_id, secret_set: v.intune.secret_set, unavailable: v.intune.unavailable }, { on: false, mode: null, tenant: "", client_id: "", secret_set: false, unavailable: "credentials" });
    const on = await put({ intune: true });
    assert.equal(on.status, 409);
    assert.match(on.body.error, /Enter the Intune app registration's tenant, application \(client\) ID and client secret first/);
    assert.ok(!/directory sync/i.test(on.body.error));
    // Even with directory sync licensed and set up, a desk that never connected Intune is not signed in through it.
    directorySyncLicensed = true;
    directoryConfig = DIR;
    assert.equal((await view()).intune.mode, null);
    assert.equal((await put({ intune: true })).status, 409);
    assert.equal(directoryConfigReads, 0, "the directory sync's settings were never read");
    directorySyncLicensed = false;
    directoryConfig = { tenant: "", clientId: "", clientSecret: "" };
  });

  test("permissions: settings.manage, as the Assets settings always were", async () => {
    assert.equal((await put({ intune_credentials: OWN }, agent)).status, 403);
    assert.equal((await call(testRoute.POST, req("/admin/assets/test", agent.session, { provider: "intune", ...OWN }, "POST"))).status, 403);
    assert.equal((await assets.getAssetSettings()).intune?.on, false);
  });

  test("Test and Connect: refusals in plain words, nothing saved; then connected, and the secret is nowhere", async () => {
    assets.setAssetSettingsForTests(BASE());
    intune.clearIntuneTokensForTests();
    const tryIt = (body: unknown) => call(testRoute.POST, req("/admin/assets/test", admin.session, { provider: "intune", ...(body as object) }, "POST"));
    // The shape first.
    assert.match((await tryIt({ tenant: TENANT, client_id: "nope", secret: "x" })).body.error, /is a GUID/);
    // A wrong secret: Microsoft's refusal, naming Intune's app registration and where to fix it.
    const wrong = await tryIt({ ...OWN, secret: `wrong-${OWN.secret}` });
    assert.equal(wrong.body.ok, false);
    assert.match(wrong.body.error, /refused the Intune app registration's sign-in \(invalid_client\)/);
    assert.match(wrong.body.error, /Desk settings, Integrations, Microsoft Intune/);
    assert.ok(!wrong.text.includes(OWN.secret));
    const save = await put({ intune_credentials: { ...OWN, secret: `wrong-${OWN.secret}` } });
    assert.equal(save.status, 409);
    assert.match(save.body.error, /refused the Intune app registration's sign-in/);
    // The permission is missing (Graph's 403): which permission, on which app.
    graph.forbid = true;
    const forbidden = await put({ intune_credentials: OWN });
    assert.equal(forbidden.status, 409);
    assert.match(forbidden.body.error, /give the Intune app registration the DeviceManagementManagedDevices\.Read\.All application permission and grant admin consent/);
    graph.forbid = false;
    let s = await assets.getAssetSettings();
    assert.deepEqual([s.intune?.on, s.intune?.tenant ?? "", s.intune?.secret ?? ""], [false, "", ""], "nothing was saved by a refusal");
    assert.equal((await auditRows("helpdesk.assets.intune_credentials")).length, 0);

    // The typed credentials test fine, then connect.
    const good = await tryIt(OWN);
    assert.deepEqual(good.body, { ok: true, total: 1, tenant: TID });
    const done = await put({ intune_credentials: OWN });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(
      { on: done.body.intune.on, mode: done.body.intune.mode, tenant: done.body.intune.tenant, client_id: done.body.intune.client_id, secret_set: done.body.intune.secret_set, unavailable: done.body.intune.unavailable },
      { on: true, mode: "own", tenant: TENANT, client_id: OWN.client_id, secret_set: true, unavailable: null }
    );
    s = await assets.getAssetSettings();
    assert.deepEqual([s.intune?.cache_source, s.intune?.secret], [TID, OWN.secret]);
    // It syncs, with directory sync still unlicensed and not set up.
    const sync = await assets.syncProvider(INTUNE, { force: true });
    assert.equal(sync.ok, true, JSON.stringify(sync));
    assert.deepEqual((await rows()).map((x) => x.external_id), ["d-1"]);
    assert.equal((await assets.testIntune()).ok, true);

    // The secret: in no response, no audit row, no log line.
    for (const r of [done, await call(adminRoute.GET, req("/admin/assets", admin.session)), good]) assert.ok(!r.text.includes(OWN.secret), "a response carried the secret");
    const audits = await pool().query("SELECT action, details::text AS d FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
    assert.ok(audits.rows.length > 0);
    for (const a of audits.rows) assert.ok(!a.d.includes(OWN.secret), `${a.action} carried the secret`);
    assert.deepEqual(await auditRows("helpdesk.assets.intune_credentials"), [{ changed: ["intune_credentials", "intune_on"], tenant: TENANT, client_id: OWN.client_id }]);
    assert.ok(!logged.join("\n").includes(OWN.secret), "a log line carried the secret");
    for (const q of graph.seen) assert.ok(!q.body.includes(OWN.secret) || q.host.includes("login."), "the secret only ever goes to the sign-in host");
  });

  test("Replace keeps the saved secret for the same app registration only; a new secret is tested first", async () => {
    const same = await put({ intune_credentials: { tenant: TENANT, client_id: OWN.client_id } });
    assert.equal(same.status, 200, same.text);
    assert.equal((await assets.getAssetSettings()).intune?.secret, OWN.secret);
    const other = await put({ intune_credentials: { tenant: TENANT, client_id: DIR.clientId } });
    assert.equal(other.status, 400);
    assert.match(other.body.error, /Paste the client secret again/);
    const bad = await put({ intune_credentials: { ...OWN, secret: "rotated-but-wrong" } });
    assert.equal(bad.status, 409);
    assert.equal((await assets.getAssetSettings()).intune?.secret, OWN.secret, "the working secret stays until a new one signs in");
  });

  test("forgetting the credentials turns Intune off and never falls back to the directory sync app", async () => {
    await seedDevices();
    directorySyncLicensed = true;
    directoryConfig = DIR;
    const r = await put({ intune_credentials: null });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ on: r.body.intune.on, mode: r.body.intune.mode, secret_set: r.body.intune.secret_set, tenant: r.body.intune.tenant }, { on: false, mode: null, secret_set: false, tenant: "" });
    assert.equal(await assets.intuneCredentials(), "credentials");
    assert.deepEqual((await rows()).map((x) => x.external_id), ["d-linked"], "a disconnect: linked devices stay as history, the rest go");
    assert.deepEqual((await auditRows("helpdesk.assets.intune_credentials")).at(-1), { changed: ["intune_credentials_cleared", "intune_off"], tenant: null, client_id: null });
    directorySyncLicensed = false;
    directoryConfig = { tenant: "", clientId: "", clientSecret: "" };
  });
});

describe("own mode with a saved secret that can't be read", () => {
  // The secret is stored sealed; a master key that changed (or a damaged value) opens as ''.
  const BROKEN = (over: Partial<NonNullable<Settings["intune"]>> = {}): Settings =>
    BASE({ on: true, cache_source: TID, cred_tag: assets.credTag({ tenant: OWN.tenant, clientId: OWN.client_id }), tenant: OWN.tenant, client_id: OWN.client_id, secret: "", ...over });

  test("it is 'enter the credentials', never the directory sync app, and the device list is left alone", async () => {
    await seedDevices();
    // Directory sync is licensed and set up for ANOTHER tenant, with credentials that open.
    directorySyncLicensed = true;
    directoryConfig = { tenant: OTHER_TENANT, clientId: DIR.clientId, clientSecret: DIR.clientSecret };
    assets.setIntuneCredentialsForTests(undefined);
    intune.clearIntuneTokensForTests();
    try {
      for (const [name, st] of [
        ["no secret", BROKEN()],
        ["only the tenant is left", BROKEN({ client_id: "" })],
        ["only the client ID is left", BROKEN({ tenant: "" })],
        ["switched off, no secret", BROKEN({ on: false })],
      ] as const) {
        assets.setAssetSettingsForTests(st);
        directoryConfigReads = 0;
        const seen = graph.seen.length;
        assert.equal(await assets.intuneCredentials(), "credentials", name);
        assert.equal(await assets.intuneSourceCheck(), null, `${name}: no source check`);
        const t = await assets.testIntune();
        assert.match((t as { error: string }).error, /Enter the Intune app registration's tenant, application \(client\) ID and client secret first/, name);
        const v = await view();
        assert.deepEqual({ mode: v.intune.mode, secret_set: v.intune.secret_set, unavailable: v.intune.unavailable }, { mode: null, secret_set: false, unavailable: "credentials" }, name);
        assert.equal(directoryConfigReads, 0, `${name}: the directory sync's settings were never read`);
        assert.equal(graph.seen.length, seen, `${name}: nothing signed in anywhere`);
        assert.deepEqual((await assets.getAssetSettings()).intune?.cache_source, TID, `${name}: the source is unchanged`);
      }
      assert.deepEqual((await rows()).map((x) => [x.external_id, x.gone_at]), [["d-linked", null], ["d-loose", null]], "no device was retired or removed");
      // Entering the secret again brings it back as its own app, in place.
      assets.setAssetSettingsForTests(BROKEN());
      const r = await put({ intune_credentials: OWN });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([r.body.intune.on, r.body.intune.mode, r.body.intune.unavailable], [true, "own", null]);
      assert.ok(!(await auditRows("helpdesk.assets.intune_credentials")).at(-1).changed.includes("intune_own_app"), "it was its own app already, not a move off directory sync");
      assert.deepEqual((await rows()).map((x) => [x.external_id, x.gone_at]), [["d-linked", null], ["d-loose", null]]);
    } finally {
      directorySyncLicensed = false;
      directoryConfig = { tenant: "", clientId: "", clientSecret: "" };
      assets.setIntuneCredentialsForTests(undefined);
      assets.setAssetSettingsForTests(BASE());
    }
  });
});

describe("an install connected before 1.20.2 (the directory sync's app)", () => {
  const LEGACY = (): Settings => BASE({ on: true, cache_source: TID, cred_tag: assets.credTag({ tenant: DIR.tenant, clientId: DIR.clientId }) });

  test("keeps working unchanged, and says which app it uses", async () => {
    assets.setAssetSettingsForTests(LEGACY());
    directorySyncLicensed = true;
    directoryConfig = DIR;
    assets.setIntuneCredentialsForTests(undefined);
    intune.clearIntuneTokensForTests();
    const c = await assets.intuneCredentials();
    assert.deepEqual(c, { tenant: DIR.tenant, clientId: DIR.clientId, secret: DIR.clientSecret, mode: "directory" });
    const v = await view();
    assert.deepEqual({ on: v.intune.on, mode: v.intune.mode, secret_set: v.intune.secret_set, unavailable: v.intune.unavailable, check_error: v.intune.check_error }, { on: true, mode: "directory", secret_set: false, unavailable: null, check_error: "" });
    assert.deepEqual(await assets.testIntune(), { ok: true, total: 1, tenant: TID, tag: assets.credTag({ tenant: DIR.tenant, clientId: DIR.clientId }) });
    const before = graph.seen.length;
    assert.equal((await assets.testIntune()).ok, true);
    assert.ok(graph.seen.slice(before).length >= 0);
    // Its errors still name the app it really uses.
    graph.forbid = true;
    const t = await assets.testIntune();
    graph.forbid = false;
    assert.match((t as { error: string }).error, /give the directory sync app the DeviceManagementManagedDevices\.Read\.All/);
  });

  test("directory sync goes away (unlicensed, or its credentials removed): Intune says so and asks for its own", async () => {
    assets.setAssetSettingsForTests(LEGACY());
    directorySyncLicensed = false;
    assets.setIntuneCredentialsForTests(undefined); // read the directory sync's settings afresh (cached for five seconds)
    assert.equal(await assets.intuneCredentials(), "legacy_gone");
    const v = await view();
    assert.deepEqual([v.intune.on, v.intune.mode, v.intune.unavailable], [true, null, "legacy_gone"]);
    const t = await assets.testIntune();
    assert.match((t as { error: string }).error, /was signing in with the Microsoft 365 directory sync app, which is no longer set up\. Enter the Intune app registration's/);
    // Its own credentials bring it back, directory sync or not.
    await seedDevices();
    const r = await put({ intune_credentials: OWN });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.intune.on, r.body.intune.mode, r.body.intune.unavailable], [true, "own", null]);
    assert.deepEqual((await rows()).map((x) => [x.external_id, x.provider, x.gone_at]), [["d-linked", INTUNE, null], ["d-loose", INTUNE, null]]);
  });

  test("switching to own credentials in the same tenant: same source, every device and link kept", async () => {
    assets.setAssetSettingsForTests(LEGACY());
    directorySyncLicensed = true;
    directoryConfig = DIR;
    assets.setIntuneCredentialsForTests(undefined);
    await seedDevices();
    const links = async () => (await pool().query("SELECT count(*)::int AS n FROM hd_ticket_assets WHERE ticket_id = ANY($1)", [ticketIds])).rows[0].n;
    const linked = await links();
    assert.equal((await view()).intune.mode, "directory");
    const r = await put({ intune_credentials: OWN });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.intune.mode, "own");
    assert.deepEqual((await rows()).map((x) => [x.external_id, x.provider, x.gone_at]), [["d-linked", INTUNE, null], ["d-loose", INTUNE, null]], "no re-import: the cached devices are the same rows");
    assert.equal(await links(), linked);
    const s = await assets.getAssetSettings();
    assert.deepEqual([s.intune?.cache_source, s.intune?.cred_tag], [TID, assets.credTag({ tenant: OWN.tenant, clientId: OWN.client_id })]);
    assert.deepEqual((await auditRows("helpdesk.assets.intune_credentials")).at(-1), { changed: ["intune_credentials", "intune_own_app"], tenant: TENANT, client_id: OWN.client_id });
    assert.equal((await auditRows("helpdesk.assets.intune_source_changed")).length, 0);
    // The directory sync app is out of the picture: break it and Intune does not notice.
    directoryConfig = { tenant: "gone.example", clientId: randomUUID(), clientSecret: "revoked" };
    directorySyncLicensed = false;
    assets.setIntuneCredentialsForTests(undefined);
    intune.clearIntuneTokensForTests();
    const seen = graph.seen.length;
    assert.equal((await assets.testIntune()).ok, true);
    assert.ok(graph.seen.slice(seen).every((q) => !q.body.includes(DIR.clientId)), "no sign-in as the directory sync app any more");
    assert.equal((await view()).intune.check_error, "");
  });

  test("own credentials for another tenant: asks first, then the old devices are retired by the source-change rules", async () => {
    assets.setAssetSettingsForTests(LEGACY());
    directorySyncLicensed = true;
    directoryConfig = DIR;
    assets.setIntuneCredentialsForTests(undefined);
    await seedDevices();
    const other = { tenant: OTHER_TENANT, client_id: OWN.client_id, secret: OWN.secret };
    const ask = await put({ intune_credentials: other });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.code, "tenant_change");
    assert.match(ask.body.error, /different Microsoft 365 tenant/);
    assert.deepEqual((await rows()).map((x) => [x.external_id, x.provider]), [["d-linked", INTUNE], ["d-loose", INTUNE]], "nothing changed before the answer");
    assert.equal((await assets.getAssetSettings()).intune?.cache_source, TID);
    const go = await put({ intune_credentials: other, confirm_tenant_change: true });
    assert.equal(go.status, 200, go.text);
    const after = await rows();
    assert.equal(after.length, 1, "the unlinked device is gone");
    assert.equal(after[0].external_id, "d-linked");
    assert.match(after[0].provider, new RegExp(`^${INTUNE}:retired:\\d+$`));
    assert.ok(after[0].gone_at, "kept on its ticket, marked as no longer in Intune");
    const s = await assets.getAssetSettings();
    assert.deepEqual([s.intune?.cache_source, s.intune?.tenant], [OTHER_TID, OTHER_TENANT]);
    assert.deepEqual((await auditRows("helpdesk.assets.intune_credentials")).at(-1), { changed: ["intune_credentials", "intune_own_app", "intune_source_changed"], tenant: OTHER_TENANT, client_id: OWN.client_id, linked_assets_retired: 1 });
    directorySyncLicensed = false;
  });
});

describe("the one-click setup's core side (1.20.4)", () => {
  // What the setup saves: the tenant ID of the admin's sign-in, the new app's client ID and secret.
  const NEW_APP = { tenant: TID, client_id: OWN.client_id, secret: OWN.secret };
  const audited = () => auditRows("helpdesk.assets.intune_credentials");

  test("what it reads before it creates anything in Entra: the tenant in use, and whether Intune has its own app", async () => {
    assets.setAssetSettingsForTests(BASE());
    assert.deepEqual(await assets.intuneSetupState(), { tenantInUse: "", ownApp: false });
    // An install on the directory sync app: a tenant in use, no app of its own.
    assets.setAssetSettingsForTests(BASE({ on: true, cache_source: TID, cred_tag: "legacy" }));
    assert.deepEqual(await assets.intuneSetupState(), { tenantInUse: TID, ownApp: false });
    // Switched off or forgotten, the devices' tenant is still the one in use (linked devices stay).
    assets.setAssetSettingsForTests(BASE({ on: false, cache_source: OTHER_TID }));
    assert.deepEqual(await assets.intuneSetupState(), { tenantInUse: OTHER_TID, ownApp: false });
    assets.setAssetSettingsForTests(BASE({ on: true, cache_source: TID, tenant: TID, client_id: OWN.client_id, secret: OWN.secret }));
    assert.deepEqual(await assets.intuneSetupState(), { tenantInUse: TID, ownApp: true });
  });

  test("a 403 drops the cached token: consent that reaches Graph later is seen at the next try", async () => {
    intune.clearIntuneTokensForTests();
    const creds = { tenant: TID, clientId: OWN.client_id, secret: OWN.secret, mode: "own" as const };
    graph.forbid = true;
    try {
      const before = graph.tokensIssued;
      assert.equal((await assets.testIntune(creds)).ok, false);
      assert.equal((await assets.testIntune(creds)).ok, false);
      assert.equal(graph.tokensIssued - before, 2, "each try after a 403 signs in again");
    } finally {
      graph.forbid = false;
    }
    const before = graph.tokensIssued;
    assert.equal((await assets.testIntune(creds)).ok, true);
    assert.equal((await assets.testIntune(creds)).ok, true);
    assert.equal(graph.tokensIssued - before, 1, "a token that works is kept");
  });

  test("an app Microsoft is still activating: the normal save refuses, the setup's save keeps the secret, and it works once Microsoft is ready", async () => {
    assets.setAssetSettingsForTests(BASE());
    intune.clearIntuneTokensForTests();
    const had = (await audited()).length;
    graph.forbid = true; // the consent has not reached Graph yet
    try {
      await assert.rejects(assets.saveAssetSettings({ intune_credentials: NEW_APP }), (e: Error & { status?: number; code?: string }) => {
        assert.equal(e.status, 409);
        assert.equal(e.code, undefined, "a refusal to retry, not a question");
        return true;
      });
      assert.deepEqual(await assets.intuneSetupState(), { tenantInUse: "", ownApp: false }, "nothing saved by the refusal");
      const r = await assets.saveIntuneAppUnverified(TID.toUpperCase(), NEW_APP);
      assert.deepEqual(r, { changed: ["intune_credentials", "intune_on"], retired: 0 });
      const s = await assets.getAssetSettings();
      assert.deepEqual(
        [s.intune?.on, s.intune?.cache_source, s.intune?.tenant, s.intune?.client_id, s.intune?.secret, s.intune?.cred_tag],
        [true, TID, TID, OWN.client_id, OWN.secret, assets.credTag({ tenant: TID, clientId: OWN.client_id })]
      );
      // Saved and on; the card has nothing to "check" (the tenant is known), and a test says why it can't list devices yet.
      const v = await view();
      assert.deepEqual(
        { on: v.intune.on, mode: v.intune.mode, secret_set: v.intune.secret_set, unavailable: v.intune.unavailable, check_error: v.intune.check_error },
        { on: true, mode: "own", secret_set: true, unavailable: null, check_error: "" }
      );
      assert.ok(!JSON.stringify(v).includes(OWN.secret));
      const t = await assets.testIntune();
      assert.equal(t.ok, false);
      assert.match((t as { error: string }).error, /DeviceManagementManagedDevices\.Read\.All/);
    } finally {
      graph.forbid = false;
    }
    // Microsoft is ready: Test connection and the sync work with what was saved.
    assert.deepEqual(await assets.testIntune(), { ok: true, total: 1, tenant: TID, tag: assets.credTag({ tenant: TID, clientId: OWN.client_id }) });
    await pool().query("DELETE FROM hd_assets WHERE provider LIKE $1", [`${INTUNE}%`]);
    const sync = await assets.syncProvider(INTUNE, { force: true });
    assert.equal(sync.ok, true, JSON.stringify(sync));
    assert.deepEqual((await rows()).map((x) => x.external_id), ["d-1"]);
    assert.equal((await audited()).length, had, "the library audits nothing: the caller does, as the route does");
    assert.ok(!logged.join("\n").includes(OWN.secret), "a log line carried the secret");
  });

  test("what the setup's save refuses: a tenant that is not the tenant ID, a missing secret, devices here from another tenant", async () => {
    assets.setAssetSettingsForTests(BASE());
    const refused = async (tid: string, raw: unknown, re: RegExp, code?: string) => {
      await assert.rejects(assets.saveIntuneAppUnverified(tid, raw), (e: Error & { code?: string }) => {
        assert.match(e.message, re);
        assert.equal(e.code, code);
        return true;
      });
      assert.equal((await assets.getAssetSettings()).intune?.secret ?? "", "", "nothing saved");
    };
    // The tenant as a domain could be any tenant's: only the ID the app was created in is taken.
    await refused(TID, { ...NEW_APP, tenant: TENANT }, /must be the ID of the tenant it was created in/);
    await refused(TENANT, { ...NEW_APP, tenant: TENANT }, /must be the ID of the tenant it was created in/);
    await refused(TID, { ...NEW_APP, tenant: OTHER_TID }, /must be the ID of the tenant it was created in/);
    await refused(TID, { tenant: TID, client_id: OWN.client_id }, /Paste the client secret/);
    await refused(TID, { ...NEW_APP, client_id: "nope" }, /is a GUID/);
    // Devices here came from another tenant: refused as the form's save is without the confirmation, and nothing is retired.
    assets.setAssetSettingsForTests(BASE({ on: true, cache_source: OTHER_TID, cred_tag: "legacy" }));
    await seedDevices();
    await refused(TID, NEW_APP, /different Microsoft 365 tenant/, "tenant_change");
    assert.deepEqual((await rows()).map((x) => [x.external_id, x.provider, x.gone_at]), [["d-linked", INTUNE, null], ["d-loose", INTUNE, null]]);
    assert.equal((await assets.getAssetSettings()).intune?.cache_source, OTHER_TID);
  });

  test("an install on the directory sync app, same tenant: its own app takes over and every device and link stays", async () => {
    assets.setAssetSettingsForTests(BASE({ on: true, cache_source: TID, cred_tag: assets.credTag({ tenant: DIR.tenant, clientId: DIR.clientId }) }));
    directorySyncLicensed = true;
    directoryConfig = DIR;
    assets.setIntuneCredentialsForTests(undefined);
    try {
      await seedDevices();
      assert.equal((await view()).intune.mode, "directory");
      // Through the normal save (the setup's first choice) the answer is the form's own.
      const r = await assets.saveAssetSettings({ intune_credentials: NEW_APP });
      assert.deepEqual(r, { changed: ["intune_credentials", "intune_own_app"], retired: 0 });
      assert.deepEqual((await rows()).map((x) => [x.external_id, x.provider, x.gone_at]), [["d-linked", INTUNE, null], ["d-loose", INTUNE, null]]);
      // And through the setup's save without a sign-in, from the same starting point.
      assets.setAssetSettingsForTests(BASE({ on: true, cache_source: TID, cred_tag: assets.credTag({ tenant: DIR.tenant, clientId: DIR.clientId }) }));
      assets.setIntuneCredentialsForTests(undefined);
      const u = await assets.saveIntuneAppUnverified(TID, NEW_APP);
      assert.deepEqual(u, { changed: ["intune_credentials", "intune_own_app"], retired: 0 });
      assert.deepEqual((await rows()).map((x) => [x.external_id, x.provider, x.gone_at]), [["d-linked", INTUNE, null], ["d-loose", INTUNE, null]]);
      assert.equal((await view()).intune.mode, "own");
    } finally {
      directorySyncLicensed = false;
      directoryConfig = { tenant: "", clientId: "", clientSecret: "" };
      assets.setIntuneCredentialsForTests(undefined);
    }
  });
});

describe("as stored", () => {
  test("the secret is sealed in the settings row; an older build's row (no credentials) still reads", async () => {
    const db = await pool().connect();
    try {
      await db.query("SELECT pg_advisory_lock(hashtext('helpdesk_assets_settings_test'))");
      const saved = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_assets'")).rows[0]?.value as string | undefined;
      assets.setAssetSettingsForTests(null);
      try {
        // A 1.20.1 row: Intune on through the directory sync app, no credentials of its own.
        await db.query("INSERT INTO settings (key, value) VALUES ('helpdesk_assets', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
          JSON.stringify({ snipeit: { url: "", key: "", on_solve: "nothing" }, agents_search_all: true, cache_source: "", intune: { on: true, cache_source: TID, cred_tag: "x" } }),
        ]);
        let s = await assets.getAssetSettings();
        assert.deepEqual([s.intune?.on, s.intune?.tenant, s.intune?.client_id, s.intune?.secret], [true, "", "", ""]);
        const r = await put({ intune_credentials: OWN });
        assert.equal(r.status, 200, r.text);
        const raw = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_assets'")).rows[0].value as string;
        assert.ok(!raw.includes(OWN.secret), "the settings row holds the secret in the clear");
        const stored = JSON.parse(raw).intune;
        assert.deepEqual([stored.on, stored.tenant, stored.client_id, stored.cache_source, "secret" in stored], [true, TENANT, OWN.client_id, TID, false]);
        assert.match(stored.key, /^enc:v1:/);
        s = await assets.getAssetSettings();
        assert.equal(s.intune?.secret, OWN.secret, "and opens again for the sign-in");
        // A save of the other settings never drops or exposes it.
        await assets.saveAssetSettings({ agents_search_all: false });
        assert.equal((await assets.getAssetSettings()).intune?.secret, OWN.secret);
        // Off keeps the app registration for the next On; forgetting it removes the sealed secret too.
        assert.equal((await put({ intune: false })).status, 200);
        assert.equal((await assets.getAssetSettings()).intune?.secret, OWN.secret);
        assert.equal((await put({ intune: true })).status, 200);
        assert.equal((await put({ intune_credentials: null })).status, 200);
        assert.equal(JSON.parse((await db.query("SELECT value FROM settings WHERE key = 'helpdesk_assets'")).rows[0].value).intune.key, "");
        // A sealed secret this key can't open (the master key changed): it reads as no secret, and
        // Intune is still its own app, waiting for credentials. It never signs in with the directory sync app.
        await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_assets'", [
          JSON.stringify({ snipeit: { url: "", key: "", on_solve: "nothing" }, agents_search_all: true, cache_source: "", intune: { on: true, cache_source: TID, cred_tag: "x", tenant: TENANT, client_id: OWN.client_id, key: `enc:v1:${Buffer.alloc(48, 7).toString("base64")}` } }),
        ]);
        directorySyncLicensed = true;
        directoryConfig = DIR;
        assets.setIntuneCredentialsForTests(undefined);
        try {
          s = await assets.getAssetSettings();
          assert.deepEqual([s.intune?.on, s.intune?.tenant, s.intune?.client_id, s.intune?.secret], [true, TENANT, OWN.client_id, ""]);
          directoryConfigReads = 0;
          assert.equal(await assets.intuneCredentials(), "credentials");
          assert.equal(await assets.intuneSourceCheck(), null);
          assert.equal(directoryConfigReads, 0);
        } finally {
          directorySyncLicensed = false;
          directoryConfig = { tenant: "", clientId: "", clientSecret: "" };
        }
      } finally {
        if (saved === undefined) await db.query("DELETE FROM settings WHERE key = 'helpdesk_assets'");
        else await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_assets'", [saved]);
        assets.setAssetSettingsForTests(BASE());
      }
    } finally {
      await db.query("SELECT pg_advisory_unlock(hashtext('helpdesk_assets_settings_test'))").catch(() => {});
      db.release();
    }
    assert.ok(!logged.join("\n").includes(OWN.secret), "a log line carried the secret");
  });
});
