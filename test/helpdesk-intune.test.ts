// Helpdesk 1.19.4: Microsoft Intune as an asset source (lib/helpdesk/assets,
// lib/helpdesk/assets/intune), plus the 1.19.3 follow-up that linkAsset
// refuses gone and retired assets. Never calls Microsoft: a fake identity
// platform + Graph (test/support/fake-intune) and the fake Snipe-IT
// (test/support/fake-snipeit) run in-process, and the asset transport sends
// https://login.microsoftonline.com, https://graph.microsoft.com and
// https://snipe.test there, so the real client code is exercised over HTTP.
// Covered:
//
//   pure       placeholder serials, a device's normalised row (no unasked
//              fields), compliance wording, the card and page lines
//   client     the client-credentials token (form body, scope, cached),
//              a 401 takes a fresh token once, nextLink paging, a nextLink
//              to another host refused, $filter by serial / UPN / email,
//              a device by id (404 is none), 403 names the permission, a
//              wrong secret is a sign-in error that never echoes it
//   settings   unavailable without the licence or the directory
//              credentials; switching on tests Graph first (403 refused with
//              the permission); the route audits intune_on / intune_off and
//              never returns the secret; the view's device and matched counts
//   sync       devices cached under their own lock (a Snipe-IT sync holding
//              its key doesn't stop it), an incomplete pass removes nothing,
//              the sweep syncs both sources
//   matching   one asset per device: the Snipe-IT asset with the same serial
//              carries the Intune line (card, picker, page, search, connector)
//              and the Intune row is hidden; an unmatched device is an Intune
//              asset; people match on a confirmed address equal to the
//              device's email or its UPN, never a self-set one
//   follow-up  linkAsset refuses a gone row, a retired row and a row of a
//              source that is off, with a sentence that says why (lib and route)
//   offline    Intune off: links stay (read-only history, unlinkable), the
//              picker, Get help and search stop offering its devices, Snipe-IT
//              assets lose the Intune line, an unlinked device's page is 404
//   tenant     another tenant in the directory settings is a new source: not
//              connected until the check retires the old rows (linked kept as
//              gone, unlinked deleted), audited
//
// Parallel-safe: teams, people, tickets and asset rows are this file's own
// (STAMP; rows under "snipeit:<STAMP>" and "intune:<STAMP>"). Settings and
// credentials are in-process overrides; nothing workspace-wide is written.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-intune.test.ts

import { test, before, after, describe } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { fakeDevice, fakeIntuneTransport, startFakeIntune, type FakeIntuneState } from "./support/fake-intune";
import { fakeHardware, fakePerson, fakeSnipeItTransport, startFakeSnipeIt, type FakeSnipeItState, type Obj } from "./support/fake-snipeit";
import { pool, getSetting, createSession } from "../src/lib/db";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-intune.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-intune.virtual.js");
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
  // Directory sync is not licensed here: the stored directory credentials are never read.
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee" || request === "../../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const assets = require("../src/lib/helpdesk/assets") as typeof import("../src/lib/helpdesk/assets");
const shared = require("../src/lib/helpdesk/assets-shared") as typeof import("../src/lib/helpdesk/assets-shared");
const httpMod = require("../src/lib/helpdesk/assets/http") as typeof import("../src/lib/helpdesk/assets/http");
const intune = require("../src/lib/helpdesk/assets/intune") as typeof import("../src/lib/helpdesk/assets/intune");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const adminRoute = require("../src/app/api/helpdesk/admin/assets/route") as typeof import("../src/app/api/helpdesk/admin/assets/route");
const adminSyncRoute = require("../src/app/api/helpdesk/admin/assets/sync/route") as typeof import("../src/app/api/helpdesk/admin/assets/sync/route");
const ticketAssetsRoute = require("../src/app/api/helpdesk/tickets/[number]/assets/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/assets/route");
const ticketAssetRoute = require("../src/app/api/helpdesk/tickets/[number]/assets/[assetId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/assets/[assetId]/route");
const optionsRoute = require("../src/app/api/helpdesk/tickets/[number]/assets/options/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/assets/options/route");
const assetRoute = require("../src/app/api/helpdesk/assets/[id]/route") as typeof import("../src/app/api/helpdesk/assets/[id]/route");
const searchRoute = require("../src/app/api/helpdesk/assets/route") as typeof import("../src/app/api/helpdesk/assets/route");
const mineRoute = require("../src/app/api/helpdesk/assets/mine/route") as typeof import("../src/app/api/helpdesk/assets/mine/route");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const withTx = (require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core")).withTx;
const mdInlineOf = (require("../src/lib/helpdesk/md-inline") as typeof import("../src/lib/helpdesk/md-inline")).mdInline;
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

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

const STAMP = `hdin-${Date.now()}-${process.pid}`;
const TAGP = `I${Date.now().toString(36)}${process.pid}`.toUpperCase();
const SNIPE_KEY = `snipe-key-${STAMP}-0123456789abcdefghijklmnop`;
const SNIPE = `snipeit:${STAMP}`;
const INTUNE = `intune:${STAMP}`;
// The tenant's ID (the token's tid) is the source; its domain is only how the admin typed it.
const TID = randomUUID();
const OTHER_TID = randomUUID();
const CREDS = { tenant: `tenant-${STAMP}.onmicrosoft.com`, clientId: `client-${STAMP}`, secret: `graph-secret-${STAMP}-very-long-value` };
const P: Record<string, { id: number; session: string; name: string; email: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const ticketIds: number[] = [];

let snipe: FakeSnipeItState;
let graph: FakeIntuneState;
let expireTokens = () => {};
const closers: (() => Promise<void>)[] = [];
let snipePort = 0;
let graphPort = 0;

type Settings = import("../src/lib/helpdesk/assets").AssetSettings;
const SETTINGS = (intuneOn = true, snipeOn = true, tid = TID, creds: { tenant: string; clientId: string } = CREDS): Settings => ({
  snipeit: snipeOn ? { url: "https://snipe.test", token: SNIPE_KEY, on_solve: "nothing" } : { url: "", token: "", on_solve: "nothing" },
  agents_search_all: true,
  cache_source: "https://snipe.test",
  intune: { on: intuneOn, cache_source: tid, cred_tag: assets.credTag(creds) },
});

function useFakes() {
  httpMod.setAssetTransportForTests(fakeIntuneTransport(graphPort, fakeSnipeItTransport(snipePort)));
}

async function personRow(key: string, deskRole: string | null, opts: { email?: string; selfSet?: boolean } = {}) {
  const name = `${key} ${STAMP}`;
  const mail = opts.email ?? `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, email_self_set) VALUES ($1, $2, $3, 'viewer', 'active', $4) RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    mail,
    opts.selfSet ? 1 : 0,
  ]);
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

const ticketOf = (id: number) => tickets.getTicketById(id);
const agentUser = () => ({ id: P.agent.id, role: "viewer" }) as never;
const actor = () => ({ id: P.agent.id, name: P.agent.name });
const rowOf = async (provider: string, externalId: string) =>
  (await pool().query("SELECT id, provider, gone_at, serial, assigned_email, assigned_upn, raw FROM hd_assets WHERE provider = $1 AND external_id = $2", [provider, externalId])).rows[0] as
    | { id: number; provider: string; gone_at: Date | null; serial: string; assigned_email: string; assigned_upn: string; raw: Obj }
    | undefined;
const idOf = async (provider: string, externalId: string) => (await rowOf(provider, externalId))?.id as number;
const auditRows = async (action: string) => (await pool().query("SELECT actor_id, details, target_label FROM audit_log WHERE action = $1 AND actor_id = ANY($2) ORDER BY id", [action, userIds])).rows;

// The shared serial: Snipe-IT's MacBook and Intune's view of it.
const SERIAL = `C02${TAGP}`;

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  email.setHelpdeskTransportForTests(async () => {});
  const s = await startFakeSnipeIt(SNIPE_KEY);
  snipe = s.state;
  snipePort = s.port;
  closers.push(s.close);
  const g = await startFakeIntune({ ...CREDS, tid: TID });
  graph = g.state;
  graphPort = g.port;
  expireTokens = g.expireTokens;
  closers.push(g.close);
  useFakes();
  assets.setSnipeItCacheKeyForTests(SNIPE);
  assets.setIntuneCacheKeyForTests(INTUNE);
  assets.setIntuneCredentialsForTests(CREDS);
  assets.setAssetSettingsForTests(SETTINGS());
  for (const k of ["A", "B"]) {
    const r = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9400) RETURNING id", [`${STAMP} ${k}`]);
    T[k] = r.rows[0].id;
  }
  await personRow("agent", "agent");
  await personRow("admin", "admin");
  // Daniel's account address is his UPN; Intune's emailAddress for his devices is an alias.
  await personRow("req", null, { email: `${STAMP}-daniel@acme.example` });
  // Mallory typed Priya's UPN into her own profile: never matched.
  await personRow("req2", null, { email: `${STAMP}-priya@acme.example`, selfSet: true });
  await personRow("agentB", "agent");
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($3, $4, 'agent')", [T.A, P.agent.id, T.B, P.agentB.id]);

  // Snipe-IT: Daniel's MacBook (serial SERIAL) and a monitor.
  snipe.users.push(fakePerson(77, P.req.email, "Daniel Okafor"));
  snipe.hardware.push(
    fakeHardware(421, TAGP, { name: "MacBook Pro 14 (2024)", asset_tag: `${TAGP}-00421`, serial: SERIAL, assigned_to: fakePerson(77, P.req.email, "Daniel Okafor"), status_label: { id: 2, name: "Deployed", status_type: "deployable", status_meta: "deployed" } }),
    fakeHardware(312, TAGP, { name: "Dell U2723QE monitor", asset_tag: `${TAGP}-00312`, serial: `MON${TAGP}`, model: { id: 2, name: "U2723QE" }, category: { id: 2, name: "Monitors" } })
  );
  // Intune: the same MacBook, Daniel's iPhone (Intune only), a device with a placeholder serial, Priya's laptop.
  const upn = P.req.email;
  graph.devices.push(
    fakeDevice(`mac-${STAMP}`, { deviceName: "DANIEL-MBP", serialNumber: SERIAL, userPrincipalName: upn, emailAddress: `daniel.alias-${STAMP}@acme.example`, userDisplayName: "Daniel Okafor" }),
    fakeDevice(`iph-${STAMP}`, {
      deviceName: "Daniel's iPhone",
      serialNumber: `F2L${TAGP}`,
      model: "iPhone 15",
      operatingSystem: "iOS",
      osVersion: "18.1",
      complianceState: "noncompliant",
      userPrincipalName: upn,
      emailAddress: `daniel.alias-${STAMP}@acme.example`,
      userDisplayName: "Daniel Okafor",
    }),
    fakeDevice(`vm-${STAMP}`, { deviceName: "KIOSK-VM", serialNumber: "0", model: "Virtual Machine", operatingSystem: "Windows", osVersion: "10.0.22631.3880" }),
    fakeDevice(`pri-${STAMP}`, { deviceName: "PRIYA-X1", serialNumber: `PF${TAGP}`, model: "ThinkPad X1 Carbon", operatingSystem: "Windows", userPrincipalName: P.req2.email, userDisplayName: "Priya Natarajan" })
  );
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  email.setHelpdeskTransportForTests(null);
  httpMod.setAssetTransportForTests(null);
  assets.setAssetSettingsForTests(null);
  assets.setSnipeItCacheKeyForTests(null);
  assets.setIntuneCacheKeyForTests(null);
  assets.setIntuneCredentialsForTests(undefined);
  intune.setIntunePagingForTests(null);
  intune.clearIntuneTokensForTests();
  for (const c of closers) await c();
  await pool().query("UPDATE hd_tickets SET merged_into = NULL WHERE id = ANY($1)", [ticketIds]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1) OR team_id = ANY($2) OR requester_id = ANY($3)", [ticketIds, Object.values(T), userIds]);
  await pool().query("DELETE FROM hd_assets WHERE provider IN ($1, $2) OR provider LIKE $3 OR provider LIKE $4", [SNIPE, INTUNE, `${SNIPE}:retired:%`, `${INTUNE}:retired:%`]);
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [[`helpdesk_assets_sync:${SNIPE}`, `helpdesk_assets_sync:${INTUNE}`]]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Pure -----------------------------------------------------------------------------------

describe("Intune: shapes and wording (pure)", () => {
  test("placeholder and short serials never match anything", () => {
    for (const s of ["0", "000000", "Unknown", "N/A", "To be filled by O.E.M.", "Default string", "abc", "", "  "]) assert.equal(intune.cleanSerial(s), "", s);
    assert.equal(intune.cleanSerial(" C02XK2Q1MD6R "), "C02XK2Q1MD6R");
  });

  test("a managed device as the cache keeps it: no tag, the UPN kept apart, never the fields it didn't ask for", () => {
    const a = intune.normaliseDevice(
      fakeDevice("abc-1", { serialNumber: "C02XK2Q1MD6R", userPrincipalName: "Daniel@Acme.example", emailAddress: "D.Okafor@acme.example", userDisplayName: "Daniel Okafor", lastSyncDateTime: "2026-11-06T08:00:00Z" })
    )!;
    assert.equal(a.tag, "");
    assert.equal(a.serial, "C02XK2Q1MD6R");
    assert.equal(a.assigned_email, "d.okafor@acme.example", "the device's email first");
    assert.equal(a.assigned_upn, "daniel@acme.example");
    assert.equal(a.category, "Computer");
    assert.deepEqual(a.raw, { compliance: "compliant", last_seen: "2026-11-06T08:00:00.000Z", os: "macOS", os_version: "15.2", manufacturer: "Apple" });
    assert.ok(!JSON.stringify(a).includes("35-000000"), "the IMEI is never cached");
    assert.match(a.url, /^https:\/\/intune\.microsoft\.com\/.*mdmDeviceId\/abc-1$/);
    const never = intune.normaliseDevice(fakeDevice("abc-2", { lastSyncDateTime: "0001-01-01T00:00:00Z", userPrincipalName: "", emailAddress: "", userDisplayName: "Ghost" }))!;
    assert.equal(never.raw.last_seen, null, "Graph's 0001-01-01 is never");
    assert.equal(never.assigned_name, "", "no person, no name");
    assert.equal(intune.normaliseDevice(fakeDevice("p", { operatingSystem: "iOS", model: "iPhone 15" }))!.category, "Phone");
    assert.equal(intune.normaliseDevice(fakeDevice("t", { operatingSystem: "iOS", model: "iPad Pro" }))!.category, "Tablet");
    assert.equal(intune.normaliseDevice({ deviceName: "no id" }), null);
  });

  test("compliance, the card's line, the page's line and where an asset comes from", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    const i = { compliance: "compliant", last_seen: "2026-11-06T10:00:00Z", os: "macOS", os_version: "15.2" };
    assert.equal(shared.intuneSeenLine(i, now), "Compliant · seen 2h ago");
    assert.equal(shared.intuneOsLine(i), "Compliant · macOS 15.2");
    assert.equal(shared.complianceLabel("noncompliant"), "Not compliant");
    assert.equal(shared.complianceLabel("inGracePeriod"), "In grace period");
    assert.equal(shared.complianceLabel(""), "Compliance unknown");
    assert.equal(shared.complianceTone("compliant"), "ok");
    assert.equal(shared.complianceTone("noncompliant"), "warn");
    assert.equal(shared.intuneSeenLine({ ...i, last_seen: null }, now), "Compliant");
    assert.equal(shared.sourceLine({ provider: "snipeit", intune: i }), "from Snipe-IT, matched to Intune");
    assert.equal(shared.sourceLine({ provider: "snipeit:x", intune: null }), "from Snipe-IT");
    assert.equal(shared.sourceLine({ provider: "intune", intune: i }), "from Intune");
    assert.equal(shared.providerLabel("intune:retired:1"), "Intune");
  });
});

// --- The client -----------------------------------------------------------------------------

describe("Intune: the Graph client", () => {
  const client = () =>
    intune.intuneProvider({ url: "https://graph.microsoft.com", token: CREDS.secret, tenant: CREDS.tenant, clientId: CREDS.clientId, key: INTUNE });

  test("signs in with client credentials (form body, Graph's scope), then reuses the token", async () => {
    intune.clearIntuneTokensForTests();
    const before = graph.tokensIssued;
    graph.seen.length = 0;
    const p = client();
    assert.equal((await p.test()).total, graph.devices.length);
    await p.get(`mac-${STAMP}`);
    assert.equal(graph.tokensIssued - before, 1, "one token for both calls");
    const login = graph.seen.find((s) => s.host === "login.microsoftonline.com")!;
    assert.equal(login.path, `/${encodeURIComponent(CREDS.tenant)}/oauth2/v2.0/token`);
    assert.match(login.body, /grant_type=client_credentials/);
    assert.match(login.body, /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
    assert.equal(login.auth, "", "no bearer on the token request");
    for (const s of graph.seen.filter((x) => x.host === "graph.microsoft.com")) assert.match(s.auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test("an expired token (401) takes a fresh one once", async () => {
    const p = client();
    await p.test();
    expireTokens();
    const before = graph.tokensIssued;
    assert.ok(await p.get(`mac-${STAMP}`));
    assert.equal(graph.tokensIssued - before, 1);
  });

  test("pages through @odata.nextLink; a nextLink to another host is refused", async () => {
    intune.setIntunePagingForTests({ page: 2, maxPages: 10 });
    graph.maxPage = 2;
    try {
      const pages: number[] = [];
      const r = await client().listAll(async (page) => {
        pages.push(page.length);
      });
      assert.deepEqual(pages, [2, 2]);
      assert.deepEqual(r, { total: 4, seen: 4, complete: true });
      graph.foreignNextLink = true;
      await assert.rejects(client().listAll(async () => {}), /pointed the device list somewhere else/);
      graph.foreignNextLink = false;
      intune.setIntunePagingForTests({ page: 2, maxPages: 1 });
      const short = await client().listAll(async () => {});
      assert.equal(short.complete, false, "stopped by the page cap");
    } finally {
      intune.setIntunePagingForTests(null);
      graph.maxPage = 1000;
      graph.foreignNextLink = false;
    }
  });

  test("by serial, by a person's UPN or email (merged), by id; a placeholder serial asks nothing", async () => {
    const p = client();
    assert.deepEqual((await p.bySerial(SERIAL.toLowerCase())).map((d) => d.external_id), [`mac-${STAMP}`]);
    graph.seen.length = 0;
    assert.deepEqual(await p.bySerial("0"), []);
    assert.equal(graph.seen.length, 0);
    const daniel = (await p.forEmail(P.req.email.toUpperCase()))!.map((d) => d.external_id).sort();
    assert.deepEqual(daniel, [`iph-${STAMP}`, `mac-${STAMP}`]);
    const byAlias = (await p.forEmail(`daniel.alias-${STAMP}@acme.example`))!.length;
    assert.equal(byAlias, 2);
    assert.equal(await p.forEmail("nobody@acme.example"), null);
    assert.equal(await p.get("no-such-device"), null);
    assert.equal(await p.byTag("anything"), null);
    assert.equal((await p.search("daniel's", 5))[0]?.external_id, `iph-${STAMP}`, "a quote in the term is escaped");
  });

  test("403: says which permission the app registration needs", async () => {
    graph.forbid = true;
    try {
      await assert.rejects(client().test(), (e: Error) => {
        assert.match(e.message, /DeviceManagementManagedDevices\.Read\.All application permission/);
        assert.match(e.message, /admin consent/);
        return true;
      });
    } finally {
      graph.forbid = false;
    }
  });

  test("a wrong secret is a sign-in error that never echoes the secret", async () => {
    intune.clearIntuneTokensForTests();
    const wrong = `wrong-${CREDS.secret}`;
    const p = intune.intuneProvider({ url: "https://graph.microsoft.com", token: wrong, tenant: CREDS.tenant, clientId: CREDS.clientId, key: INTUNE });
    await assert.rejects(p.test(), (e: Error) => {
      // 1.20.2: Intune's own app registration is named, and where to fix it.
      assert.match(e.message, /refused the Intune app registration's sign-in \(invalid_client\)/);
      assert.match(e.message, /Desk settings, Integrations, Microsoft Intune/);
      assert.ok(!e.message.includes(wrong) && !e.message.includes(CREDS.secret));
      return true;
    });
  });
});

describe("Intune: which tenant the credentials sign in to (review: tenant identity)", () => {
  const client = (over: Partial<import("../src/lib/helpdesk/assets/intune").IntuneConfig> = {}) =>
    intune.intuneProvider({ url: "https://graph.microsoft.com", token: CREDS.secret, tenant: CREDS.tenant, clientId: CREDS.clientId, key: INTUNE, ...over });

  test("the tenant ID comes from the token's tid; its GUID and its domain are the same tenant", async () => {
    intune.clearIntuneTokensForTests();
    assert.equal(await client().identity!(), TID);
    assert.equal(await client({ tenant: TID }).identity!(), TID, "typed as its GUID");
    assert.equal(intune.tokenTenantId("not-a-jwt"), "");
  });

  test("a token with no readable tid: GET /organization says which tenant", async () => {
    intune.clearIntuneTokensForTests();
    graph.opaqueTokens = true;
    try {
      const before = graph.organizationCalls;
      assert.equal(await client().identity!(), TID);
      assert.equal(graph.organizationCalls - before, 1);
    } finally {
      graph.opaqueTokens = false;
      intune.clearIntuneTokensForTests();
    }
  });

  test("a provider built for one tenant reads nothing with another tenant's token", async () => {
    intune.clearIntuneTokensForTests();
    graph.seen.length = 0;
    await assert.rejects(client({ expectTid: OTHER_TID }).listAll(async () => assert.fail("no page may be read")), /different Microsoft 365 tenant/);
    assert.ok(!graph.seen.some((x) => x.path.startsWith("/v1.0/deviceManagement/")), "no device list was asked for");
    assert.equal((await client({ expectTid: TID }).bySerial(SERIAL)).length, 1);
  });
});

// --- Settings --------------------------------------------------------------------------------

describe("Intune: settings", () => {
  test("not set up without an app registration of its own (1.20.2: directory sync is no part of it)", async () => {
    assets.setAssetSettingsForTests({ ...SETTINGS(false), intune: { on: false, cache_source: "" } });
    try {
      assets.setIntuneCredentialsForTests(undefined); // the real path: nothing entered, and directory sync isn't licensed in this stub
      assert.equal(await assets.intuneCredentials(), "credentials");
      assert.equal((await assets.assetSettingsView()).intune.unavailable, "credentials");
      let err = await assets.saveAssetSettings({ intune: true }).catch((e) => e);
      assert.equal(err.status, 409);
      assert.match(err.message, /Enter the Intune app registration's tenant, application \(client\) ID and client secret first/);
      assets.setIntuneCredentialsForTests(null);
      assert.equal((await assets.assetSettingsView()).intune.unavailable, "credentials");
      err = await assets.saveAssetSettings({ intune: true }).catch((e) => e);
      assert.match(err.message, /Enter the Intune app registration's tenant/);
      assert.equal((await assets.getAssetSettings()).intune?.on, false, "nothing saved");
    } finally {
      assets.setIntuneCredentialsForTests(CREDS);
      assets.setAssetSettingsForTests(SETTINGS());
    }
  });

  test("switching on tests Graph first: a 403 is refused with the permission, nothing saved", async () => {
    assets.setAssetSettingsForTests({ ...SETTINGS(false), intune: { on: false, cache_source: "" } });
    graph.forbid = true;
    try {
      const r = await call(adminRoute.PUT, req("/admin/assets", P.admin.session, { intune: true }, "PUT"));
      assert.equal(r.status, 409);
      assert.match(r.body.error, /DeviceManagementManagedDevices\.Read\.All/);
      assert.equal((await assets.getAssetSettings()).intune?.on, false);
      assert.equal((await auditRows("helpdesk.assets.intune_on")).length, 0);
    } finally {
      graph.forbid = false;
      assets.setAssetSettingsForTests(SETTINGS());
    }
  });

  test("the route turns it on and off (audited apart, settings.manage only); the view never holds a secret", async () => {
    assets.setAssetSettingsForTests({ ...SETTINGS(false), intune: { on: false, cache_source: "" } });
    try {
      assert.equal((await call(adminRoute.PUT, req("/admin/assets", P.agent.session, { intune: true }, "PUT"))).status, 403);
      const on = await call(adminRoute.PUT, req("/admin/assets", P.admin.session, { intune: true }, "PUT"));
      assert.equal(on.status, 200, on.text);
      assert.equal(on.body.intune.on, true);
      assert.equal(on.body.intune.unavailable, null);
      assert.ok(!on.text.includes(CREDS.secret) && !on.text.includes(SNIPE_KEY));
      assert.equal((await assets.getAssetSettings()).intune?.cache_source, TID, "the tenant ID the token signed in to, not the typed tenant");
      assert.equal((await assets.getAssetSettings()).intune?.cred_tag, assets.credTag(CREDS));
      const a = await auditRows("helpdesk.assets.intune_on");
      assert.equal(a.length, 1);
      assert.deepEqual(a[0].details.changed, ["intune_on"]);
      assert.equal(a[0].target_label, "Assets: Microsoft Intune");
      assert.ok(!JSON.stringify(a[0].details).includes(CREDS.secret));
      assert.equal((await auditRows("helpdesk.assets.settings_changed")).length, 0, "Snipe-IT's entry is not written for Intune's switch");
      const off = await call(adminRoute.PUT, req("/admin/assets", P.admin.session, { intune: false }, "PUT"));
      assert.equal(off.body.intune.on, false);
      assert.equal((await auditRows("helpdesk.assets.intune_off")).length, 1);
      assert.equal((await call(adminRoute.PUT, req("/admin/assets", P.admin.session, { intune: "yes" }, "PUT"))).status, 400);
    } finally {
      assets.setAssetSettingsForTests(SETTINGS());
    }
  });
});

// --- Sync ---------------------------------------------------------------------------------------

describe("Intune: sync", () => {
  test("Intune syncs under its own lock, even while a Snipe-IT sync holds its key", async () => {
    assert.notEqual(assets.INTUNE_SYNC_LOCK, assets.ASSETS_SYNC_LOCK);
    const holder = await pool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [assets.ASSETS_SYNC_LOCK]);
      const r = await assets.syncProvider(INTUNE, { force: true });
      assert.equal(r.ran, true, JSON.stringify(r));
      assert.equal(r.ok, true);
      assert.equal(r.seen, 4);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const mac = (await rowOf(INTUNE, `mac-${STAMP}`))!;
    assert.equal(mac.serial, SERIAL);
    assert.equal(mac.assigned_upn, P.req.email);
    assert.equal(mac.raw.compliance, "compliant");
    assert.equal((await rowOf(INTUNE, `vm-${STAMP}`))!.serial, "", "a placeholder serial is kept as none");
    const snipeRun = await assets.syncProvider(SNIPE, { force: true });
    assert.equal(snipeRun.ok, true, JSON.stringify(snipeRun));
  });

  test("Sync now for Intune (audited as Intune's); a pass cut short removes nothing", async () => {
    const r = await call(adminSyncRoute.POST, req("/admin/assets/sync", P.admin.session, { provider: "intune" }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.settings.intune.sync.count >= 4, true);
    assert.equal((await auditRows("helpdesk.assets.intune_synced")).length, 1);
    // A cut-short pass: the device that would have been missed stays.
    graph.devices.push(fakeDevice(`tmp-${STAMP}`, { serialNumber: `TMP${TAGP}` }));
    await assets.syncProvider(INTUNE, { force: true });
    graph.devices.pop();
    intune.setIntunePagingForTests({ page: 2, maxPages: 1 });
    try {
      const short = await assets.syncProvider(INTUNE, { force: true });
      assert.equal(short.complete, false);
      assert.match(short.error!, /before Microsoft Graph's last page, so nothing was removed/);
    } finally {
      intune.setIntunePagingForTests(null);
    }
    assert.ok(await rowOf(INTUNE, `tmp-${STAMP}`), "nothing removed by an incomplete pass");
    await pool().query("DELETE FROM hd_assets WHERE provider = $1 AND external_id = $2", [INTUNE, `tmp-${STAMP}`]);
  });

  test("the settings view counts devices and the ones shown as their Snipe-IT asset", async () => {
    const v = await assets.assetSettingsView();
    assert.equal(v.intune.on, true);
    assert.equal(v.intune.sync.count, 4);
    assert.equal(v.intune.matched, 1, "the MacBook");
    assert.equal(v.snipeit.sync.count, 2);
  });
});

// --- Matching ----------------------------------------------------------------------------------

describe("Intune: one asset per device, people by email or UPN", () => {
  test("the picker: Daniel's MacBook once (Snipe-IT, with its Intune line) and his iPhone from Intune", async () => {
    const t = await ticket("VPN on the MacBook");
    const o = await assets.assetOptions(agentUser(), (await ticketOf(t.id))!, "");
    const names = o.assigned.map((x) => `${x.name}|${x.provider_label}`).sort();
    assert.deepEqual(names, ["Daniel's iPhone|Intune", "MacBook Pro 14 (2024)|Snipe-IT"], "matched on his confirmed address = the devices' UPN; the Intune MacBook is not listed twice");
    const mac = o.assigned.find((x) => x.provider_label === "Snipe-IT")!;
    assert.equal(mac.intune?.compliance, "compliant");
    const phone = o.assigned.find((x) => x.provider_label === "Intune")!;
    assert.equal(phone.intune?.compliance, "noncompliant");
    assert.equal(phone.tag, "");
    // The route answers the same.
    const r = await call(optionsRoute.GET, req(`/tickets/${t.number}/assets/options`, P.agent.session), { number: String(t.number) });
    assert.equal(r.body.assigned.length, 2);
  });

  test("the requester strip (1.20.3): his devices carry Intune's compliance, and the band and the Devices tile draw the dot with the words", async () => {
    const t = await ticket("Strip: VPN on the MacBook");
    const got = await assets.requesterDevices((await ticketOf(t.id))!);
    assert.equal(got.connected, true);
    assert.deepEqual(got.devices.map((d) => `${d.name}|${d.provider_label}|${d.intune?.compliance}`).sort(), ["Daniel's iPhone|Intune|noncompliant", "MacBook Pro 14 (2024)|Snipe-IT|compliant"]);
    const mac = got.devices.find((d) => d.provider_label === "Snipe-IT")!;
    const phone = got.devices.find((d) => d.provider_label === "Intune")!;
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const strip = await import("../src/components/helpdesk/desk/ticket/RequesterStrip");
    const html = (c: typeof strip.DeviceFact | typeof strip.DeviceRow, a: typeof mac) => renderToStaticMarkup(createElement(c, { a }));
    // The band: a green dot and "Compliant", an amber one and "Not compliant"; always a dot with words.
    const ok = html(strip.DeviceFact, mac);
    assert.match(ok, /MacBook Pro 14 \(2024\)<\/a><span class="[^"]*bg-emerald-500[^"]*" data-compliance="ok" aria-hidden="true"><\/span><span[^>]*>Compliant<\/span>/);
    assert.ok(ok.includes(`href="/desk/assets/${mac.id}"`), "the name opens the asset's page");
    const bad = html(strip.DeviceFact, phone);
    assert.match(bad, /data-compliance="warn"/);
    assert.match(bad, /bg-amber-500[^>]*><\/span><span[^>]*>Not compliant<\/span>/);
    // A source that says nothing about compliance (or says "unknown") draws no dot in the band.
    assert.doesNotMatch(html(strip.DeviceFact, { ...mac, intune: null }), /data-compliance|ompliant/);
    assert.doesNotMatch(html(strip.DeviceFact, { ...mac, intune: { ...mac.intune!, compliance: "unknown" } }), /data-compliance|ompliance/);
    // The Devices tile: the same dot and words, then model · OS · seen.
    const row = html(strip.DeviceRow, phone);
    assert.match(row, /data-compliance="warn"[^>]*><\/span>Not compliant<\/span>/);
    assert.match(row, /iOS [\d.]+ · seen /);
    assert.match(html(strip.DeviceRow, { ...mac, intune: { ...mac.intune!, compliance: "unknown" } }), /data-compliance="neutral"[^>]*><\/span>Compliance unknown/);
  });

  test("a self-set address never matches: Priya's device isn't offered on Mallory's ticket", async () => {
    const t = await ticket("Laptop", "req2");
    const o = await assets.assetOptions(agentUser(), (await ticketOf(t.id))!, "");
    assert.deepEqual(o.assigned, []);
    assert.deepEqual(await assets.myAssets({ id: P.req2.id }), []);
  });

  test("search by the shared serial finds the Snipe-IT asset only; the card, page and connector carry the Intune line", async () => {
    const found = await assets.searchAssets(agentUser(), SERIAL);
    assert.deepEqual(found.rows.map((r) => r.provider), [SNIPE], "the Intune twin is hidden");
    const viaRoute = await call(searchRoute.GET, new Request(`http://localhost/api/helpdesk/assets?q=${SERIAL}`, { headers: { cookie: `compass_session=${P.agent.session}` } }));
    assert.equal(viaRoute.body.assets.length, 1);
    assert.equal(viaRoute.body.assets[0].intune.compliance, "compliant");
    // An unmatched Intune device is found as itself.
    const phone = await assets.searchAssets(agentUser(), `F2L${TAGP}`);
    assert.deepEqual(phone.rows.map((r) => r.provider), [INTUNE]);

    const t = await ticket("MacBook battery");
    const macId = await idOf(SNIPE, "421");
    await assets.linkAsset(agentUser(), (await ticketOf(t.id))!, macId, actor());
    const card = await call(ticketAssetsRoute.GET, req(`/tickets/${t.number}/assets`, P.agent.session), { number: String(t.number) });
    const a = card.body.assets[0];
    assert.equal(a.provider_label, "Snipe-IT");
    assert.equal(shared.intuneSeenLine(a.intune, Date.now()), "Compliant · seen 2h ago");
    const page = await call(assetRoute.GET, req(`/assets/${macId}`, P.agent.session), { id: String(macId) });
    assert.equal(page.status, 200);
    assert.equal(shared.sourceLine(page.body.asset), "from Snipe-IT, matched to Intune");
    assert.equal(shared.intuneOsLine(page.body.asset.intune), "Compliant · macOS 15.2");
    const mcp = (await assets.assetsForMcp(t.id)) as { intune?: { compliance: string; os: string } }[];
    assert.deepEqual(mcp[0].intune && { c: mcp[0].intune.compliance, os: mcp[0].intune.os }, { c: "compliant", os: "macOS 15.2" });
  });

  test("an Intune asset links and has its own page (no maintenance), opened in the Intune admin centre", async () => {
    const t = await ticket("iPhone mail");
    const phoneId = await idOf(INTUNE, `iph-${STAMP}`);
    const r = await call(ticketAssetsRoute.POST, req(`/tickets/${t.number}/assets`, P.agent.session, { asset_id: phoneId }), { number: String(t.number) });
    assert.equal(r.status, 201, r.text);
    const line = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [t.id])).rows[0].body;
    assert.equal(line, "Linked asset Daniel's iPhone from Intune.");
    const page = await call(assetRoute.GET, req(`/assets/${phoneId}`, P.agent.session), { id: String(phoneId) });
    assert.equal(page.status, 200, page.text);
    assert.equal(page.body.maintenance, null);
    assert.equal(shared.sourceLine(page.body.asset), "from Intune");
    assert.match(page.body.asset.url, /intune\.microsoft\.com/);
    assert.equal(page.body.notice, null, "refreshed from Graph");
  });

  test("Get help: the requester's own devices from both sources, each once", async () => {
    const mine = await call(mineRoute.GET, req("/assets/mine", P.req.session));
    assert.deepEqual(mine.body.assets.map((a: { name: string }) => a.name).sort(), ["Daniel's iPhone", "MacBook Pro 14 (2024)"]);
  });
});

// --- Follow-up: linkAsset refuses gone and retired rows ------------------------------------

describe("linkAsset refuses gone, retired and switched-off assets (1.19.3 follow-up)", () => {
  test("a gone row: 409 with why, from the lib and the route; nothing linked", async () => {
    const t = await ticket("Gone device");
    const id = await idOf(SNIPE, "312");
    await pool().query("UPDATE hd_assets SET gone_at = now() WHERE id = $1", [id]);
    try {
      const err = await assets.linkAsset(agentUser(), (await ticketOf(t.id))!, id, actor()).catch((e) => e);
      assert.equal(err.status, 409);
      assert.equal(err.message, `${TAGP}-00312 is no longer in Snipe-IT, so it can't be linked. Search for the device again.`);
      const r = await call(ticketAssetsRoute.POST, req(`/tickets/${t.number}/assets`, P.agent.session, { asset_id: id }), { number: String(t.number) });
      assert.equal(r.status, 409);
      assert.match(r.body.error, /no longer in Snipe-IT/);
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_ticket_assets WHERE ticket_id = $1", [t.id])).rows[0].n, 0);
    } finally {
      await pool().query("UPDATE hd_assets SET gone_at = NULL WHERE id = $1", [id]);
    }
  });

  test("a retired row (an old address's or tenant's) is refused even though a source is connected", async () => {
    const t = await ticket("Retired device");
    const r = await pool().query(
      `INSERT INTO hd_assets (provider, external_id, tag, name, gone_at) VALUES ($1, 'old-1', $2, 'Old laptop', now()) RETURNING id`,
      [`${SNIPE}:retired:1`, `${TAGP}-OLD`]
    );
    const err = await assets.linkAsset(agentUser(), (await ticketOf(t.id))!, r.rows[0].id, actor()).catch((e) => e);
    assert.equal(err.status, 409);
    assert.match(err.message, /came from a Snipe-IT source that has since been replaced/);
    // Without gone_at too: the retired key alone is enough.
    await pool().query("UPDATE hd_assets SET gone_at = NULL WHERE id = $1", [r.rows[0].id]);
    await assert.rejects(assets.linkAsset(agentUser(), (await ticketOf(t.id))!, r.rows[0].id, actor()), /has since been replaced/);
  });

  test("an asset of a source that is off (Intune) is refused while Snipe-IT is connected", async () => {
    const t = await ticket("Off source");
    assets.setAssetSettingsForTests(SETTINGS(false));
    try {
      const err = await assets.linkAsset(agentUser(), (await ticketOf(t.id))!, await idOf(INTUNE, `pri-${STAMP}`), actor()).catch((e) => e);
      assert.equal(err.status, 409);
      assert.equal(err.message, "Intune isn't connected now, so PRIYA-X1 can't be linked. An admin can connect it in Desk settings, Assets.");
    } finally {
      assets.setAssetSettingsForTests(SETTINGS());
    }
  });
});

// --- Review: a matched device stays its Intune user's ---------------------------------------

describe("a device matched to Snipe-IT stays its Intune user's (review: visibility)", () => {
  // Snipe-IT lists both: one checked out to nobody, one to someone else. Intune says both are Daniel's.
  const NOBODY = `TW1${TAGP}`;
  const ELSE = `TW2${TAGP}`;
  let nobodyId = 0;
  let elseId = 0;
  before(async () => {
    assets.setAssetSettingsForTests(SETTINGS());
    snipe.hardware.push(
      fakeHardware(901, TAGP, { name: "Spare MacBook Air", asset_tag: `${TAGP}-00901`, serial: NOBODY, assigned_to: null }),
      fakeHardware(902, TAGP, { name: "Loaner ThinkPad", asset_tag: `${TAGP}-00902`, serial: ELSE, assigned_to: fakePerson(80, `someone.else-${STAMP}@acme.example`, "Someone Else") })
    );
    graph.devices.push(
      fakeDevice(`tw1-${STAMP}`, { deviceName: "DANIEL-AIR", serialNumber: NOBODY, userPrincipalName: P.req.email, userDisplayName: "Daniel Okafor" }),
      fakeDevice(`tw2-${STAMP}`, { deviceName: "DANIEL-LOANER", serialNumber: ELSE, userPrincipalName: P.req.email, userDisplayName: "Daniel Okafor" })
    );
    assert.equal((await assets.syncProvider(SNIPE, { force: true })).ok, true);
    assert.equal((await assets.syncProvider(INTUNE, { force: true })).ok, true);
    nobodyId = await idOf(SNIPE, "901");
    elseId = await idOf(SNIPE, "902");
  });
  after(async () => {
    snipe.hardware = snipe.hardware.filter((h) => h.id !== 901 && h.id !== 902);
    graph.devices = graph.devices.filter((d) => !String(d.id).startsWith("tw"));
    await pool().query("DELETE FROM hd_assets WHERE (provider = $1 AND external_id IN ('901', '902')) OR (provider = $2 AND external_id LIKE 'tw%')", [SNIPE, INTUNE]);
    assets.setAssetSettingsForTests(SETTINGS());
  });

  test("the picker and Get help offer the Snipe-IT asset in the Intune row's place, whoever Snipe-IT says has it", async () => {
    const t = await ticket("Twin devices");
    const o = await assets.assetOptions(agentUser(), (await ticketOf(t.id))!, "");
    const ids = o.assigned.map((x) => x.id);
    assert.ok(ids.includes(nobodyId) && ids.includes(elseId), JSON.stringify(o.assigned.map((x) => x.name)));
    assert.ok(!o.assigned.some((x) => x.provider_label === "Intune" && /DANIEL-(AIR|LOANER)/.test(x.name)), "never the Intune row as well");
    assert.equal(o.assigned.find((x) => x.id === nobodyId)!.intune?.compliance, "compliant");
    const mine = (await assets.myAssets({ id: P.req.id })).map((a) => a.id);
    assert.ok(mine.includes(nobodyId) && mine.includes(elseId));
    assert.equal(await assets.isRequesterAsset({ id: P.req.id }, elseId), true, "Get help may link it");
    assert.equal(await assets.isRequesterAsset({ id: P.req2.id }, elseId), false);
  });

  test("search by the person's address finds the Snipe-IT asset; agents of their team see it with search-all off, others don't", async () => {
    const found = (await assets.searchAssets(agentUser(), P.req.email)).rows.map((r) => r.id);
    assert.ok(found.includes(nobodyId) && found.includes(elseId), JSON.stringify(found));
    assets.setAssetSettingsForTests({ ...SETTINGS(), agents_search_all: false });
    try {
      await ticket("Scope for twins", "req", "A");
      assert.equal(await assets.agentMaySeeAsset(agentUser(), elseId), true, "team A works Daniel's tickets");
      assert.equal(await assets.agentMaySeeAsset({ id: P.agentB.id, role: "viewer" } as never, elseId), false, "team B doesn't");
      const scoped = (await assets.searchAssets(agentUser(), P.req.email)).rows.map((r) => r.id);
      assert.ok(scoped.includes(elseId));
      // Linking it to Daniel's ticket is "his own device", even though Snipe-IT names someone else.
      const t = await ticket("Link the loaner");
      await assets.linkAsset({ id: P.agentB.id, role: "viewer" } as never, (await ticketOf(t.id))!, elseId, actor()).catch((e) => assert.fail(e.message));
    } finally {
      assets.setAssetSettingsForTests(SETTINGS());
    }
  });

  test("with Intune off, the twin rule is off too: only Snipe-IT's own person counts", async () => {
    assets.setAssetSettingsForTests(SETTINGS(false));
    try {
      assert.equal(await assets.isRequesterAsset({ id: P.req.id }, elseId), false);
      assert.ok(!(await assets.myAssets({ id: P.req.id })).some((a) => a.id === nobodyId));
    } finally {
      assets.setAssetSettingsForTests(SETTINGS());
    }
  });
});

// --- Review: the "not connected" sentences name the source in use ------------------------------

describe("not connected: the sentence names the source this workspace uses (review: messages)", () => {
  after(() => {
    assets.setIntuneCredentialsForTests(CREDS);
    assets.setAssetSettingsForTests(SETTINGS());
  });

  async function refusals() {
    const t = await ticket("Nothing connected");
    const link = await assets.linkAsset(agentUser(), (await ticketOf(t.id))!, await idOf(SNIPE, "421"), actor()).catch((e) => e);
    const search = await assets.searchAssets(agentUser(), "anything");
    const options = await assets.assetOptions(agentUser(), (await ticketOf(t.id))!, "");
    return { link: link.message as string, status: link.status as number, search: search.notice, options: options.notice };
  }

  test("Intune only (its credentials gone): Intune is named, never Snipe-IT", async () => {
    assets.setAssetSettingsForTests({ ...SETTINGS(true, false), cache_source: "" });
    assets.setIntuneCredentialsForTests(null);
    const r = await refusals();
    assert.equal(r.status, 409);
    assert.equal(r.link, "Intune isn't connected. An admin can check it in Desk settings, Assets.");
    assert.equal(r.options, r.link);
    assert.equal(r.search, "Intune isn't connected, so only assets linked to tickets are listed.");
  });

  test("neither set up: \"the asset source\"; Snipe-IT only: the 1.19.3 sentence", async () => {
    assets.setAssetSettingsForTests({ ...SETTINGS(false, false), cache_source: "" });
    let r = await refusals();
    assert.equal(r.link, "No asset source is connected. An admin can connect one in Desk settings, Assets.");
    assert.equal(r.search, "No asset source is connected, so only assets linked to tickets are listed.");
    assets.setAssetSettingsForTests(SETTINGS(false, false));
    r = await refusals();
    assert.equal(r.link, assets.NOT_CONNECTED);
    assert.match(r.search!, /^Snipe-IT isn't connected/);
  });
});

// --- Review: no second pool connection inside a transaction ------------------------------------

describe("getAsset inside a transaction uses only that transaction's client (review: transactions)", () => {
  test("with a client: no Intune line (that needs the pool); without: the line", async () => {
    const macId = await idOf(SNIPE, "421");
    assert.ok((await assets.getAsset(macId))!.intune);
    const inTx = await withTx((client) => assets.getAsset(macId, client));
    assert.equal(inTx!.intune, null);
    assert.equal(inTx!.id, macId);
  });

  test("many links and unlinks at once never wait on each other for a pool connection", async () => {
    const macId = await idOf(SNIPE, "421");
    const n = 12;
    const ts = await Promise.all(Array.from({ length: n }, (_, i) => ticket(`Pool ${i}`)));
    const run = (async () => {
      await Promise.all(ts.map((t) => assets.linkRequesterAsset(t.id, macId, { id: P.req.id, name: P.req.name })));
      await Promise.all(ts.map(async (t) => assets.unlinkAsset((await ticketOf(t.id))!, macId, actor())));
    })();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the pool ran dry inside transactions")), 15_000)));
    try {
      await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
    }
    const left = (await pool().query("SELECT count(*)::int AS n FROM hd_ticket_assets WHERE ticket_id = ANY($1)", [ts.map((t) => t.id)])).rows[0].n;
    assert.equal(left, 0);
  });
});

// --- Review: Markdown in system-written notes ---------------------------------------------------

/** What the desk's Markdown makes of a note: the node types and the text a reader sees. */
async function rendered(md: string): Promise<{ types: Set<string>; text: string }> {
  const { fromMarkdown } = await import("mdast-util-from-markdown");
  const { gfm } = await import("micromark-extension-gfm");
  const { gfmFromMarkdown } = await import("mdast-util-gfm");
  const { directive } = await import("micromark-extension-directive");
  const { directiveFromMarkdown } = await import("mdast-util-directive");
  const { toString } = await import("mdast-util-to-string");
  const tree = fromMarkdown(md, { extensions: [gfm(), directive()], mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown()] });
  const types = new Set<string>();
  const walk = (n: { type: string; children?: unknown[] }) => {
    types.add(n.type);
    for (const c of (n.children ?? []) as { type: string }[]) walk(c);
  };
  walk(tree as never);
  return { types, text: toString(tree) };
}

const DANGER = ["link", "linkReference", "image", "imageReference", "html", "emphasis", "strong", "delete", "inlineCode", "textDirective", "footnoteReference"];

describe("system notes escape device names and source text (review: Markdown)", () => {
  const EVIL = "[IT: re-verify your MFA](https://evil.example/login) **now** <b>x</b> www.evil.example ops@evil.example :abbr[x] `c`";

  test("mdInline: none of it becomes a link, emphasis, HTML, code, a directive or an autolink; the text reads the same", async () => {
    const r = await rendered(`Linked asset ${mdInlineOf(EVIL)} from Intune.`);
    for (const t of DANGER) assert.ok(!r.types.has(t), `${t} in ${[...r.types].join(",")}`);
    assert.equal(r.text.replace(/\u2060/g, ""), `Linked asset ${EVIL} from Intune.`, "reads the same (the word joiners are invisible)");
    assert.equal(mdInlineOf("MacBook Pro 14 (2024)"), "MacBook Pro 14 (2024)", "ordinary names are left alone");
    // Every ":" is escaped (1.19.4: a directive name may start with any letter, digit or emoji); the desk shows "Leaver: IT".
    assert.equal(mdInlineOf("Leaver: IT"), "Leaver\\: IT");
    assert.equal(mdInlineOf("two\nlines"), "two lines");
  });

  test("an Intune device named like a link is linked and picked in Get help: both notes show the name as text", async () => {
    graph.devices.push(fakeDevice(`evil-${STAMP}`, { deviceName: EVIL, serialNumber: `EV${TAGP}`, userPrincipalName: P.req.email }));
    try {
      await assets.syncProvider(INTUNE, { force: true });
      const id = await idOf(INTUNE, `evil-${STAMP}`);
      const t = await ticket("Evil name");
      await assets.linkAsset(agentUser(), (await ticketOf(t.id))!, id, actor());
      const t2 = await ticket("Evil name, Get help");
      assert.equal(await assets.linkRequesterAsset(t2.id, id, { id: P.req.id, name: P.req.name }), true);
      for (const [tid, prefix] of [[t.id, "Linked asset "], [t2.id, "The requester picked their device "]] as const) {
        const body = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'internal' ORDER BY id DESC LIMIT 1", [tid])).rows[0].body as string;
        const r = await rendered(body);
        for (const k of DANGER) assert.ok(!r.types.has(k), `${k} in a system note: ${body}`);
        assert.ok(r.text.replace(/\u2060/g, "").startsWith(`${prefix}${EVIL}`), r.text);
      }
    } finally {
      graph.devices = graph.devices.filter((d) => d.id !== `evil-${STAMP}`);
    }
  });
});

// --- Intune off -------------------------------------------------------------------------------

describe("Intune: turned off (the 1.19.3 disconnect rules)", () => {
  let t: { id: number; number: number };
  let phoneId = 0;
  before(async () => {
    assets.setAssetSettingsForTests(SETTINGS());
    await assets.syncProvider(INTUNE, { force: true });
    t = await ticket("Phone history");
    phoneId = await idOf(INTUNE, `iph-${STAMP}`);
    await assets.linkAsset(agentUser(), (await ticketOf(t.id))!, phoneId, actor());
  });
  after(() => assets.setAssetSettingsForTests(SETTINGS()));

  test("switching off deletes the unlinked devices and the sync record; linked ones stay (review: personal data)", async () => {
    const before = (await pool().query("SELECT count(*)::int AS n FROM hd_assets WHERE provider = $1", [INTUNE])).rows[0].n as number;
    assert.ok(before >= 4);
    const off = await assets.saveAssetSettings({ intune: false });
    assert.deepEqual(off.changed, ["intune_off"]);
    assert.equal((await assets.getAssetSettings()).intune?.on, false);
    const left = (await pool().query("SELECT a.id FROM hd_assets a WHERE a.provider = $1", [INTUNE])).rows.map((r) => r.id as number);
    const linked = (await pool().query("SELECT DISTINCT asset_id FROM hd_ticket_assets WHERE asset_id = ANY($1)", [left])).rows.map((r) => r.asset_id as number);
    assert.deepEqual(left.sort(), linked.sort(), "only linked devices are left");
    assert.ok(left.includes(phoneId));
    assert.equal((await pool().query("SELECT 1 FROM settings WHERE key = $1", [`helpdesk_assets_sync:${INTUNE}`])).rowCount, 0);
  });

  test("the card keeps the linked device as history (its own Intune line), unlinkable; Snipe-IT assets lose the Intune line", async () => {
    const v = await assets.ticketAssetsView((await ticketOf(t.id))!);
    assert.equal(v.can_edit, true, "Snipe-IT is still connected");
    const phone = v.assets.find((a) => a.id === phoneId)!;
    assert.equal(phone.intune?.compliance, "noncompliant");
    const macId = await idOf(SNIPE, "421");
    assert.equal((await assets.getAsset(macId))!.intune, null);
    const o = await assets.assetOptions(agentUser(), (await ticketOf(t.id))!, "");
    assert.deepEqual(o.assigned.map((x) => x.provider_label), ["Snipe-IT"], "only Snipe-IT's MacBook is offered");
    const r = await call(ticketAssetRoute.DELETE, req(`/tickets/${t.number}/assets/${phoneId}`, P.agent.session, undefined, "DELETE"), { number: String(t.number), assetId: String(phoneId) });
    assert.equal(r.status, 200, r.text);
    await assets.linkAsset(agentUser(), (await ticketOf(t.id))!, phoneId, actor()).catch(() => {});
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_ticket_assets WHERE ticket_id = $1 AND asset_id = $2", [t.id, phoneId])).rows[0].n, 0, "and can't be linked back");
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id, linked_by_name) VALUES ($1, $2, 'test')", [t.id, phoneId]);
  });

  test("search finds the linked device only; Get help shows Snipe-IT's only", async () => {
    assert.deepEqual((await assets.searchAssets(agentUser(), `F2L${TAGP}`)).rows.map((r) => r.id), [phoneId]);
    assert.deepEqual((await assets.searchAssets(agentUser(), `PF${TAGP}`)).rows, []);
    const page = await call(assetRoute.GET, req(`/assets/${phoneId}`, P.agent.session), { id: String(phoneId) });
    assert.equal(page.status, 200);
    assert.match(page.body.notice, /Intune isn't connected now/);
    const mine = await assets.myAssets({ id: P.req.id });
    assert.deepEqual(mine.map((a) => a.name), ["MacBook Pro 14 (2024)"]);
  });

  test("the sweep leaves Intune alone while it's off", async () => {
    graph.seen.length = 0;
    await assets.assetsSweep();
    assert.equal(graph.seen.filter((x) => x.host === "graph.microsoft.com").length, 0);
  });
});

// --- Review: personal data in the cache -----------------------------------------------------------

describe("the cache forgets people it no longer needs (review: personal data)", () => {
  const ins = async (provider: string, ext: string, gone: boolean) =>
    (
      await pool().query(
        `INSERT INTO hd_assets (provider, external_id, name, assigned_email, assigned_upn, assigned_name, gone_at)
         VALUES ($1, $2, 'Device', 'p@acme.example', 'p@acme.example', 'Pat Person', ${gone ? "now()" : "NULL"}) RETURNING id`,
        [provider, ext]
      )
    ).rows[0].id as number;
  const row = async (id: number) => (await pool().query("SELECT assigned_email, assigned_upn, assigned_name FROM hd_assets WHERE id = $1", [id])).rows[0];
  const FOREIGN = `snipeit:other-${STAMP}:retired:3`;
  after(async () => {
    await pool().query("DELETE FROM hd_assets WHERE provider = $1", [FOREIGN]);
    assets.setAssetSettingsForTests(SETTINGS());
  });

  test("the sweep: retired and switched-off unlinked rows go; retired or gone linked rows lose their person; other keys are untouched", async () => {
    assets.setAssetSettingsForTests(SETTINGS());
    const t = await ticket("Cleanup");
    const retiredUnlinked = await ins(`${SNIPE}:retired:1`, "r1", true);
    const retiredLinked = await ins(`${INTUNE}:retired:2`, "r2", true);
    const goneLinked = await ins(INTUNE, `gone-${STAMP}`, true);
    const liveLinked = await ins(SNIPE, `live-${STAMP}`, false);
    const foreign = await ins(FOREIGN, "f1", true);
    for (const id of [retiredLinked, goneLinked, liveLinked]) await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2)", [t.id, id]);
    const r = await assets.assetCleanup();
    assert.ok(r.deleted >= 1 && r.blanked >= 2, JSON.stringify(r));
    assert.equal(await row(retiredUnlinked), undefined);
    assert.deepEqual(await row(retiredLinked), { assigned_email: "", assigned_upn: "", assigned_name: "" });
    assert.deepEqual(await row(goneLinked), { assigned_email: "", assigned_upn: "", assigned_name: "" });
    assert.equal((await row(liveLinked)).assigned_name, "Pat Person", "a live device keeps its person");
    assert.equal((await row(foreign)).assigned_name, "Pat Person", "another workspace key's rows are never touched");
    // Intune switched off: its unlinked rows go at the next sweep.
    const offUnlinked = await ins(INTUNE, `off-${STAMP}`, false);
    assets.setAssetSettingsForTests(SETTINGS(false));
    await assets.assetCleanup();
    assert.equal(await row(offUnlinked), undefined);
    assert.ok(await row(goneLinked), "linked rows stay");
  });

  test("anonymising the last ticket of a retired or gone device deletes it; one still linked elsewhere stays", async () => {
    const a = await ticket("Anon A");
    const b = await ticket("Anon B");
    const onlyA = await ins(`${INTUNE}:retired:4`, "a1", true);
    const both = await ins(INTUNE, `both-${STAMP}`, true);
    const live = await ins(SNIPE, `alive-${STAMP}`, false);
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2), ($1, $3), ($4, $3), ($1, $5)", [a.id, onlyA, both, b.id, live]);
    await withTx((client) => assets.anonymiseTicketAssetsTx(client as never, a.id));
    assert.equal(await row(onlyA), undefined, "nothing could show or refresh it again");
    assert.ok(await row(both), "still on ticket B");
    assert.ok(await row(live), "a live device stays in the cache");
  });
});

// --- Another tenant ---------------------------------------------------------------------------

describe("Intune: the tenant the credentials sign in to is the source (review: tenant identity, concurrency)", () => {
  const OTHER = `other-${STAMP}.onmicrosoft.com`;
  const intuneRows = async () => (await pool().query("SELECT count(*)::int AS n FROM hd_assets WHERE provider = $1", [INTUNE])).rows[0].n as number;
  const changedAudits = async () =>
    (await pool().query("SELECT id, actor_id, details FROM audit_log WHERE action = 'helpdesk.assets.intune_source_changed' AND target_label = 'Assets: Microsoft Intune' AND at > now() - interval '5 minutes' ORDER BY id")).rows;
  let auditBase = 0;

  before(async () => {
    graph.tenants.set(OTHER, OTHER_TID);
    auditBase = (await changedAudits()).length;
  });
  async function fresh() {
    assets.setIntuneCredentialsForTests(CREDS);
    assets.setAssetSettingsForTests(SETTINGS());
    intune.setIntunePagingForTests(null);
    graph.pageDelayMs = 0;
    const r = await assets.syncProvider(INTUNE, { force: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok((await intuneRows()) >= 4);
  }
  after(async () => {
    assets.setIntuneCredentialsForTests(CREDS);
    assets.setAssetSettingsForTests(SETTINGS());
    graph.pageDelayMs = 0;
    intune.setIntunePagingForTests(null);
    // The system's own audit rows (no actor) from this suite.
    const rows = (await changedAudits()).slice(auditBase);
    if (rows.length) await pool().query("DELETE FROM audit_log WHERE id = ANY($1)", [rows.map((r) => r.id)]);
  });

  test("the same tenant typed as its GUID: paused until signed in, then recorded; nothing retired", async () => {
    await fresh();
    const n = await intuneRows();
    assets.setIntuneCredentialsForTests({ ...CREDS, tenant: TID });
    assert.equal(await assets.providerFor(INTUNE), null, "new credentials: not used until checked");
    const r = await assets.intuneSourceCheck();
    assert.deepEqual(r && { changed: r.changed, retired: r.retired, to: r.to }, { changed: false, retired: 0, to: TID });
    assert.equal(await intuneRows(), n, "no device retired");
    assert.equal((await assets.getAssetSettings()).intune?.cred_tag, assets.credTag({ ...CREDS, tenant: TID }));
    assert.ok(await assets.providerFor(INTUNE));
    assert.equal((await changedAudits()).length, auditBase, "no tenant change audited");
  });

  test("a typo that can't sign in: nothing retired or recorded, the card says why; fixing it changes nothing", async () => {
    await fresh();
    const n = await intuneRows();
    assets.setIntuneCredentialsForTests({ ...CREDS, tenant: `typo-${STAMP}.onmicrosoft.com` });
    assert.equal(await assets.intuneSourceCheck(), null);
    assert.equal(await intuneRows(), n);
    assert.equal((await assets.getAssetSettings()).intune?.cache_source, TID);
    assert.equal(await assets.providerFor(INTUNE), null);
    assert.match((await assets.assetSettingsView()).intune.check_error, /refused the Intune app registration's sign-in/);
    assets.setIntuneCredentialsForTests(CREDS);
    assert.equal(await assets.intuneSourceCheck(), null, "the original credentials were never replaced");
    assert.equal(await intuneRows(), n);
    assert.equal((await assets.assetSettingsView()).intune.check_error, "");
  });

  test("really another tenant: retired once, even when checks race (page polls, other instances); audited once", async () => {
    await fresh();
    const t = await ticket("Old tenant device");
    const macIntune = await idOf(INTUNE, `mac-${STAMP}`);
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id, linked_by_name) VALUES ($1, $2, 'test') ON CONFLICT DO NOTHING", [t.id, macIntune]);
    assets.setIntuneCredentialsForTests({ ...CREDS, tenant: OTHER });
    const results = await Promise.all([assets.intuneSourceCheck(), assets.intuneSourceCheck(), assets.intuneSourceCheck()]);
    const did = results.filter((r) => r?.changed);
    assert.equal(did.length, 1, JSON.stringify(results));
    assert.deepEqual({ from: did[0]!.from, to: did[0]!.to }, { from: TID, to: OTHER_TID });
    assert.equal(await intuneRows(), 0, "the old tenant's unlinked rows are gone");
    const kept = (await pool().query("SELECT provider, gone_at FROM hd_assets WHERE id = $1", [macIntune])).rows[0];
    assert.match(kept.provider, new RegExp(`^${INTUNE}:retired:\\d+$`));
    assert.ok(kept.gone_at);
    assert.equal((await assets.getAssetSettings()).intune?.cache_source, OTHER_TID);
    const audits = (await changedAudits()).slice(auditBase);
    assert.equal(audits.length, 1, "one audit entry");
    assert.equal(audits[0].actor_id, null);
    assert.equal(audits[0].details.linked_assets_retired, did[0]!.retired);
    auditBase += 1;
    const err = await assets.linkAsset(agentUser(), (await ticketOf((await ticket("Again")).id))!, macIntune, actor()).catch((e) => e);
    assert.match(err.message, /has since been replaced/);
  });

  test("a sync of the old tenant still paging when the tenant changes writes none of its devices into the new source", async () => {
    await fresh();
    intune.setIntunePagingForTests({ page: 1, maxPages: 50 });
    graph.pageDelayMs = 150;
    const pagesBefore = graph.seen.filter((x) => x.path.startsWith("/v1.0/deviceManagement/managedDevices?")).length;
    const run = assets.syncProvider(INTUNE, { force: true });
    // Wait until it is mid-way (two pages asked for).
    for (let i = 0; i < 100 && graph.seen.filter((x) => x.path.startsWith("/v1.0/deviceManagement/managedDevices?")).length < pagesBefore + 2; i++) await new Promise((r) => setTimeout(r, 30));
    assets.setIntuneCredentialsForTests({ ...CREDS, tenant: OTHER });
    const r = await assets.intuneSourceCheck();
    assert.equal(r?.changed, true);
    auditBase += 1;
    const res = await run;
    assert.equal(res.ok, false);
    assert.match(res.error!, /Another sync took over/);
    assert.equal(await intuneRows(), 0, "no old-tenant device came back as the new tenant's");
  });

  test("a whole Snipe-IT save never puts back Intune's old tenant (its part is written apart)", async () => {
    // Real stored settings: one writer at a time, restored after.
    const db = await pool().connect();
    try {
      await db.query("SELECT pg_advisory_lock(hashtext('helpdesk_assets_settings_test'))");
      const saved = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_assets'")).rows[0]?.value as string | undefined;
      assets.setAssetSettingsForTests(null);
      try {
        await db.query("INSERT INTO settings (key, value) VALUES ('helpdesk_assets', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
          JSON.stringify({ snipeit: { url: "", key: "", on_solve: "nothing" }, agents_search_all: true, cache_source: "", intune: { on: false, cache_source: "old-tid", cred_tag: "x" } }),
        ]);
        const stale = await assets.getAssetSettings();
        // Meanwhile Intune's part moves on (another request, another instance).
        await db.query(`UPDATE settings SET value = jsonb_set(value::jsonb, '{intune}', '{"on": false, "cache_source": "new-tid", "cred_tag": "y"}')::text WHERE key = 'helpdesk_assets'`);
        void stale;
        await assets.saveAssetSettings({ agents_search_all: false });
        const now = JSON.parse((await db.query("SELECT value FROM settings WHERE key = 'helpdesk_assets'")).rows[0].value);
        assert.equal(now.intune.cache_source, "new-tid");
        assert.equal(now.agents_search_all, false);
      } finally {
        if (saved === undefined) await db.query("DELETE FROM settings WHERE key = 'helpdesk_assets'");
        else await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_assets'", [saved]);
        assets.setAssetSettingsForTests(SETTINGS());
      }
    } finally {
      await db.query("SELECT pg_advisory_unlock(hashtext('helpdesk_assets_settings_test'))");
      db.release();
    }
  });

  test("back on the first tenant, the sweep syncs both sources", async () => {
    assets.setIntuneCredentialsForTests(CREDS);
    assets.setAssetSettingsForTests(SETTINGS());
    graph.pageDelayMs = 0;
    intune.setIntunePagingForTests(null);
    await pool().query("DELETE FROM settings WHERE key = ANY($1)", [[`helpdesk_assets_sync:${SNIPE}`, `helpdesk_assets_sync:${INTUNE}`]]);
    const r = await assets.assetsSweep();
    assert.equal(r.length, 2, JSON.stringify(r));
    assert.ok(r.every((x) => x.ran && x.ok), JSON.stringify(r));
  });
});
