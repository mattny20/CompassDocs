// Helpdesk 1.19.0, machine intake (agent P), against the database: the
// integrations admin API (create with the key shown once, list, update,
// rotate, delete, test alert, deliveries, audit); the intake endpoint's
// gates (bad key 401, turned off 403, unlicensed 402, rate limit 429, body
// cap 413); each tool's fixture through the endpoint; the dedup flows
// (create, fired again, resolve, reopen, a new ticket when reopening is off,
// retries with one effect); the human-reply guard on auto-resolve;
// sanitising; automated email senders (accepted although auto-generated,
// subject dedup, SPF failure refused, other auto mail still dropped); no
// requester notices for automated tickets; the AlertDetails route.
//
// Fixtures are this file's own (a stamped team, accounts and
// integrations), so it runs beside the other files on the shared database.
// Global settings are never written. next/headers resolves to a stub
// serving the request under test and lib/ee to one that grants "helpdesk"
// (the licence test takes it away), as in test/helpdesk-channels.test.ts.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-intake.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";
import { pool, getSetting, createSession } from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- Request scope and licence stubs ----------------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-intake.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-intake.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
const edition = { present: true, features: ["helpdesk"] as string[] };
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
  ee.exports = {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const notifyMod = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const intake = require("../src/lib/helpdesk/intake/intake") as typeof import("../src/lib/helpdesk/intake/intake");
const integrations = require("../src/lib/helpdesk/intake/integrations") as typeof import("../src/lib/helpdesk/intake/integrations");
const ingestRoute = require("../src/app/api/helpdesk/intake/[integrationId]/route") as typeof import("../src/app/api/helpdesk/intake/[integrationId]/route");
const listRoute = require("../src/app/api/helpdesk/intake/integrations/route") as typeof import("../src/app/api/helpdesk/intake/integrations/route");
const oneRoute = require("../src/app/api/helpdesk/intake/integrations/[id]/route") as typeof import("../src/app/api/helpdesk/intake/integrations/[id]/route");
const rotateRoute = require("../src/app/api/helpdesk/intake/integrations/[id]/rotate/route") as typeof import("../src/app/api/helpdesk/intake/integrations/[id]/rotate/route");
const testRoute = require("../src/app/api/helpdesk/intake/integrations/[id]/test/route") as typeof import("../src/app/api/helpdesk/intake/integrations/[id]/test/route");
const deliveriesRoute = require("../src/app/api/helpdesk/intake/integrations/[id]/deliveries/route") as typeof import("../src/app/api/helpdesk/intake/integrations/[id]/deliveries/route");
const detailsRoute = require("../src/app/api/helpdesk/intake/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/intake/tickets/[number]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";
import type { HelpdeskOutgoingMail } from "../src/lib/helpdesk/email";

// --- Fixtures ---------------------------------------------------------------------

const STAMP = `hdintake-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = "Intake!Test12345";
let teamId = 0;
const U: Record<"admin" | "agent" | "req" | "plain", { id: number; email: string; session: string; name: string }> = {} as never;
const integrationIds: number[] = [];
const mail: HelpdeskOutgoingMail[] = [];
const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", "helpdesk-intake", name), "utf8");
const settle = () => new Promise((r) => setTimeout(r, 300));

function sessionRequest(url: string, session: string | null, body?: unknown, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.88", "user-agent": "IntakeTest/1.0" };
  if (session) headers.cookie = `compass_session=${session}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function call<P>(handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>, req: Request, params: P) {
  currentRequest = req;
  try {
    const res = await handler(req, { params: Promise.resolve(params) });
    const type = res.headers.get("content-type") ?? "";
    const body = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, body: body as any, headers: res.headers };
  } finally {
    currentRequest = null;
  }
}

async function callNoParams(handler: (req: Request) => Promise<Response>, req: Request) {
  return call(handler as never, req, {} as never);
}

/** POST to the intake endpoint as a tool would (no session). */
async function post(id: number, body: unknown, key: string | null, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (key) headers.authorization = `Bearer ${key}`;
  const req = new Request(`http://localhost/api/helpdesk/intake/${id}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return call(ingestRoute.POST, req, { integrationId: String(id) });
}

/** Create an integration through the admin API; returns its id and key. */
async function makeIntegration(over: Record<string, unknown>): Promise<{ id: number; key: string }> {
  const r = await callNoParams(listRoute.POST, sessionRequest("http://localhost/api/helpdesk/intake/integrations", U.admin.session, {
    name: `${STAMP} ${over.kind}`,
    default_team_id: teamId,
    ...over,
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  integrationIds.push(r.body.integration.id);
  return { id: r.body.integration.id, key: r.body.key };
}

const ticketByNumber = async (n: number) => (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [n])).rows[0];
const messagesOf = async (ticketId: number) => (await pool().query("SELECT * FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows;
const auditOf = async (action: string, targetId: number) =>
  (await pool().query("SELECT * FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id", [action, String(targetId)])).rows;

function inboundEmail(over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    provider: "generic",
    from: { email: `${STAMP}-monitor@example.test`, name: "Backup monitor" },
    to: [{ email: `${STAMP}-help@example.test`, name: "" }],
    cc: [],
    recipients: [],
    subject: "[FIRING:1] Backup job 4412 failed on fs-01",
    text: "Job nightly exited with code 2.",
    html: "",
    stripped: "",
    messageId: `${newToken()}@mail.example.test`,
    inReplyTo: "",
    references: [],
    headers: { "auto-submitted": "auto-generated", precedence: "bulk" },
    // The provider's verdict: the monitoring domain passed DMARC.
    auth: { dmarc: "pass" },
    files: [],
    ...over,
  };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  await integrations.ensureIntakeSchema();
  const creds = hashPassword(PASSWORD);
  const names = { admin: "Ada Admin", agent: "Priya Shah", req: "Matthew Felix", plain: "Ben Lo" };
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const [k, name] of Object.entries(names) as [keyof typeof U, string][]) {
    const mailAddr = `${STAMP}-${k}@example.test`;
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status, password_hash, password_salt) VALUES ($1, $2, $3, 'viewer', 'active', $4, $5) RETURNING id`,
      [`${STAMP}-${k}`, name, mailAddr, creds.hash, creds.salt]
    );
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[k] = { id: r.rows[0].id, email: mailAddr, session, name };
  }
  const assign = async (user: number, role: string) =>
    fixtureQuery(`INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = $2`, [user, role]);
  await assign(U.agent.id, "helpdesk-agent");
  await assign(U.admin.id, "helpdesk-agent");
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT (user_id) DO UPDATE SET role = 'admin'", [U.admin.id]);
  const t = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 990) RETURNING id", [`${STAMP} Ops`]);
  teamId = t.rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent')", [teamId, U.agent.id]);
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push(m);
  });
  intake.resetIntakeLimitsForTests();
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  const userIds = Object.values(U).map((u) => u.id);
  const tickets = (
    await pool().query("SELECT id FROM hd_tickets WHERE team_id = $1 OR integration_id = ANY($2) OR requester_id = ANY($3)", [teamId, integrationIds, userIds])
  ).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [tickets]);
  await pool().query("DELETE FROM hd_integrations WHERE id = ANY($1)", [integrationIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = $1", [teamId]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE (target_type = 'helpdesk_integration' AND target_id = ANY($1)) OR actor_id = ANY($2)", [integrationIds.map(String), userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Admin API ------------------------------------------------------------------------

describe("integrations admin", () => {
  test("create shows the key once and stores only its hash; list never returns it; audited", async () => {
    const r = await callNoParams(listRoute.POST, sessionRequest("http://localhost/api/helpdesk/intake/integrations", U.admin.session, {
      kind: "grafana",
      name: `${STAMP} Monitoring`,
      default_team_id: teamId,
    }));
    assert.equal(r.status, 201);
    integrationIds.push(r.body.integration.id);
    const key: string = r.body.key;
    assert.match(key, /^cdhk_/);
    assert.equal(r.body.integration.endpoint_path, `/api/helpdesk/intake/${r.body.integration.id}`);
    const row = (await pool().query("SELECT * FROM hd_integrations WHERE id = $1", [r.body.integration.id])).rows[0];
    assert.equal(row.token_hash, integrations.hashKey(key));
    assert.notEqual(row.token_hash, key);
    assert.equal(JSON.stringify(row).includes(key), false, "the key is not stored");
    assert.deepEqual(row.severity_map, { critical: "urgent", high: "high", warning: "normal", info: "low" });
    const list = await callNoParams(listRoute.GET, sessionRequest("http://localhost/api/helpdesk/intake/integrations", U.admin.session, undefined, "GET"));
    assert.equal(list.status, 200);
    assert.equal(JSON.stringify(list.body).includes(key), false);
    assert.equal(JSON.stringify(list.body).includes(row.token_hash), false);
    assert.ok(list.body.integrations.some((i: any) => i.id === row.id && i.team_name === `${STAMP} Ops`));
    const audits = await auditOf("helpdesk.integration.created", row.id);
    assert.equal(audits.length, 1);
    assert.equal(JSON.stringify(audits[0]).includes(key), false, "the audit row never carries the key");
  });

  test("only channels.manage (or settings.manage) may configure integrations", async () => {
    const agent = await callNoParams(listRoute.GET, sessionRequest("http://localhost/api/helpdesk/intake/integrations", U.agent.session, undefined, "GET"));
    assert.equal(agent.status, 403);
    const plain = await callNoParams(listRoute.POST, sessionRequest("http://localhost/api/helpdesk/intake/integrations", U.plain.session, { kind: "api", name: "x" }));
    assert.equal(plain.status, 403);
    const anon = await callNoParams(listRoute.GET, sessionRequest("http://localhost/api/helpdesk/intake/integrations", null, undefined, "GET"));
    assert.equal(anon.status, 401);
  });

  test("validation: kind, name, sender addresses for email, a valid pattern", async () => {
    const bad = async (body: Record<string, unknown>) =>
      (await callNoParams(listRoute.POST, sessionRequest("http://localhost/api/helpdesk/intake/integrations", U.admin.session, body))).status;
    assert.equal(await bad({ kind: "nagios", name: "x" }), 400);
    assert.equal(await bad({ kind: "api", name: "" }), 400);
    assert.equal(await bad({ kind: "email", name: "x" }), 400);
    assert.equal(await bad({ kind: "email", name: "x", sender_addresses: ["a@b.test"], subject_dedup_pattern: "(" }), 400);
    assert.equal(await bad({ kind: "api", name: "x", severity_map: { critical: "panic" } }), 400);
    assert.equal(await bad({ kind: "api", name: "x", dedup_window_minutes: -1 }), 400);
  });

  test("update, rotate (old key stops at once) and delete are audited; tickets survive a delete", async () => {
    const { id, key } = await makeIntegration({ kind: "api" });
    const patch = await call(oneRoute.PATCH, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}`, U.admin.session, { name: `${STAMP} Renamed`, default_priority: "high" }, "PATCH"), { id: String(id) });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.integration.default_priority, "high");
    const upd = await auditOf("helpdesk.integration.updated", id);
    assert.deepEqual(upd[0].details.changed.sort(), ["default_priority", "name"]);
    assert.equal((await post(id, { title: `${STAMP} before rotate` }, key)).status, 200);
    const rot = await call(rotateRoute.POST, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}/rotate`, U.admin.session), { id: String(id) });
    assert.equal(rot.status, 200);
    assert.notEqual(rot.body.key, key);
    assert.equal((await post(id, { title: `${STAMP} old key` }, key)).status, 401);
    assert.equal((await post(id, { title: `${STAMP} new key` }, rot.body.key)).status, 200);
    const rotAudit = await auditOf("helpdesk.integration.key_rotated", id);
    assert.equal(rotAudit.length, 1);
    assert.equal(JSON.stringify(rotAudit).includes(rot.body.key), false);
    const ticketsBefore = (await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE integration_id = $1", [id])).rows[0].n;
    assert.equal(ticketsBefore, 2);
    const del = await call(oneRoute.DELETE, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}`, U.admin.session, undefined, "DELETE"), { id: String(id) });
    assert.equal(del.status, 200);
    assert.equal((await auditOf("helpdesk.integration.deleted", id)).length, 1);
    assert.equal((await pool().query("SELECT 1 FROM hd_integrations WHERE id = $1", [id])).rowCount, 0);
    // The tickets stay (unlinked); they are this file's team's, cleaned up after.
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE team_id = $1 AND subject LIKE $2", [teamId, `${STAMP} %key%`])).rows[0].n, 1);
  });
});

// --- Gates ------------------------------------------------------------------------------

describe("intake endpoint gates", () => {
  let id = 0;
  let key = "";
  before(async () => {
    ({ id, key } = await makeIntegration({ kind: "webhook_generic", rate_limit_per_minute: 3 }));
  });

  test("bad, missing and foreign keys are 401 (and logged, audited once)", async () => {
    intake.resetIntakeLimitsForTests();
    assert.equal((await post(id, { title: "x" }, "cdhk_wrong")).status, 401);
    assert.equal((await post(id, { title: "x" }, null)).status, 401);
    assert.equal((await post(999_999_999, { title: "x" }, key)).status, 401, "an unknown id answers the same");
    assert.equal((await post(id, { title: "x" }, "cdhk_wrong2")).status, 401);
    const rejected = await auditOf("helpdesk.intake.rejected", id);
    assert.equal(rejected.filter((r) => r.details.reason === "bad_key").length, 1, "throttled to one per reason");
    assert.equal(JSON.stringify(rejected).includes("cdhk_wrong"), false, "keys are never logged");
    const del = await integrations.listDeliveries(id);
    assert.ok(del.some((d) => d.status_code === 401 && d.outcome === "rejected"));
  });

  test("the key also works as X-Api-Key and ?key= (for tools that can't set Authorization)", async () => {
    intake.resetIntakeLimitsForTests();
    const r1 = await post(id, { title: `${STAMP} header key`, dedup_key: "hk" }, null, { "x-api-key": key });
    assert.equal(r1.status, 200);
    const req = new Request(`http://localhost/api/helpdesk/intake/${id}?key=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `${STAMP} query key`, dedup_key: "qk" }) });
    assert.equal((await call(ingestRoute.POST, req, { integrationId: String(id) })).status, 200);
  });

  test("a turned-off integration is 403", async () => {
    intake.resetIntakeLimitsForTests();
    await call(oneRoute.PATCH, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}`, U.admin.session, { enabled: false }, "PATCH"), { id: String(id) });
    assert.equal((await post(id, { title: "x" }, key)).status, 403);
    assert.equal((await post(id, { title: "x" }, "cdhk_nope")).status, 401, "a wrong key is still 401");
    await call(oneRoute.PATCH, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}`, U.admin.session, { enabled: true }, "PATCH"), { id: String(id) });
    const upd = await auditOf("helpdesk.integration.updated", id);
    assert.deepEqual(upd.map((r) => r.details.enabled), [false, true]);
  });

  test("unlicensed is 402", async () => {
    edition.features = [];
    try {
      assert.equal((await post(id, { title: "x" }, key)).status, 402);
      const admin = await callNoParams(listRoute.GET, sessionRequest("http://localhost/api/helpdesk/intake/integrations", U.admin.session, undefined, "GET"));
      assert.equal(admin.status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });

  test("over the per-minute rate limit is 429", async () => {
    intake.resetIntakeLimitsForTests();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await post(id, { title: `${STAMP} rate ${i}`, dedup_key: "rate" }, key)).status);
    assert.deepEqual(codes, [200, 200, 200, 429]);
  });

  test("a body over 256 KB is 413; not JSON or not the shape is 400", async () => {
    intake.resetIntakeLimitsForTests();
    const big = JSON.stringify({ title: "big", description: "x".repeat(300 * 1024) });
    assert.equal((await post(id, big, key)).status, 413);
    intake.resetIntakeLimitsForTests();
    assert.equal((await post(id, "{not json", key)).status, 400);
    const shape = await post(id, { description: "no title" }, key);
    assert.equal(shape.status, 400);
    assert.match(shape.body.error, /title/);
  });
});

// --- Dedup flows ----------------------------------------------------------------------------

describe("dedup: create, fired again, resolve, reopen, retry", () => {
  let id = 0;
  let key = "";
  let number = 0;
  const KEY = `${STAMP}-disk`;
  before(async () => {
    ({ id, key } = await makeIntegration({ kind: "webhook_generic", name: `${STAMP} Monitoring` }));
    intake.resetIntakeLimitsForTests();
  });

  test("a firing alert opens an automated ticket: service requester, team, priority from severity, sanitised", async () => {
    mail.length = 0;
    const r = await post(id, {
      title: `${STAMP} Disk almost full on fs-02`,
      description: "Free space <b>below</b> 10%. <script>alert(1)</script> [runbook](javascript:alert(2))",
      severity: "critical",
      status: "firing",
      dedup_key: KEY,
      source: "fs-02",
      links: [{ label: "Dashboard", url: "https://grafana.example.test/d/1" }, { label: "Evil", url: "javascript:alert(3)" }],
      fields: { host: "fs-02", used: 91 },
    }, key);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, "created");
    number = r.body.ticket;
    const t = await ticketByNumber(number);
    assert.equal(t.automated, 1);
    assert.equal(t.integration_id, id);
    assert.equal(t.source, "alert");
    assert.equal(t.requester_id, null);
    assert.equal(t.requester_email, "");
    assert.equal(t.requester_name, `${STAMP} Monitoring (Webhook)`);
    assert.equal(t.team_id, teamId);
    assert.equal(t.priority, "urgent");
    assert.equal(t.source_ref.integration_kind, "webhook_generic");
    const msgs = await messagesOf(t.id);
    assert.equal(msgs.length, 1);
    assert.doesNotMatch(msgs[0].body, /<script|<b>|alert\(1\)/i);
    assert.doesNotMatch(msgs[0].body, /\]\(javascript/i, "no javascript: link survives (its text may)");
    assert.match(msgs[0].body, /Dashboard\]\(<https:\/\/grafana\.example\.test\/d\/1>\)/, "a link written as <url>, so it can't break out");
    const k = (await pool().query("SELECT * FROM hd_alert_keys WHERE integration_id = $1 AND dedup_key = $2", [id, KEY])).rows[0];
    assert.equal(k.count, 1);
    assert.equal(k.state, "firing");
    assert.deepEqual(k.links, [{ label: "Dashboard", url: "https://grafana.example.test/d/1" }]);
    assert.equal(k.fields.used, "91");
    await settle();
    assert.equal(mail.filter((m) => /hd_request|received/i.test(m.subject) && m.to === "").length, 0);
  });

  test("the same delivery retried has one effect", async () => {
    const body = { title: `${STAMP} Disk almost full on fs-02`, status: "firing", dedup_key: KEY, severity: "critical" };
    const a = await post(id, body, key, { "x-request-id": `${STAMP}-req-1` });
    const b = await post(id, body, key, { "x-request-id": `${STAMP}-req-1` });
    assert.equal(a.body.outcome, "updated");
    assert.equal(b.body.duplicate, true);
    assert.equal(b.body.outcome, "updated", "the retry answers what the first did");
    // Without a request id: the payload hash this minute.
    const raw = JSON.stringify({ ...body, fields: { n: STAMP } });
    const c = await post(id, raw, key);
    const d = await post(id, raw, key);
    assert.equal(c.body.duplicate, undefined);
    assert.equal(d.body.duplicate, true);
    const k = (await pool().query("SELECT count FROM hd_alert_keys WHERE integration_id = $1 AND dedup_key = $2", [id, KEY])).rows[0];
    assert.equal(k.count, 3, "two real repeats on top of the first");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE integration_id = $1", [id])).rows[0].n, 1);
  });

  test("firing again on the open ticket adds an internal 'Fired again (×N)' line, no new ticket", async () => {
    const t = await ticketByNumber(number);
    const msgs = await messagesOf(t.id);
    const again = msgs.filter((m) => /^Fired again/.test(m.body));
    assert.equal(again.length, 2);
    assert.ok(again.every((m) => m.kind === "internal" && m.author_id === null));
    assert.match(again[1].body, /×3/);
  });

  test("resolved: an internal note and the ticket is solved", async () => {
    const r = await post(id, { title: `${STAMP} Disk almost full on fs-02`, status: "resolved", dedup_key: KEY }, key);
    assert.equal(r.body.outcome, "resolved");
    const t = await ticketByNumber(number);
    assert.equal(t.status, "solved");
    const msgs = await messagesOf(t.id);
    assert.ok(msgs.some((m) => m.kind === "internal" && m.body === "Alert resolved."));
    const again = await post(id, { title: "x", status: "resolved", dedup_key: KEY }, key);
    assert.equal(again.body.outcome, "ignored");
    const unknown = await post(id, { title: "x", status: "resolved", dedup_key: `${STAMP}-never` }, key);
    assert.equal(unknown.body.outcome, "ignored");
  });

  test("firing again within the window reopens the solved ticket with a note", async () => {
    const r = await post(id, { title: `${STAMP} Disk almost full on fs-02`, status: "firing", dedup_key: KEY, fields: { again: 1 } }, key);
    assert.equal(r.body.outcome, "reopened");
    assert.equal(r.body.ticket, number);
    const t = await ticketByNumber(number);
    assert.equal(t.status, "open");
    assert.ok((await messagesOf(t.id)).some((m) => /reopened/.test(m.body) && m.kind === "internal"));
  });

  test("with reopening off (or past the window), a repeat after solving opens a new ticket that notes the old one", async () => {
    // (A different body from the earlier resolve: an identical one this minute is a retry.)
    await post(id, { title: "x", status: "resolved", dedup_key: KEY, fields: { round: 2 } }, key);
    assert.equal((await ticketByNumber(number)).status, "solved");
    await call(oneRoute.PATCH, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}`, U.admin.session, { reopen_on_repeat: false }, "PATCH"), { id: String(id) });
    const r = await post(id, { title: `${STAMP} Disk almost full on fs-02`, status: "firing", dedup_key: KEY, fields: { third: 1 } }, key);
    assert.equal(r.body.outcome, "created");
    assert.notEqual(r.body.ticket, number);
    const fresh = await ticketByNumber(r.body.ticket);
    assert.match((await messagesOf(fresh.id))[0].body, new RegExp(`fired before as #${number}`));
    const k = (await pool().query("SELECT ticket_id, count FROM hd_alert_keys WHERE integration_id = $1 AND dedup_key = $2", [id, KEY])).rows[0];
    assert.equal(k.ticket_id, fresh.id);
    assert.equal(k.count, 1);
  });

  test("a person's public reply keeps the ticket open when the alert resolves", async () => {
    const r = await post(id, { title: `${STAMP} VPN gateway down`, status: "firing", dedup_key: `${STAMP}-vpn` }, key);
    const t = await ticketByNumber(r.body.ticket);
    await messages.addMessage(t.id, { kind: "public", body: "Looking into it.", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" }, { silent: true });
    const res = await post(id, { title: "x", status: "resolved", dedup_key: `${STAMP}-vpn` }, key);
    assert.equal(res.body.outcome, "resolved");
    const after = await ticketByNumber(r.body.ticket);
    assert.notEqual(after.status, "solved");
    assert.ok((await messagesOf(t.id)).some((m) => m.body === "Alert resolved; ticket left open because a person replied."));
  });

  test("auto-resolve off: the note only", async () => {
    await call(oneRoute.PATCH, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}`, U.admin.session, { auto_resolve: false }, "PATCH"), { id: String(id) });
    const r = await post(id, { title: `${STAMP} Queue backlog`, status: "firing", dedup_key: `${STAMP}-queue` }, key);
    await post(id, { title: "x", status: "resolved", dedup_key: `${STAMP}-queue` }, key);
    const t = await ticketByNumber(r.body.ticket);
    assert.equal(t.status, "new");
    assert.ok((await messagesOf(t.id)).some((m) => m.body === "Alert resolved." && m.kind === "internal"));
  });

  test("the deliveries log lists outcomes, newest first", async () => {
    const r = await call(deliveriesRoute.GET, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}/deliveries`, U.admin.session, undefined, "GET"), { id: String(id) });
    assert.equal(r.status, 200);
    const outcomes = new Set(r.body.deliveries.map((d: any) => d.outcome));
    for (const o of ["created", "updated", "resolved", "reopened", "ignored"]) assert.ok(outcomes.has(o), o);
    assert.ok(r.body.deliveries[0].id > r.body.deliveries.at(-1).id);
    assert.ok(r.body.deliveries.some((d: any) => d.reason === "Duplicate delivery (a retry)."));
  });
});

// --- Adapters through the endpoint -------------------------------------------------------------

describe("each tool's payload through the endpoint", () => {
  test("Prometheus Alertmanager: one ticket for the firing alert, the unknown resolved one ignored", async () => {
    const { id, key } = await makeIntegration({ kind: "prometheus" });
    const r = await post(id, fixture("prometheus.json"), key);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((x: any) => x.outcome), ["created", "ignored"]);
    const t = await ticketByNumber(r.body.results[0].ticket);
    assert.equal(t.priority, "urgent");
    assert.equal(t.subject, "API error rate above 5% on api-01");
    const again = await post(id, fixture("prometheus.json").replace('"truncatedAlerts": 0', '"truncatedAlerts": 1'), key);
    assert.equal(again.body.results[0].outcome, "updated");
  });

  test("Grafana: a ticket with the dashboard links", async () => {
    const { id, key } = await makeIntegration({ kind: "grafana" });
    const r = await post(id, fixture("grafana.json"), key);
    assert.equal(r.body.outcome, "created");
    const k = (await pool().query("SELECT links FROM hd_alert_keys WHERE integration_id = $1", [id])).rows[0];
    assert.ok(k.links.some((l: any) => l.label === "Dashboard"));
    const t = await ticketByNumber(r.body.ticket);
    assert.equal(t.priority, "normal", "warning → normal");
    assert.equal(t.requester_name, `${STAMP} grafana`, "a name that already says Grafana is not repeated");
  });

  test("Datadog: triggered then recovered solves the ticket", async () => {
    const { id, key } = await makeIntegration({ kind: "datadog" });
    const r = await post(id, fixture("datadog.json"), key);
    assert.equal(r.body.outcome, "created");
    assert.equal((await ticketByNumber(r.body.ticket)).priority, "high");
    const rec = await post(id, fixture("datadog-recovered.json"), key);
    assert.equal(rec.body.outcome, "resolved");
    assert.equal((await ticketByNumber(r.body.ticket)).status, "solved");
  });

  test("Azure Monitor: Sev1 → high; the description's HTML is text", async () => {
    const { id, key } = await makeIntegration({ kind: "azure_monitor" });
    const r = await post(id, fixture("azure-monitor.json"), key);
    assert.equal(r.body.outcome, "created");
    const t = await ticketByNumber(r.body.ticket);
    assert.equal(t.priority, "high");
    assert.doesNotMatch((await messagesOf(t.id))[0].body, /<b>/);
  });

  test("PagerDuty-style: trigger then resolve", async () => {
    const { id, key } = await makeIntegration({ kind: "pagerduty_like", default_priority: "low" });
    const r = await post(id, fixture("pagerduty.json"), key);
    assert.equal(r.body.outcome, "created");
    const res = await post(id, fixture("pagerduty.json").replace('"trigger"', '"resolve"'), key);
    assert.equal(res.body.outcome, "resolved");
  });

  test("API kind: source 'api'; a named member makes it their request (not automated, they are notified)", async () => {
    const { id, key } = await makeIntegration({ kind: "api", name: `${STAMP} Onboarding bot` });
    const r = await post(id, { title: `${STAMP} Laptop for new starter`, description: "From the onboarding bot.", requester_email: U.req.email }, key);
    const t = await ticketByNumber(r.body.ticket);
    assert.equal(t.source, "api");
    assert.equal(t.automated, 0);
    assert.equal(t.requester_id, U.req.id);
    assert.equal(t.integration_id, id);
    await settle();
    const bell = await pool().query("SELECT 1 FROM notifications WHERE user_id = $1 AND link LIKE $2", [U.req.id, `%/help/requests/${t.number}%`]);
    assert.equal(bell.rowCount! > 0, true, "the person gets the usual receipt");
    const stranger = await post(id, { title: `${STAMP} For nobody`, requester_email: "nobody@nowhere.example.test" }, key);
    const s = await ticketByNumber(stranger.body.ticket);
    assert.equal(s.automated, 1);
    assert.equal(s.requester_id, null);
  });
});

// --- Requester notices ---------------------------------------------------------------------------

describe("automated tickets send no requester notices", () => {
  test("receipt, reply, solved and CSAT all skip an automated ticket", async () => {
    const { id, key } = await makeIntegration({ kind: "webhook_generic" });
    const r = await post(id, { title: `${STAMP} Printer offline`, dedup_key: `${STAMP}-printer` }, key);
    const t = await ticketByNumber(r.body.ticket);
    // Even pointed at a real account, an automated ticket notifies nobody as its requester.
    await pool().query("UPDATE hd_tickets SET requester_id = $2, requester_email = $3 WHERE id = $1", [t.id, U.req.id, U.req.email]);
    mail.length = 0;
    await notifyMod.notifyRequestReceived(t.id, {});
    const m = await messages.addMessage(t.id, { kind: "public", body: "Checked the printer.", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk", then_status: "pending" });
    assert.ok(m);
    await notifyMod.notifySolvedCsat(t.id, {});
    await settle();
    const rows = await pool().query("SELECT 1 FROM notifications WHERE user_id = $1 AND link LIKE $2", [U.req.id, `%/help/requests/${t.number}%`]);
    assert.equal(rows.rowCount, 0);
    assert.equal(mail.filter((x) => x.to === U.req.email).length, 0);
    // Control: the same ticket, not automated, does notify (so the flag is what stopped it).
    await pool().query("UPDATE hd_tickets SET automated = 0 WHERE id = $1", [t.id]);
    await notifyMod.notifyRequestReceived(t.id, {});
    await settle();
    const control = await pool().query("SELECT 1 FROM notifications WHERE user_id = $1 AND link LIKE $2", [U.req.id, `%/help/requests/${t.number}%`]);
    assert.ok(control.rowCount! > 0);
  });
});

// --- Automated email -------------------------------------------------------------------------------

describe("automated email senders", () => {
  let id = 0;
  const FROM = `${STAMP}-monitor@example.test`;
  before(async () => {
    ({ id } = await makeIntegration({ kind: "email", name: `${STAMP} Backups`, sender_addresses: [FROM.toUpperCase()] }));
  });

  test("an email integration has no key and no endpoint", async () => {
    const v = await integrations.getIntegrationView(id);
    assert.equal(v!.token_prefix, "");
    assert.equal(v!.endpoint_path, "");
    assert.deepEqual(v!.sender_addresses, [FROM]);
  });

  test("a listed sender's auto-generated mail opens an automated ticket; the subject is the title", async () => {
    const r = await inbound.processInboundEmail(inboundEmail(), { outsideSenders: false });
    assert.equal(r.body.outcome, "alert_created");
    const t = await ticketByNumber(r.body.ticket!);
    assert.equal(t.automated, 1);
    assert.equal(t.integration_id, id);
    assert.equal(t.source, "alert");
    assert.equal(t.subject, "[FIRING:1] Backup job 4412 failed on fs-01");
    const k = (await pool().query("SELECT dedup_key FROM hd_alert_keys WHERE integration_id = $1", [id])).rows[0];
    assert.equal(k.dedup_key, "backup job failed on fs");
  });

  test("the same mail again (a provider retry) is one effect; a new run of it is a repeat", async () => {
    const e = inboundEmail({ subject: "[FIRING:1] Backup job 4415 failed on fs-01" });
    const a = await inbound.processInboundEmail(e, { outsideSenders: false });
    const b = await inbound.processInboundEmail(e, { outsideSenders: false });
    assert.equal(a.body.outcome, "alert_updated");
    assert.equal(b.body.outcome, "alert_ignored");
  });

  test("[RESOLVED] with the same subject solves it", async () => {
    const r = await inbound.processInboundEmail(inboundEmail({ subject: "[RESOLVED] Backup job 4416 failed on fs-01" }), { outsideSenders: false });
    assert.equal(r.body.outcome, "alert_resolved");
    assert.equal((await ticketByNumber(r.body.ticket!)).status, "solved");
  });

  test("a failing SPF or DKIM verdict is refused, logged and audited", async () => {
    const r = await inbound.processInboundEmail(
      inboundEmail({ subject: "[FIRING:1] Forged alert", auth: undefined, headers: { "auto-submitted": "auto-generated", "authentication-results": "mx.example; spf=fail smtp.mailfrom=example.test; dkim=none" } }),
      { outsideSenders: false }
    );
    assert.equal(r.body.outcome, "alert_rejected");
    assert.equal(r.body.ticket, undefined);
    assert.equal((await pool().query("SELECT 1 FROM hd_alert_keys WHERE integration_id = $1 AND dedup_key = 'forged alert'", [id])).rowCount, 0);
    const audits = await auditOf("helpdesk.intake.rejected", id);
    assert.ok(audits.some((a) => a.details.reason === "email_auth"));
    const del = await integrations.listDeliveries(id);
    assert.match(del[0].reason, /SPF fail/);
  });

  test("a custom subject pattern picks the key", async () => {
    await call(oneRoute.PATCH, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}`, U.admin.session, { subject_dedup_pattern: "UPS (\\w+)" }, "PATCH"), { id: String(id) });
    const r = await inbound.processInboundEmail(inboundEmail({ subject: "UPS u7 on battery since 10:02" }), { outsideSenders: false });
    assert.equal(r.body.outcome, "alert_created");
    assert.equal((await pool().query("SELECT 1 FROM hd_alert_keys WHERE integration_id = $1 AND dedup_key = 'u7'", [id])).rowCount, 1);
  });

  test("auto-generated mail from anyone else is still dropped, and outside senders still refused", async () => {
    const auto = await inbound.processInboundEmail(inboundEmail({ from: { email: `${STAMP}-other@example.test`, name: "" } }), { outsideSenders: false });
    assert.equal(auto.body.outcome, "ignored_auto");
    const outside = await inbound.processInboundEmail(inboundEmail({ from: { email: `${STAMP}-other@example.test`, name: "" }, headers: {} }), { outsideSenders: false });
    assert.equal(outside.body.outcome, "rejected_outside_sender");
  });

  test("a turned-off email integration falls back to the normal rules", async () => {
    await call(oneRoute.PATCH, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}`, U.admin.session, { enabled: false }, "PATCH"), { id: String(id) });
    const r = await inbound.processInboundEmail(inboundEmail(), { outsideSenders: false });
    assert.equal(r.body.outcome, "ignored_auto");
  });
});

// --- The desk's views ---------------------------------------------------------------------------------

describe("desk views", () => {
  test("AlertDetails: an agent of the team reads the alert; others get 404/403", async () => {
    const { id, key } = await makeIntegration({ kind: "grafana", name: `${STAMP} Grafana` });
    const r = await post(id, fixture("grafana.json"), key);
    await post(id, fixture("grafana.json").replace('"orgId": 1', '"orgId": 2'), key);
    const d = await call(detailsRoute.GET, sessionRequest(`http://localhost/api/helpdesk/intake/tickets/${r.body.ticket}`, U.agent.session, undefined, "GET"), { number: String(r.body.ticket) });
    assert.equal(d.status, 200);
    assert.equal(d.body.automated, true);
    assert.equal(d.body.integration.kind, "grafana");
    assert.equal(d.body.alert.count, 2);
    assert.equal(d.body.alert.state, "firing");
    assert.equal(d.body.alert.fields.host, "fs-02");
    const plain = await call(detailsRoute.GET, sessionRequest(`http://localhost/api/helpdesk/intake/tickets/${r.body.ticket}`, U.plain.session, undefined, "GET"), { number: String(r.body.ticket) });
    assert.ok([403, 404].includes(plain.status));
  });

  test("Send a test alert opens a tagged ticket through the same pipeline", async () => {
    const { id } = await makeIntegration({ kind: "datadog" });
    const r = await call(testRoute.POST, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}/test`, U.admin.session), { id: String(id) });
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "created");
    const t = await ticketByNumber(r.body.ticket);
    assert.deepEqual(t.tags, ["test-alert"]);
    assert.equal(t.automated, 1);
    const agent = await call(testRoute.POST, sessionRequest(`http://localhost/api/helpdesk/intake/integrations/${id}/test`, U.agent.session), { id: String(id) });
    assert.equal(agent.status, 403);
  });

  test("the list counts distinct alerts of the last 24 hours", async () => {
    const list = await callNoParams(listRoute.GET, sessionRequest("http://localhost/api/helpdesk/intake/integrations", U.admin.session, undefined, "GET"));
    const prom = list.body.integrations.find((i: any) => i.name === `${STAMP} prometheus`);
    assert.equal(prom.alerts_24h, 1);
    assert.ok(prom.last_used_at);
  });
});
