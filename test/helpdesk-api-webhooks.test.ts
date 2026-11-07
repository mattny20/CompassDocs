// Helpdesk API tokens, the REST API and outgoing webhooks (1.19.4, area C2).
//
// What is pinned:
//   tokens    the format (cdh_ + 43 base64url), only a SHA-256 and the last
//             four kept, shown once; the service account can't sign in, holds
//             no helpdesk permission of its own, is in no people list and no
//             team; roles and teams limited to what the creator may hand out.
//   API       Bearer only (a session cookie is not a credential here); one
//             401 for missing / malformed / unknown / revoked / expired; 402
//             unlicensed; 404 the same for a missing ticket, one outside the
//             token's teams and one in the recycle bin; 403 for a change the
//             role may not make; failed-check and per-token rate limits;
//             cursor paging; internal notes only with the capability; a
//             newbie role's reply is held for review; every call audited
//             (reads throttled), writes "via API" on the timeline.
//   webhooks  signed with the hook's secret (X-CompassDocs-Signature
//             t=…,v1=HMAC("t.body")), queued after commit, team filter,
//             notes only when included, held replies only once approved,
//             retried with backoff then failed after 24 hours and the hook
//             turned off with a bell to admins, the log capped at 50, the
//             first 2 KB of the answer, redirects never followed, private
//             and plain-http endpoints refused, test send, secret rotation,
//             binned and anonymised tickets.
//
// Webhook receivers are in-process (a node:http server on 127.0.0.1 behind
// setWebhookTransportForTests); nothing leaves the machine.
//
// Parallel-safe: every team, account, token, webhook and ticket here is this
// file's own (STAMP) and removed in after(). Every webhook is filtered to
// this file's teams, so no other file's ticket reaches it. The role matrix
// is pinned in this process only (setRoleMatrixForTests).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-api-webhooks.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pool, getSetting, createSession, listUsers } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next ------------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.hd-api.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.hd-api.virtual.js");
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
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const shared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const hooks = require("../src/lib/helpdesk/webhooks") as typeof import("../src/lib/helpdesk/webhooks");
const tokens = require("../src/lib/helpdesk/api-tokens") as typeof import("../src/lib/helpdesk/api-tokens");
const apiV1 = require("../src/lib/helpdesk/api-v1") as typeof import("../src/lib/helpdesk/api-v1");
const safe = require("../src/lib/safe-fetch") as typeof import("../src/lib/safe-fetch");
const adminRoute = require("../src/app/api/helpdesk/admin/api/route") as typeof import("../src/app/api/helpdesk/admin/api/route");
const tokensRoute = require("../src/app/api/helpdesk/admin/api/tokens/route") as typeof import("../src/app/api/helpdesk/admin/api/tokens/route");
const tokenRoute = require("../src/app/api/helpdesk/admin/api/tokens/[id]/route") as typeof import("../src/app/api/helpdesk/admin/api/tokens/[id]/route");
const hooksRoute = require("../src/app/api/helpdesk/admin/api/webhooks/route") as typeof import("../src/app/api/helpdesk/admin/api/webhooks/route");
const hookRoute = require("../src/app/api/helpdesk/admin/api/webhooks/[id]/route") as typeof import("../src/app/api/helpdesk/admin/api/webhooks/[id]/route");
const rotateRoute = require("../src/app/api/helpdesk/admin/api/webhooks/[id]/rotate/route") as typeof import("../src/app/api/helpdesk/admin/api/webhooks/[id]/rotate/route");
const testRoute = require("../src/app/api/helpdesk/admin/api/webhooks/[id]/test/route") as typeof import("../src/app/api/helpdesk/admin/api/webhooks/[id]/test/route");
const deliveriesRoute = require("../src/app/api/helpdesk/admin/api/webhooks/[id]/deliveries/route") as typeof import("../src/app/api/helpdesk/admin/api/webhooks/[id]/deliveries/route");
const meRoute = require("../src/app/api/helpdesk/v1/me/route") as typeof import("../src/app/api/helpdesk/v1/me/route");
const ticketsRoute = require("../src/app/api/helpdesk/v1/tickets/route") as typeof import("../src/app/api/helpdesk/v1/tickets/route");
const ticketRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/route");
const notesRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/notes/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/notes/route");
const repliesRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/replies/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/replies/route");
const approvalsRoute = require("../src/app/api/helpdesk/v1/approvals/route") as typeof import("../src/app/api/helpdesk/v1/approvals/route");
const reportRoute = require("../src/app/api/helpdesk/v1/reports/summary/route") as typeof import("../src/app/api/helpdesk/v1/reports/summary/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";

// --- Calls ----------------------------------------------------------------------------

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Answer {
  status: number;
  body: any;
  headers: Headers;
}

let ipSeq = 10;
/** A fresh documentation-range address per test that counts failed checks. */
const freshIp = () => `198.51.100.${ipSeq++}`;
const CLIENT_IP = "203.0.113.77";
/** An expiry date two years out (the cap is five). */
const SOON = new Date(Date.now() + 2 * 365 * 86_400_000).toISOString().slice(0, 10);

async function run(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<Answer> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* none */
    }
    return { status: res.status, body: json, headers: res.headers };
  } finally {
    currentRequest = null;
  }
}

/** A desk-settings call as a signed-in person (session cookie). */
function asPerson(handler: unknown, who: string, url: string, method = "GET", body?: unknown, params: Record<string, string> = {}) {
  return run(
    handler,
    new Request(`http://localhost${url}`, {
      method,
      headers: { cookie: `compass_session=${P[who].session}`, "content-type": "application/json", "x-forwarded-for": CLIENT_IP },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params
  );
}

/** A REST API call with a Bearer token (or none). */
function api(handler: unknown, token: string | null, url: string, method = "GET", body?: unknown, params: Record<string, string> = {}, extra: Record<string, string> = {}) {
  return run(
    handler,
    new Request(`http://localhost/api/helpdesk/v1${url}`, {
      method,
      headers: {
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        "x-forwarded-for": extra.ip ?? CLIENT_IP,
        ...(extra.cookie ? { cookie: extra.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params
  );
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdapi-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  name: string;
  email: string;
  session: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const ticketIds: number[] = [];
const tokenIds: number[] = [];
const hookIds: number[] = [];
let T1 = 0;
let T2 = 0;

async function person(key: string, name: string): Promise<Person> {
  const email = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, 'viewer', 'active', 'UTC') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    email,
  ]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  P[key] = { id, name, email, session };
  return P[key];
}

async function deskRole(userId: number, role: HdRole) {
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [userId, role]);
}
async function member(teamId: number, userId: number) {
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent') ON CONFLICT DO NOTHING", [teamId, userId]);
}

async function newTicket(subject: string, teamId: number | null, tags: string[] = []) {
  const r = await fixtureQuery(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, tags)
     VALUES ($1, $2, $3, $4, $5, 'open', $6) RETURNING id, number`,
    [`${STAMP} ${subject}`, P.req.id, P.req.name, P.req.email, teamId, tags]
  );
  ticketIds.push(r.rows[0].id);
  await pool().query(
    "INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via) VALUES ($1, $2, $3, $4, 'public', $5, 'portal')",
    [r.rows[0].id, P.req.id, P.req.name, P.req.email, `Opening message of ${subject}`]
  );
  await pool().query(
    "INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via) VALUES ($1, $2, $3, $4, 'internal', $5, 'desk')",
    [r.rows[0].id, P.agent.id, P.agent.name, P.agent.email, `Secret note on ${subject}`]
  );
  return r.rows[0] as { id: number; number: number };
}

/** Make a token through the settings route, as the desk admin. */
async function makeToken(body: Record<string, unknown>): Promise<{ token: string; id: number; principal: number }> {
  const r = await asPerson(tokensRoute.POST, "dadmin", "/api/helpdesk/admin/api/tokens", "POST", body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  tokenIds.push(r.body.view.id);
  const row = await pool().query<{ principal_id: number }>("SELECT principal_id FROM hd_api_tokens WHERE id = $1", [r.body.view.id]);
  userIds.push(row.rows[0].principal_id);
  return { token: r.body.token, id: r.body.view.id, principal: row.rows[0].principal_id };
}

// --- The in-process receiver ---------------------------------------------------------

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
const received: Received[] = [];
/** path → what to answer (status, body, headers). Default 200 "ok". */
const answers = new Map<string, { status: number; body?: string; headers?: Record<string, string>; delayMs?: number }>();
let server: http.Server;
let port = 0;
const HOST = "https://hooks.example.test";

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
  hooks.setWebhookAutoSendForTests(false);
  for (const [k, n] of [
    ["req", "Rae Requester"],
    ["agent", "Ana Agent"],
    ["lead", "Lee Lead"],
    ["dadmin", "Dee Deskadmin"],
  ] as const) {
    await person(k, n);
  }
  T1 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9401) RETURNING id", [`${STAMP} IT`])).rows[0].id;
  T2 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9402) RETURNING id", [`${STAMP} HR`])).rows[0].id;
  await deskRole(P.agent.id, "agent");
  await deskRole(P.lead.id, "team_lead");
  await deskRole(P.dadmin.id, "admin");
  await member(T1, P.agent.id);
  await member(T1, P.lead.id);

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      const a = answers.get(req.url ?? "") ?? { status: 200, body: "ok" };
      setTimeout(() => {
        res.writeHead(a.status, { "content-type": "text/plain", ...(a.headers ?? {}) });
        res.end(a.body ?? "");
      }, a.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  hooks.setWebhookTransportForTests((url, init) => fetch(url.replace(HOST, `http://127.0.0.1:${port}`), { ...init, redirect: "manual" }));
  // The endpoint names resolve to a public address (only the transport above actually connects).
  safe.setSafeFetchResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  hooks.setWebhookAutoSendForTests(true);
  hooks.setWebhookTransportForTests(null);
  safe.setSafeFetchResolverForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
  await pool().query("DELETE FROM hd_webhooks WHERE id = ANY($1) OR name LIKE $2", [hookIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1) OR requester_id = ANY($2)", [ticketIds, userIds]);
  await pool().query("DELETE FROM hd_api_tokens WHERE id = ANY($1) OR name LIKE $2", [tokenIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[T1, T2]]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1) OR title LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

/** A webhook for this file's teams, made through the settings route. */
async function makeHook(name: string, body: Record<string, unknown>): Promise<{ id: number; secret: string }> {
  const r = await asPerson(hooksRoute.POST, "dadmin", "/api/helpdesk/admin/api/webhooks", "POST", { name: `${STAMP} ${name}`, team_ids: [T1], ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  hookIds.push(r.body.hook.id);
  return { id: r.body.hook.id, secret: r.body.secret };
}

const deliveries = async (hookId: number) =>
  (
    await pool().query<{ id: string; event: string; state: string; attempts: number; payload: any; response_status: number | null; error: string; response_excerpt: string; test: boolean }>(
      "SELECT id, event, state, attempts, payload, response_status, error, response_excerpt, test FROM hd_webhook_deliveries WHERE hook_id = $1 ORDER BY id",
      [hookId]
    )
  ).rows;

const receivedOn = (p: string) => received.filter((r) => r.path === p);

// --- Tokens ----------------------------------------------------------------------------

let agentTok = { token: "", id: 0, principal: 0 };
let newbieTok = { token: "", id: 0, principal: 0 };

describe("API tokens", () => {
  test("format, storage and the service account: shown once, hashed, can't sign in, in no list or team", async () => {
    agentTok = await makeToken({ name: `${STAMP} Jira sync`, shown_as: `${STAMP} Helpdesk bot`, role: "agent", team_ids: [T1], expires_at: null });
    assert.match(agentTok.token, /^cdh_[A-Za-z0-9_-]{43}$/);
    const row = (await pool().query("SELECT token_hash, last4 FROM hd_api_tokens WHERE id = $1", [agentTok.id])).rows[0];
    assert.equal(row.token_hash, tokens.hashApiToken(agentTok.token));
    assert.equal(row.last4, agentTok.token.slice(-4));
    const u = (await pool().query("SELECT status, password_hash, email, name FROM users WHERE id = $1", [agentTok.principal])).rows[0];
    assert.deepEqual([u.status, u.password_hash, u.email, u.name], ["service", null, "", `${STAMP} Helpdesk bot`]);
    assert.ok(!(await listUsers()).some((x) => x.id === agentTok.principal), "not in the people list");
    const tm = await pool().query("SELECT 1 FROM hd_team_members WHERE user_id = $1 UNION ALL SELECT 1 FROM hd_agent_roles WHERE user_id = $1", [agentTok.principal]);
    assert.equal(tm.rowCount, 0, "never a team member or an assigned desk role");
    // No workspace helpdesk permission of its own: the desk role comes only from the token.
    const { grantsFor, holds } = await import("../src/lib/authz");
    const g = await grantsFor(agentTok.principal);
    for (const k of ["helpdesk.agent", "helpdesk.agent_all", "helpdesk.admin", "helpdesk.reports"] as const) assert.equal(holds(g, k), false, k);
    const role = await roles.hdRoleOf({ id: agentTok.principal, role: "viewer" });
    assert.deepEqual(role, { role: "agent", source: "assigned" });
    // The settings list shows the hint, never the token.
    const list = await asPerson(adminRoute.GET, "dadmin", "/api/helpdesk/admin/api");
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes(agentTok.token));
    const view = list.body.tokens.find((t: any) => t.id === agentTok.id);
    assert.equal(view.hint, `cdh_…${agentTok.token.slice(-4)}`);
    assert.match(view.can, /^Read tickets · update status, priority, team and tags · add notes · reply$/);
    // The audit row names the token, never its value.
    const a = await pool().query("SELECT details::text AS d FROM audit_log WHERE action = 'helpdesk.api_token.created' AND target_id = $1", [String(agentTok.id)]);
    assert.equal(a.rowCount, 1);
    assert.ok(!a.rows[0].d.includes(agentTok.token));
    newbieTok = await makeToken({ name: `${STAMP} Intern bot`, role: "newbie", team_ids: [T1], expires_at: SOON });
  });

  test("only what the creator may hand out: no Admin, only their teams, a team needed; only settings.manage", async () => {
    const bad = async (body: Record<string, unknown>, status: number, re: RegExp, who = "dadmin") => {
      const r = await asPerson(tokensRoute.POST, who, "/api/helpdesk/admin/api/tokens", "POST", { name: `${STAMP} x`, role: "agent", team_ids: [T1], ...body });
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.match(r.body.error, re);
    };
    await bad({ role: "admin" }, 400, /role/);
    await bad({ team_ids: [] }, 400, /at least one team/);
    await bad({ team_ids: [999999999] }, 403, /teams you work in/);
    await bad({ expires_at: "2001-01-01" }, 400, /future/);
    await bad({ name: "" }, 400, /Name the token/);
    // A desk Agent can't open the page at all.
    await bad({}, 403, /permission/, "agent");
  });
});

// --- The REST API ------------------------------------------------------------------------

describe("REST API: authentication", () => {
  test("one 401 for missing, malformed, unknown, cookie-only, revoked and expired tokens", async () => {
    const ip = freshIp();
    const statuses: [string, Answer][] = [
      ["missing", await api(meRoute.GET, null, "/me", "GET", undefined, {}, { ip })],
      ["malformed", await api(meRoute.GET, "nope", "/me", "GET", undefined, {}, { ip })],
      ["unknown", await api(meRoute.GET, `cdh_${"A".repeat(43)}`, "/me", "GET", undefined, {}, { ip })],
      ["cookie only", await api(meRoute.GET, null, "/me", "GET", undefined, {}, { ip, cookie: `compass_session=${P.dadmin.session}` })],
    ];
    const expiring = await makeToken({ name: `${STAMP} Expiring`, role: "agent", team_ids: [T1], expires_at: SOON });
    assert.equal((await api(meRoute.GET, expiring.token, "/me")).status, 200);
    await pool().query("UPDATE hd_api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [expiring.id]);
    statuses.push(["expired", await api(meRoute.GET, expiring.token, "/me", "GET", undefined, {}, { ip })]);
    const revoking = await makeToken({ name: `${STAMP} Revoked`, role: "agent", team_ids: [T1], expires_at: null });
    assert.equal((await api(meRoute.GET, revoking.token, "/me")).status, 200);
    const rv = await asPerson(tokenRoute.DELETE, "dadmin", `/api/helpdesk/admin/api/tokens/${revoking.id}`, "DELETE", undefined, { id: String(revoking.id) });
    assert.equal(rv.status, 200);
    statuses.push(["revoked", await api(meRoute.GET, revoking.token, "/me", "GET", undefined, {}, { ip })]);
    for (const [why, r] of statuses) {
      assert.equal(r.status, 401, why);
      assert.equal(r.body.error, statuses[0][1].body.error, `${why}: the same sentence`);
    }
    // A revoked token's account has no desk role any more.
    assert.equal(await roles.hdRoleOf({ id: revoking.principal, role: "viewer" }), null);
  });

  test("unlicensed: 402 before anything", async () => {
    edition.features = [];
    try {
      assert.equal((await api(meRoute.GET, agentTok.token, "/me")).status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });

  test("failed token checks: only failures count, a valid token from the same address is never refused, and a request with no address has no shared budget", async () => {
    const ip = freshIp();
    for (let i = 0; i < 30; i++) assert.equal((await api(meRoute.GET, "bad", "/me", "GET", undefined, {}, { ip })).status, 401);
    // Over budget: the next bad token is refused before anything else...
    const over = await api(meRoute.GET, "bad", "/me", "GET", undefined, {}, { ip });
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("retry-after"), "60");
    // ...but a valid token from that very address still works (a stale script can't lock a good one out).
    assert.equal((await api(meRoute.GET, agentTok.token, "/me", "GET", undefined, {}, { ip })).status, 200);
    // A request with no client address (no forwarding header) has no shared budget to exhaust.
    const noAddress = () =>
      run(meRoute.GET, new Request("http://localhost/api/helpdesk/v1/me", { headers: { authorization: "Bearer bad" } }));
    for (let i = 0; i < 35; i++) assert.equal((await noAddress()).status, 401, `call ${i + 1}`);
  });

  test("per-token rate limit: 120 calls a minute", async () => {
    const t = await makeToken({ name: `${STAMP} Busy`, role: "agent", team_ids: [T1], expires_at: null });
    for (let i = 0; i < 120; i++) assert.equal((await api(meRoute.GET, t.token, "/me")).status, 200, `call ${i + 1}`);
    assert.equal((await api(meRoute.GET, t.token, "/me")).status, 429);
    // Successful reads are audited once a minute per route, not 120 times.
    const n = await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.api.call' AND actor_id = $1 AND details->>'route' = 'GET /me' AND details->>'outcome' = 'ok'", [t.principal]);
    assert.equal(n.rows[0].n, 1);
  });

  test("/me: who the token acts as and what it can do", async () => {
    const r = await api(meRoute.GET, agentTok.token, "/me");
    assert.equal(r.status, 200);
    assert.equal(r.body.acts_as.role, "agent");
    assert.deepEqual(r.body.acts_as.teams.map((t: any) => t.id), [T1]);
    assert.ok(r.body.capabilities.includes("tickets.reply_public"));
    assert.ok(!r.body.capabilities.includes("settings.manage"));
  });
});

describe("REST API: tickets", () => {
  let t1 = { id: 0, number: 0 };
  let t2 = { id: 0, number: 0 };
  before(async () => {
    t1 = await newTicket("VPN broken", T1);
    t2 = await newTicket("Payroll question", T2);
  });

  test("404 is the same for a missing ticket, one outside the token's teams and one in the recycle bin", async () => {
    const out = await api(ticketRoute.GET, agentTok.token, `/tickets/${t2.number}`, "GET", undefined, { number: String(t2.number) });
    const missing = await api(ticketRoute.GET, agentTok.token, "/tickets/999999999", "GET", undefined, { number: "999999999" });
    assert.equal(out.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(out.body.error.replace(/\d+/, "N"), missing.body.error.replace(/\d+/, "N"));
    // PATCH on a ticket the token can't see: 404, not 403.
    assert.equal((await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t2.number}`, "PATCH", { status: "pending" }, { number: String(t2.number) })).status, 404);
    // The recycle bin (C7's deleted_at).
    const binned = await newTicket("Binned", T1);
    await pool().query("UPDATE hd_tickets SET deleted_at = now() WHERE id = $1", [binned.id]);
    assert.equal((await api(ticketRoute.GET, agentTok.token, `/tickets/${binned.number}`, "GET", undefined, { number: String(binned.number) })).status, 404);
  });

  test("a ticket with its conversation; internal notes only when the role can add them", async () => {
    const r = await api(ticketRoute.GET, agentTok.token, `/tickets/${t1.number}`, "GET", undefined, { number: String(t1.number) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.number, t1.number);
    assert.equal(r.body.requester.email, P.req.email);
    assert.equal(r.body.internal_notes_included, true);
    assert.ok(r.body.messages.some((m: any) => m.kind === "internal"));
    // A matrix where Agents can't add notes: the notes stay out.
    roles.setRoleMatrixForTests({ ...shared.HD_DEFAULT_MATRIX, agent: shared.HD_DEFAULT_MATRIX.agent.filter((c) => c !== "tickets.internal_note") });
    try {
      const r2 = await api(ticketRoute.GET, agentTok.token, `/tickets/${t1.number}`, "GET", undefined, { number: String(t1.number) });
      assert.equal(r2.body.internal_notes_included, false);
      assert.ok(!r2.body.messages.some((m: any) => m.kind === "internal"));
      assert.ok(!JSON.stringify(r2.body).includes("Secret note"));
    } finally {
      roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
    }
  });

  test("list and search the token's queues with cursor paging", async () => {
    const tag = `${STAMP}-page`.toLowerCase();
    for (const s of ["one", "two", "three"]) await newTicket(`Paged ${s}`, T1, [tag]);
    await newTicket("Paged other team", T2, [tag]);
    const first = await api(ticketsRoute.GET, agentTok.token, `/tickets?view=all&tag=${tag}&limit=2`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.total, 3, "the other team's ticket is not in the token's queues");
    assert.equal(first.body.tickets.length, 2);
    assert.ok(first.body.next_cursor);
    const second = await api(ticketsRoute.GET, agentTok.token, `/tickets?view=all&tag=${tag}&limit=2&cursor=${first.body.next_cursor}`);
    assert.equal(second.body.tickets.length, 1);
    assert.equal(second.body.next_cursor, null);
    const seen = [...first.body.tickets, ...second.body.tickets].map((t: any) => t.number);
    assert.equal(new Set(seen).size, 3);
    // A cursor belongs to its filters.
    const other = await api(ticketsRoute.GET, agentTok.token, `/tickets?view=open&tag=${tag}&limit=2&cursor=${first.body.next_cursor}`);
    assert.equal(other.status, 400);
    assert.equal((await api(ticketsRoute.GET, agentTok.token, "/tickets?status=nope")).status, 400);
    assert.equal((await api(ticketsRoute.GET, agentTok.token, "/tickets?limit=500")).status, 400);
  });

  test("PATCH: each change needs its capability; changes say \"via API\"; audited with the token", async () => {
    const r = await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t1.number}`, "PATCH", { status: "pending", priority: "high", tags: ["vpn"] }, { number: String(t1.number) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([...r.body.changed].sort(), ["priority", "status", "tags"]);
    const lines = await pool().query<{ body: string; author_id: number }>("SELECT body, author_id FROM hd_messages WHERE ticket_id = $1 AND via = 'system' ORDER BY id", [t1.id]);
    assert.ok(lines.rows.some((l) => /changed the status .* via API$/.test(l.body) && l.author_id === agentTok.principal), JSON.stringify(lines.rows));
    const a = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.updated' AND actor_id = $1 AND target_id = $2", [agentTok.principal, String(t1.id)]);
    assert.equal(a.rowCount, 1);
    assert.equal(a.rows[0].details.via, "api");
    assert.equal(a.rows[0].details.token_name, `${STAMP} Jira sync`);
    assert.equal(a.rows[0].details.route, "PATCH /tickets/{number}");
    // A newbie role can't change the status: 403 (it can see the ticket).
    const nb = await api(ticketRoute.PATCH, newbieTok.token, `/tickets/${t1.number}`, "PATCH", { status: "open" }, { number: String(t1.number) });
    assert.equal(nb.status, 403);
    const refusedAudit = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.api.call' AND actor_id = $1 AND details->>'outcome' = 'forbidden'", [newbieTok.principal]);
    assert.equal(refusedAudit.rowCount, 1, "refused calls are always audited");
    // Only the documented fields.
    const subj = await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t1.number}`, "PATCH", { subject: "x" }, { number: String(t1.number) });
    assert.equal(subj.status, 400);
    // Never assigned to the token's own account.
    const self = await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t1.number}`, "PATCH", { assignee_id: agentTok.principal }, { number: String(t1.number) });
    assert.ok(self.status === 400 || self.status === 403, JSON.stringify(self.body));
  });

  test("notes and replies; a newbie role's reply is held for review and the requester can't see it", async () => {
    const n = await api(notesRoute.POST, agentTok.token, `/tickets/${t1.number}/notes`, "POST", { body: "Checked the VPN logs." }, { number: String(t1.number) });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    const r = await api(repliesRoute.POST, agentTok.token, `/tickets/${t1.number}/replies`, "POST", { body: "Try reconnecting now." }, { number: String(t1.number) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.held, false);
    const h = await api(repliesRoute.POST, newbieTok.token, `/tickets/${t1.number}/replies`, "POST", { body: "Held reply from the intern bot." }, { number: String(t1.number) });
    assert.equal(h.status, 201, JSON.stringify(h.body));
    assert.equal(h.body.held, true);
    const rows = await pool().query<{ kind: string; via: string; review_state: string | null; author_id: number }>(
      "SELECT kind, via, review_state, author_id FROM hd_messages WHERE ticket_id = $1 AND via = 'api' ORDER BY id",
      [t1.id]
    );
    assert.deepEqual(
      rows.rows.map((m) => [m.kind, m.review_state, m.author_id]),
      [
        ["internal", null, agentTok.principal],
        ["public", null, agentTok.principal],
        ["public", "pending", newbieTok.principal],
      ]
    );
    const { requesterMessages } = await import("../src/lib/helpdesk/access");
    const { listMessages } = await import("../src/lib/helpdesk/messages");
    assert.ok(!requesterMessages(await listMessages(t1.id)).some((m) => m.body.includes("intern bot")));
    // The token's account never starts following the ticket.
    const f = await pool().query("SELECT 1 FROM hd_ticket_followers WHERE ticket_id = $1 AND user_id = ANY($2)", [t1.id, [agentTok.principal, newbieTok.principal]]).catch(() => ({ rowCount: 0 }));
    assert.equal(f.rowCount, 0);
    // A note without the capability: a custom matrix.
    roles.setRoleMatrixForTests({ ...shared.HD_DEFAULT_MATRIX, agent: shared.HD_DEFAULT_MATRIX.agent.filter((c) => c !== "tickets.internal_note") });
    try {
      assert.equal((await api(notesRoute.POST, agentTok.token, `/tickets/${t1.number}/notes`, "POST", { body: "x" }, { number: String(t1.number) })).status, 403);
    } finally {
      roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
    }
  });

  test("a chunked body over the cap is refused (413) without being read whole", async () => {
    const big = "x".repeat(200 * 1024);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify({ body: big })));
        c.close();
      },
    });
    const req = new Request(`http://localhost/api/helpdesk/v1/tickets/${t1.number}/notes`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentTok.token}`, "content-type": "application/json", "x-forwarded-for": CLIENT_IP },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const r = await run(notesRoute.POST, req, { number: String(t1.number) });
    assert.equal(r.status, 413);
  });

  test("approvals and reports follow the role", async () => {
    const a = await api(approvalsRoute.GET, agentTok.token, "/approvals");
    assert.equal(a.status, 200);
    assert.ok(Array.isArray(a.body.approvals));
    assert.equal((await api(reportRoute.GET, agentTok.token, "/reports/summary")).status, 403, "an Agent has no All reports");
    const lead = await makeToken({ name: `${STAMP} Reports reader`, role: "team_lead", team_ids: [T1], expires_at: null });
    assert.equal((await api(reportRoute.GET, lead.token, "/reports/summary")).status, 403, "Team reports needs a team");
    const r = await api(reportRoute.GET, lead.token, `/reports/summary?team=${T1}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(typeof r.body.created, "number");
    assert.equal((await api(reportRoute.GET, lead.token, `/reports/summary?team=${T2}`)).status, 403, "not another team's");
  });
});

// --- Webhooks --------------------------------------------------------------------------------

describe("webhooks", () => {
  test("endpoint rules: https only, no private or local address, no credentials", async () => {
    const bad = async (url: string, re: RegExp) => {
      const r = await asPerson(hooksRoute.POST, "dadmin", "/api/helpdesk/admin/api/webhooks", "POST", { name: `${STAMP} bad`, url, events: ["ticket.created"], team_ids: [T1] });
      assert.equal(r.status, 400, `${url}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, re);
    };
    await bad("http://hooks.example.test/x", /https/);
    await bad("https://127.0.0.1/x", /private or local/);
    await bad("https://10.0.0.5/x", /private or local/);
    await bad("https://169.254.169.254/latest", /private or local/);
    await bad("https://user:pw@hooks.example.test/x", /user name and password/);
    await bad("not a url", /web address/);
    const noEvents = await asPerson(hooksRoute.POST, "dadmin", "/api/helpdesk/admin/api/webhooks", "POST", { url: `${HOST}/x`, events: [], team_ids: [T1] });
    assert.equal(noEvents.status, 400);
    // A private address is allowed when the server opts in.
    process.env.COMPASSDOCS_FETCH_ALLOW_PRIVATE = "1";
    try {
      const ok = await makeHook("private", { url: "https://10.0.0.5/hd", events: ["ticket.created"] });
      assert.ok(ok.id);
    } finally {
      delete process.env.COMPASSDOCS_FETCH_ALLOW_PRIVATE;
    }
  });

  test("a change is queued after commit and delivered signed; the secret is never shown again", async () => {
    const h = await makeHook("Jira", { url: `${HOST}/jira`, events: ["ticket.updated", "ticket.solved", "message.created", "note.created"], include_notes: true });
    assert.match(h.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    const list = await asPerson(adminRoute.GET, "dadmin", "/api/helpdesk/admin/api");
    assert.ok(!JSON.stringify(list.body).includes(h.secret));
    const t = await newTicket("Printer jam", T1);
    const r = await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t.number}`, "PATCH", { priority: "urgent" }, { number: String(t.number) });
    assert.equal(r.status, 200);
    const q = await deliveries(h.id);
    assert.equal(q.length, 1);
    assert.equal(q[0].state, "queued");
    await hooks.processDueDeliveries({ ids: q.map((d) => Number(d.id)) });
    const got = receivedOn("/jira");
    assert.equal(got.length, 1);
    const body = got[0].body;
    const sig = String(got[0].headers["x-compassdocs-signature"]);
    assert.match(sig, /^t=\d+,v1=[0-9a-f]{64}$/);
    assert.equal(hooks.verifyWebhookSignature(h.secret, sig, body), true);
    assert.equal(hooks.verifyWebhookSignature("whsec_wrong", sig, body), false);
    assert.equal(got[0].headers["x-compassdocs-event"], "ticket.updated");
    const payload = JSON.parse(body);
    assert.equal(payload.event, "ticket.updated");
    assert.equal(payload.ticket.number, t.number);
    assert.equal(payload.ticket.priority, "urgent");
    assert.deepEqual(payload.changes, ["priority"]);
    assert.equal(payload.actor.via, "api");
    assert.equal(payload.actor.api_token.name, `${STAMP} Jira sync`);
    assert.equal(got[0].headers["x-compassdocs-delivery"], payload.id);
    const done = await deliveries(h.id);
    assert.equal(done[0].state, "delivered");
    assert.equal(done[0].payload, null, "the payload is dropped once delivered");
    assert.equal(done[0].response_status, 200);
    // Rotate: the new secret signs, the old one no longer does.
    const rot = await asPerson(rotateRoute.POST, "dadmin", `/x`, "POST", undefined, { id: String(h.id) });
    assert.equal(rot.status, 200);
    await api(notesRoute.POST, agentTok.token, `/tickets/${t.number}/notes`, "POST", { body: "after rotation" }, { number: String(t.number) });
    await hooks.processDueDeliveries({ ids: (await deliveries(h.id)).filter((d) => d.state === "queued").map((d) => Number(d.id)) });
    const last = receivedOn("/jira").at(-1)!;
    assert.equal(JSON.parse(last.body).event, "note.created");
    assert.equal(hooks.verifyWebhookSignature(rot.body.secret, String(last.headers["x-compassdocs-signature"]), last.body), true);
    assert.equal(hooks.verifyWebhookSignature(h.secret, String(last.headers["x-compassdocs-signature"]), last.body), false);
  });

  test("team filter, internal notes only when included, held replies only once approved", async () => {
    const other = await makeHook("HR only", { url: `${HOST}/hr`, events: ["ticket.updated", "message.created", "note.created"], team_ids: [T2] });
    const noNotes = await makeHook("No notes", { url: `${HOST}/nonotes`, events: ["message.created", "note.created"], include_notes: false });
    const t = await newTicket("Monitor flicker", T1);
    await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t.number}`, "PATCH", { priority: "low" }, { number: String(t.number) });
    await api(notesRoute.POST, agentTok.token, `/tickets/${t.number}/notes`, "POST", { body: "A private note." }, { number: String(t.number) });
    assert.equal((await deliveries(other.id)).length, 0, "an HR-only hook hears nothing of an IT ticket");
    assert.equal((await deliveries(noNotes.id)).length, 0, "notes only go to hooks that include them");
    // The newbie's held reply: nothing yet; approved: message.created.
    const h = await api(repliesRoute.POST, newbieTok.token, `/tickets/${t.number}/replies`, "POST", { body: "Please restart the monitor." }, { number: String(t.number) });
    assert.equal(h.body.held, true);
    assert.equal((await deliveries(noNotes.id)).length, 0, "a held reply is not sent");
    const { decideReview } = await import("../src/lib/helpdesk/review");
    await decideReview({ id: P.lead.id, role: "viewer", name: P.lead.name }, h.body.message.id, { decision: "approve" });
    const after = await deliveries(noNotes.id);
    assert.equal(after.length, 1);
    assert.equal(after[0].event, "message.created");
    assert.equal(after[0].payload.message.body, "Please restart the monitor.");
    assert.equal(after[0].payload.message.from, "desk");
    // Moving the ticket to HR: the HR hook hears of the move.
    const lead = await makeToken({ name: `${STAMP} Mover`, role: "manager", team_ids: [T1, T2], expires_at: null });
    const mv = await api(ticketRoute.PATCH, lead.token, `/tickets/${t.number}`, "PATCH", { team_id: T2 }, { number: String(t.number) });
    assert.equal(mv.status, 200, JSON.stringify(mv.body));
    const hr = await deliveries(other.id);
    assert.equal(hr.length, 1);
    assert.deepEqual(hr[0].payload.changes, ["team_id"]);
  });

  test("retries with backoff for a true 24 hours (a last attempt at the end), and a hook failing for 24 hours turns off at its next failed attempt", async () => {
    const h = await makeHook("Flaky", { url: `${HOST}/flaky`, events: ["ticket.updated"] });
    answers.set("/flaky", { status: 500, body: "x".repeat(5000) });
    const t = await newTicket("Flaky one", T1);
    await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t.number}`, "PATCH", { priority: "high" }, { number: String(t.number) });
    const [d] = await deliveries(h.id);
    const now = Date.now();
    await hooks.processDueDeliveries({ ids: [Number(d.id)] });
    let row = (await deliveries(h.id))[0];
    assert.equal(row.state, "queued");
    assert.equal(row.attempts, 1);
    assert.equal(row.response_status, 500);
    assert.equal(row.response_excerpt.length, 2048, "the first 2 KB of the answer");
    const nextOf = async (id: string) => Date.parse(String((await pool().query("SELECT next_attempt_at::text AS n FROM hd_webhook_deliveries WHERE id = $1", [id])).rows[0].n));
    assert.ok(Math.abs((await nextOf(d.id)) - (now + 60_000)) < 3000, "the first retry a minute later");
    // Not due yet: nothing happens.
    assert.equal(await hooks.processDueDeliveries({ ids: [Number(d.id)], now: new Date(now + 30_000) }), 0);
    // Recovered: delivered, failing state cleared.
    answers.set("/flaky", { status: 204 });
    await hooks.processDueDeliveries({ ids: [Number(d.id)], now: new Date(now + 61_000) });
    row = (await deliveries(h.id))[0];
    assert.equal(row.state, "delivered");
    assert.equal(row.attempts, 2);
    assert.equal((await pool().query("SELECT failing_since FROM hd_webhooks WHERE id = $1", [h.id])).rows[0].failing_since, null);

    // A sparse hook, down since its one event 23 hours ago: the next backoff (6 hours) would pass the
    // event's 24 hours, so the retry is set for the end of the window instead of giving up early.
    answers.set("/flaky", { status: 503 });
    await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t.number}`, "PATCH", { priority: "low" }, { number: String(t.number) });
    const late = (await deliveries(h.id)).find((x) => x.state === "queued")!;
    await pool().query("UPDATE hd_webhook_deliveries SET created_at = now() - interval '23 hours', attempts = 9, next_attempt_at = now() WHERE id = $1", [late.id]);
    await pool().query("UPDATE hd_webhooks SET failing_since = now() - interval '23 hours' WHERE id = $1", [h.id]);
    await hooks.processDueDeliveries({ ids: [Number(late.id)] });
    let r2 = (await deliveries(h.id)).find((x) => x.id === late.id)!;
    assert.equal(r2.state, "queued", "not given up before the window ends");
    const end = Date.parse(String((await pool().query("SELECT (created_at + interval '24 hours')::text AS e FROM hd_webhook_deliveries WHERE id = $1", [late.id])).rows[0].e));
    assert.equal(await nextOf(late.id), end, "the last attempt is at the end of the 24 hours");
    assert.equal((await pool().query("SELECT enabled FROM hd_webhooks WHERE id = $1", [h.id])).rows[0].enabled, true, "failing for 23 hours: still on");

    // The attempt at the end of the window fails: it gives up, and the hook (failing for 24 hours by then) turns off.
    await pool().query("UPDATE hd_webhook_deliveries SET created_at = now() - interval '24 hours', next_attempt_at = now() WHERE id = $1", [late.id]);
    await pool().query("UPDATE hd_webhooks SET failing_since = now() - interval '24 hours' WHERE id = $1", [h.id]);
    await hooks.processDueDeliveries({ ids: [Number(late.id)] });
    r2 = (await deliveries(h.id)).find((x) => x.id === late.id)!;
    assert.equal(r2.state, "failed");
    assert.match(r2.error, /HTTP 503 Gave up after 24 hours/);
    const hook = (await pool().query("SELECT enabled, disabled_reason FROM hd_webhooks WHERE id = $1", [h.id])).rows[0];
    assert.equal(hook.enabled, false);
    assert.match(hook.disabled_reason, /24 hours/);
    const bell = await pool().query("SELECT title FROM notifications WHERE user_id = $1 AND title LIKE $2", [P.dadmin.id, `%${STAMP} Flaky%`]);
    assert.equal(bell.rowCount, 1, "the desk admin hears in the bell");
    const audited = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.webhook.auto_disabled' AND target_id = $1", [String(h.id)]);
    assert.equal(audited.rowCount, 1);
    // Off: nothing more is queued for it.
    await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t.number}`, "PATCH", { priority: "normal" }, { number: String(t.number) });
    assert.equal((await deliveries(h.id)).filter((x) => x.state === "queued").length, 0);
    // Back on through the settings route: a clean slate.
    const on = await asPerson(hookRoute.PATCH, "dadmin", "/x", "PATCH", { enabled: true }, { id: String(h.id) });
    assert.equal(on.status, 200);
    assert.equal(on.body.hook.enabled, true);
    assert.equal(on.body.hook.health === "failing", false);

    // Auto-off is decided at every failed attempt, not only when a delivery gives up: a fresh event's
    // first failure on a hook already failing for 25 hours turns it off, and the event is not retried.
    await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t.number}`, "PATCH", { priority: "high" }, { number: String(t.number) });
    const fresh = (await deliveries(h.id)).find((x) => x.state === "queued")!;
    await pool().query("UPDATE hd_webhooks SET failing_since = now() - interval '25 hours' WHERE id = $1", [h.id]);
    await hooks.processDueDeliveries({ ids: [Number(fresh.id)] });
    assert.equal((await pool().query("SELECT enabled FROM hd_webhooks WHERE id = $1", [h.id])).rows[0].enabled, false);
    const f2 = (await deliveries(h.id)).find((x) => x.id === fresh.id)!;
    assert.equal(f2.state, "failed");
    assert.match(f2.error, /turned off/);
  });

  test("redirects aren't followed; the log keeps 50 per hook", async () => {
    const h = await makeHook("Moved", { url: `${HOST}/moved`, events: ["ticket.updated"] });
    answers.set("/moved", { status: 301, headers: { location: "https://elsewhere.example.test/" } });
    const t = await newTicket("Moved", T1);
    await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t.number}`, "PATCH", { priority: "high" }, { number: String(t.number) });
    const [d] = await deliveries(h.id);
    await hooks.processDueDeliveries({ ids: [Number(d.id)] });
    const row = (await deliveries(h.id))[0];
    assert.equal(row.state, "queued");
    assert.match(row.error, /redirect \(HTTP 301\)/);
    assert.equal(received.filter((r) => r.path !== "/moved" && r.headers.host?.includes("elsewhere")).length, 0);
    // 60 finished rows: pruned to 50 at the next finish.
    await pool().query(
      `INSERT INTO hd_webhook_deliveries (hook_id, event, event_id, state, finished_at, last_attempt_at)
       SELECT $1, 'ticket.updated', 'evt_' || g, 'delivered', now(), now() FROM generate_series(1, 60) g`,
      [h.id]
    );
    answers.set("/moved", { status: 200 });
    await hooks.processDueDeliveries({ ids: [Number(d.id)], now: new Date(Date.now() + 120_000) });
    const all = await deliveries(h.id);
    assert.equal(all.filter((x) => x.state === "delivered" || x.state === "failed").length, 50);
    assert.ok(all.some((x) => x.id === d.id && x.state === "delivered"), "the newest finished row is kept");
  });

  test("test send: a signed ping, logged as a test, never counted against the hook", async () => {
    const h = await makeHook("Pinged", { url: `${HOST}/ping`, events: ["ticket.created"] });
    const ok = await asPerson(testRoute.POST, "dadmin", "/x", "POST", undefined, { id: String(h.id) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.delivery.state, "delivered");
    assert.equal(ok.body.delivery.test, true);
    const ping = receivedOn("/ping").at(-1)!;
    assert.equal(JSON.parse(ping.body).event, "ping");
    assert.equal(hooks.verifyWebhookSignature(h.secret, String(ping.headers["x-compassdocs-signature"]), ping.body), true);
    answers.set("/ping", { status: 500, body: "nope" });
    const bad = await asPerson(testRoute.POST, "dadmin", "/x", "POST", undefined, { id: String(h.id) });
    assert.equal(bad.body.delivery.state, "failed");
    assert.equal(bad.body.delivery.response_status, 500);
    assert.equal((await pool().query("SELECT failing_since FROM hd_webhooks WHERE id = $1", [h.id])).rows[0].failing_since, null);
    const log = await asPerson(deliveriesRoute.GET, "dadmin", "/x", "GET", undefined, { id: String(h.id) });
    assert.equal(log.status, 200);
    assert.equal(log.body.deliveries.length, 2);
    assert.ok(!JSON.stringify(log.body).includes(h.secret));
    assert.equal("payload" in log.body.deliveries[0], false);
  });

  test("binned tickets send only ticket.deleted; anonymising drops undelivered payloads", async () => {
    const h = await makeHook("Bin", { url: `${HOST}/bin`, events: ["ticket.updated", "ticket.deleted", "ticket.restored"] });
    const t = await newTicket("To the bin", T1);
    await pool().query("UPDATE hd_tickets SET deleted_at = now() WHERE id = $1", [t.id]);
    const { updateTicket } = await import("../src/lib/helpdesk/tickets");
    await updateTicket(t.id, { priority: "high" }, { id: P.agent.id, name: P.agent.name });
    assert.equal((await deliveries(h.id)).length, 0, "a binned ticket is silent");
    assert.equal(await hooks.emitHelpdeskWebhookEvent("ticket.deleted", { ticketId: t.id, actor: { id: P.agent.id, name: P.agent.name } }), 1);
    await pool().query("UPDATE hd_tickets SET deleted_at = NULL WHERE id = $1", [t.id]);
    assert.equal(await hooks.emitHelpdeskWebhookEvent("ticket.restored", { ticketId: t.id }), 1);
    const events = (await deliveries(h.id)).map((d) => d.event);
    assert.deepEqual(events, ["ticket.deleted", "ticket.restored"]);
    // Anonymise while still queued: failed, payload gone.
    const { anonymiseTicketTx } = await import("../src/lib/helpdesk/retention");
    const { withTx } = await import("../src/lib/helpdesk/db-core");
    await withTx((c) => anonymiseTicketTx(c, t.id));
    for (const d of await deliveries(h.id)) {
      assert.equal(d.state, "failed");
      assert.equal(d.payload, null);
      assert.match(d.error, /anonymised/);
    }
  });

  test("the sweep's lock key is its own, and it requeues a send a dead process left claimed", async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const keys = {
      webhooks: hooks.WEBHOOK_SWEEP_LOCK,
      sla: (require("../src/lib/helpdesk/db-sla") as typeof import("../src/lib/helpdesk/db-sla")).SLA_SWEEP_LOCK,
      calendars: (require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars")).CALENDAR_RECOMPUTE_LOCK,
      assignment: (require("../src/lib/helpdesk/assignment/engine") as typeof import("../src/lib/helpdesk/assignment/engine")).ASSIGNMENT_SWEEP_LOCK,
      retention: (require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention")).RETENTION_LOCK,
      recurring: (require("../src/lib/helpdesk/recurring") as typeof import("../src/lib/helpdesk/recurring")).RECURRING_SWEEP_LOCK,
      assets: (require("../src/lib/helpdesk/assets") as typeof import("../src/lib/helpdesk/assets")).ASSETS_SYNC_LOCK,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
    const values = Object.values(keys);
    assert.equal(new Set(values).size, values.length, JSON.stringify(keys));
    assert.notEqual(hooks.WEBHOOK_SWEEP_LOCK, 7_281_947, "the recycle bin's key");
    const { HELPDESK_SWEEPS } = await import("../src/lib/periodic");
    assert.ok(HELPDESK_SWEEPS.some((s) => s.name === "hd_webhooks"));
    const h = await makeHook("Stale", { url: `${HOST}/stale`, events: ["ticket.created"] });
    const row = await pool().query<{ id: string }>(
      `INSERT INTO hd_webhook_deliveries (hook_id, event, event_id, state, claimed_at, next_attempt_at, payload)
       VALUES ($1, 'ticket.created', 'evt_stale', 'sending', now() - interval '10 minutes', now() + interval '1 hour', '{}'::jsonb) RETURNING id`,
      [h.id]
    );
    const r = await hooks.webhookSweep();
    if (r) {
      assert.ok(r.requeued >= 1);
      const st = (await pool().query("SELECT state FROM hd_webhook_deliveries WHERE id = $1", [row.rows[0].id])).rows[0].state;
      assert.equal(st, "queued");
    }
  });
});

// --- Review fixes (1.19.4 C2 review) ----------------------------------------------------------

describe("webhooks: review fixes", () => {
  /** Queue one ticket.updated per new ticket for `hookId` (autosend is off in this file). */
  async function queueUpdates(n: number, label: string): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = await newTicket(`${label} ${i}`, T1);
      await api(ticketRoute.PATCH, agentTok.token, `/tickets/${t.number}`, "PATCH", { priority: "high" }, { number: String(t.number) });
      ids.push(t.id);
    }
    return ids;
  }

  test("a delivery is claimed just before its own attempt, so a long pass never goes stale and nothing is sent twice", async () => {
    const h = await makeHook("Slow", { url: `${HOST}/slow`, events: ["ticket.updated"] });
    answers.set("/slow", { status: 200, body: "ok", delayMs: 250 });
    await queueUpdates(4, "Slow");
    const rows = await deliveries(h.id);
    assert.equal(rows.length, 4);
    // A stale threshold shorter than the whole pass (4 × 250 ms), longer than one attempt.
    hooks.setWebhookTimingForTests({ staleClaimMs: 400 });
    try {
      const first = hooks.processDueDeliveries({ ids: rows.map((r) => Number(r.id)) });
      await new Promise((r) => setTimeout(r, 650));
      // Another tick (or instance) runs the upkeep and its own pass meanwhile.
      await Promise.all([hooks.webhookSweep(), hooks.processDueDeliveries({ ids: rows.map((r) => Number(r.id)) })]);
      await first;
    } finally {
      hooks.setWebhookTimingForTests(null);
    }
    const got = receivedOn("/slow").map((r) => JSON.parse(r.body).id);
    assert.equal(got.length, 4, `each event once: ${JSON.stringify(got)}`);
    assert.equal(new Set(got).size, 4);
    for (const d of await deliveries(h.id)) {
      assert.equal(d.state, "delivered");
      assert.equal(d.attempts, 1);
    }
    // One at a time per hook, oldest first.
    assert.deepEqual(got, rows.map((r) => r.payload.id));
  });

  test("a row anonymised while its attempt is in flight stays failed: the outcome is dropped, never requeued, never sent as \"null\"", async () => {
    const h = await makeHook("Anon", { url: `${HOST}/anon`, events: ["ticket.updated"] });
    answers.set("/anon", { status: 500, body: "down", delayMs: 300 });
    const [ticketId] = await queueUpdates(1, "Anon");
    const [d] = await deliveries(h.id);
    const inFlight = hooks.processDueDeliveries({ ids: [Number(d.id)] });
    await new Promise((r) => setTimeout(r, 100));
    const { withTx } = await import("../src/lib/helpdesk/db-core");
    await withTx((c) => hooks.anonymiseWebhookDeliveriesTx(c, ticketId));
    await inFlight;
    let row = (await deliveries(h.id))[0];
    assert.equal(row.state, "failed");
    assert.equal(row.payload, null);
    assert.match(row.error, /anonymised/);
    assert.equal(row.attempts, 0, "the in-flight outcome did not overwrite the row");
    assert.equal(await hooks.processDueDeliveries({ ids: [Number(d.id)], now: new Date(Date.now() + 3_600_000) }), 0);
    // The same race when the attempt succeeds: still failed, not "delivered".
    answers.set("/anon", { status: 200, body: "ok", delayMs: 300 });
    const [t2] = await queueUpdates(1, "Anon ok");
    const d2 = (await deliveries(h.id)).find((x) => x.state === "queued")!;
    const inFlight2 = hooks.processDueDeliveries({ ids: [Number(d2.id)] });
    await new Promise((r) => setTimeout(r, 100));
    await withTx((c) => hooks.anonymiseWebhookDeliveriesTx(c, t2));
    await inFlight2;
    row = (await deliveries(h.id)).find((x) => x.id === d2.id)!;
    assert.equal(row.state, "failed");
    assert.match(row.error, /anonymised/);
    // A queued row with no payload left is never sent: it fails with "nothing left to send".
    const before = receivedOn("/anon").length;
    const ghost = await pool().query<{ id: string }>(
      "INSERT INTO hd_webhook_deliveries (hook_id, event, event_id, ticket_id, ticket_number, payload) VALUES ($1, 'ticket.updated', 'evt_ghost', $2, 1, NULL) RETURNING id",
      [h.id, ticketId]
    );
    await hooks.processDueDeliveries({ ids: [Number(ghost.rows[0].id)] });
    assert.equal(receivedOn("/anon").length, before, "nothing sent");
    const g = (await deliveries(h.id)).find((x) => x.id === ghost.rows[0].id)!;
    assert.equal(g.state, "failed");
    assert.match(g.error, /nothing left to send/);
  });

  test("the database clock decides what is due, and every attempt is signed with its own time, not a stale tick's", async () => {
    const h = await makeHook("Clock", { url: `${HOST}/clock`, events: ["ticket.updated"] });
    answers.set("/clock", { status: 200, body: "ok" });
    await queueUpdates(1, "Clock");
    // The app server's clock 10 minutes behind the database's: the row (stamped by the database) is still due now.
    const RealDate = Date;
    const skew = -10 * 60_000;
    class SkewedDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(RealDate.now() + skew);
        else super(...(args as [string]));
      }
      static now() {
        return RealDate.now() + skew;
      }
    }
    (globalThis as { Date: DateConstructor }).Date = SkewedDate as unknown as DateConstructor;
    try {
      // A sweep whose tick started 10 minutes ago (by the skewed clock, 20 minutes before the database's).
      await hooks.webhookSweep(new RealDate(RealDate.now() - 20 * 60_000));
    } finally {
      (globalThis as { Date: DateConstructor }).Date = RealDate;
    }
    const got = receivedOn("/clock");
    assert.equal(got.length, 1, "sent at once despite the skewed app clock and the old tick time");
    const sig = String(got[0].headers["x-compassdocs-signature"]);
    const t = Number(/t=(\d+)/.exec(sig)![1]);
    const dbNow = Math.floor(Date.parse(String((await pool().query("SELECT now()::text AS n")).rows[0].n)) / 1000);
    assert.ok(Math.abs(dbNow - t) < 10, `signed at the attempt's time (t=${t}, db=${dbNow})`);
    assert.equal(hooks.verifyWebhookSignature(h.secret, sig, got[0].body), true, "a receiver's 5-minute check accepts it");
  });

  test("a ticket moved to the bin or deleted for good stops sending what was queued for it", async () => {
    const h = await makeHook("Gone", { url: `${HOST}/gone`, events: ["ticket.updated", "ticket.deleted"] });
    answers.set("/gone", { status: 200, body: "ok" });
    const [binned, purged, vanished] = await queueUpdates(3, "Gone");
    const rowFor = async (ticketId: number) =>
      (await pool().query<{ id: string; state: string; error: string; payload: unknown }>("SELECT id, state, error, payload FROM hd_webhook_deliveries WHERE hook_id = $1 AND ticket_number = (SELECT number FROM hd_tickets WHERE id = $2)", [h.id, ticketId])).rows[0];
    const binnedRow = await rowFor(binned);
    const purgedRow = await rowFor(purged);
    const vanishedRow = await rowFor(vanished);
    // Binned after it was queued: not sent.
    await pool().query("UPDATE hd_tickets SET deleted_at = now() WHERE id = $1", [binned]);
    await hooks.processDueDeliveries({ ids: [Number(binnedRow.id)] });
    const b = (await deliveries(h.id)).find((x) => x.id === binnedRow.id)!;
    assert.equal(b.state, "failed");
    assert.match(b.error, /recycle bin/);
    // Deleted for good through retention's deleteTicketTx (the bin's purge uses it): dropped in the same transaction.
    const { deleteTicketTx } = await import("../src/lib/helpdesk/retention");
    const { withTx } = await import("../src/lib/helpdesk/db-core");
    await withTx((c) => deleteTicketTx(c, purged));
    const p = (await deliveries(h.id)).find((x) => x.id === purgedRow.id)!;
    assert.equal(p.state, "failed");
    assert.equal(p.payload, null);
    assert.match(p.error, /deleted/);
    // Deleted some other way (ticket_id set NULL by the foreign key): caught before the send.
    await pool().query("DELETE FROM hd_tickets WHERE id = $1", [vanished]);
    await hooks.processDueDeliveries({ ids: [Number(vanishedRow.id)] });
    const v = (await deliveries(h.id)).find((x) => x.id === vanishedRow.id)!;
    assert.equal(v.state, "failed");
    assert.match(v.error, /deleted/);
    assert.equal(receivedOn("/gone").length, 0, "nothing about them left the building");
  });

  test("removing an account drops undelivered events that carry that person's message or that they caused", async () => {
    const jane = await person("jane", `${STAMP} Jane Doe`);
    const h = await makeHook("Removal", { url: `${HOST}/removal`, events: ["message.created"] });
    const t = await newTicket("CC reply", T1);
    const { addMessage } = await import("../src/lib/helpdesk/messages");
    await addMessage(t.id, { kind: "public", body: "Jane's private detail", author: { id: jane.id, name: jane.name, email: jane.email }, via: "portal", asRequester: true }, { actorId: jane.id, actorName: jane.name });
    const [d] = await deliveries(h.id);
    assert.equal(d.state, "queued");
    assert.equal(d.payload.message.body, "Jane's private detail");
    const { anonymiseRemovedAccount, getRetentionSettings } = await import("../src/lib/helpdesk/retention");
    if (!(await getRetentionSettings()).anonymise_on_account_removal) {
      const { withTx } = await import("../src/lib/helpdesk/db-core");
      await withTx((c) => hooks.scrubRemovedAccountWebhookDeliveriesTx(c, jane.id, []));
    } else {
      await anonymiseRemovedAccount(jane.id);
    }
    const after = (await deliveries(h.id)).find((x) => x.id === d.id)!;
    assert.equal(after.state, "failed");
    assert.equal(after.payload, null);
    assert.match(after.error, /removed/);
  });

  test("ticket.created goes first: an assignment rule's change and the rest come after it, in order", async () => {
    const h = await makeHook("Order", { url: `${HOST}/order`, events: ["ticket.created", "ticket.updated"] });
    answers.set("/order", { status: 200, body: "ok" });
    const rule = await pool().query<{ id: number }>(
      `INSERT INTO hd_assignment_rules (name, position, enabled, scope_team_id, conditions, action, stop)
       VALUES ($1, -1000, 1, $2, '{"match":"all","rules":[]}', '{"assign":"leave_unassigned","set_priority":"urgent"}', 0) RETURNING id`,
      [`${STAMP} order rule`, T1]
    );
    try {
      const { createTicket } = await import("../src/lib/helpdesk/tickets");
      const t = await createTicket(
        { subject: `${STAMP} Ordered`, body: "Hello", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, source: "desk", team_id: T1 },
        { actorId: P.agent.id, actorName: P.agent.name }
      );
      ticketIds.push(t.id);
      const rows = (await deliveries(h.id)).filter((x) => x.payload?.ticket?.number === t.number);
      assert.deepEqual(rows.map((r) => r.event), ["ticket.created", "ticket.updated"], "created is queued before the rule's update");
      assert.deepEqual(rows[1].payload.changes, ["priority"]);
      await hooks.processDueDeliveries({ ids: rows.map((r) => Number(r.id)) });
      assert.deepEqual(receivedOn("/order").map((r) => JSON.parse(r.body).event), ["ticket.created", "ticket.updated"]);
    } finally {
      await pool().query("DELETE FROM hd_assignment_rules WHERE id = $1", [rule.rows[0].id]);
    }
  });

  test("merging and the auto-close sweep send their status changes", async () => {
    const h = await makeHook("Merge", { url: `${HOST}/merge`, events: ["ticket.updated", "ticket.solved"] });
    const keep = await newTicket("Keep", T1, ["kept"]);
    const dup = await newTicket("Dup", T1, ["dup-tag"]);
    const { mergeTickets } = await import("../src/lib/helpdesk/merge");
    const r = await mergeTickets({ id: P.dadmin.id, role: "viewer", name: P.dadmin.name }, { keep: keep.number, merge: [dup.number], notify: false });
    assert.equal(r.already, false);
    const ev = (await deliveries(h.id)).map((d) => [d.payload.ticket.number, d.event, d.payload.changes ?? null]);
    assert.deepEqual(ev, [
      [dup.number, "ticket.updated", ["status"]],
      [dup.number, "ticket.solved", null],
      [keep.number, "ticket.updated", ["tags"]],
    ]);
    assert.equal((await deliveries(h.id))[0].payload.ticket.status, "closed");
    // Auto-close: a ticket solved long ago is closed by the retention run.
    const solved = await newTicket("Solved long ago", T1);
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() - interval '30 days' WHERE id = $1", [solved.id]);
    const { runRetention } = await import("../src/lib/helpdesk/retention");
    const { HD_RETENTION_DEFAULTS } = await import("../src/lib/helpdesk/retention-shared");
    const out = await runRetention({ settings: { ...HD_RETENTION_DEFAULTS, auto_close_enabled: true, auto_close_days: 3, retention_enabled: false }, only: [solved.id] });
    assert.deepEqual(out.closed, [solved.id]);
    const closed = (await deliveries(h.id)).filter((d) => d.payload?.ticket?.number === solved.number);
    assert.deepEqual(closed.map((d) => [d.event, d.payload.changes, d.payload.ticket.status]), [["ticket.updated", ["status"], "closed"]]);
  });

  test("a webhook's teams are limited to the creator's, like a token's; a wider hook can't be pointed elsewhere by them", async () => {
    // A Team lead given Helpdesk settings: works IT (T1) only.
    roles.setRoleMatrixForTests({ ...shared.HD_DEFAULT_MATRIX, team_lead: [...shared.HD_DEFAULT_MATRIX.team_lead, "settings.manage"] });
    try {
      const make = (body: Record<string, unknown>) =>
        asPerson(hooksRoute.POST, "lead", "/api/helpdesk/admin/api/webhooks", "POST", { name: `${STAMP} lead hook`, url: `${HOST}/lead`, events: ["ticket.created", "note.created"], ...body });
      const all = await make({ team_ids: [], include_notes: true });
      assert.equal(all.status, 403, JSON.stringify(all.body));
      assert.match(all.body.error, /don't work every team/);
      const other = await make({ team_ids: [T2] });
      assert.equal(other.status, 403);
      assert.match(other.body.error, /teams you work in/);
      const mine = await make({ team_ids: [T1], include_notes: true });
      assert.equal(mine.status, 201, JSON.stringify(mine.body));
      hookIds.push(mine.body.hook.id);
      // An admin's every-team hook: the lead can't redirect it or change its teams, but can turn it off.
      const wide = await makeHook("Wide", { url: `${HOST}/wide`, events: ["ticket.created"], team_ids: [] });
      const redirect = await asPerson(hookRoute.PATCH, "lead", "/x", "PATCH", { url: "https://lead.example.test/mine" }, { id: String(wide.id) });
      assert.equal(redirect.status, 403);
      assert.match(redirect.body.error, /reaches teams you don't work/);
      const narrow = await asPerson(hookRoute.PATCH, "lead", "/x", "PATCH", { team_ids: [T1] }, { id: String(wide.id) });
      assert.equal(narrow.status, 403);
      const off = await asPerson(hookRoute.PATCH, "lead", "/x", "PATCH", { enabled: false }, { id: String(wide.id) });
      assert.equal(off.status, 200);
      assert.equal((await pool().query("SELECT url FROM hd_webhooks WHERE id = $1", [wide.id])).rows[0].url, `${HOST}/wide`);
    } finally {
      roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
    }
  });

  test("the auto-off bell finds workspace admins under the legacy break-glass too", async () => {
    const boss = await person("boss", `${STAMP} Bo Admin`);
    await pool().query("UPDATE users SET role = 'admin' WHERE id = $1", [boss.id]);
    const before = process.env.COMPASSDOCS_AUTHZ_LEGACY;
    process.env.COMPASSDOCS_AUTHZ_LEGACY = "1";
    try {
      assert.ok((await hooks.webhookAdminIds()).includes(boss.id), "a workspace admin with no desk role row is a desk Admin there");
    } finally {
      if (before === undefined) delete process.env.COMPASSDOCS_AUTHZ_LEGACY;
      else process.env.COMPASSDOCS_AUTHZ_LEGACY = before;
    }
  });
});
