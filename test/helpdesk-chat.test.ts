// Helpdesk 1.19.4 chat apps: Microsoft Teams and Slack intake
// (lib/helpdesk/chat). In-process fakes of the Bot Framework (OpenID
// metadata, signing keys, the token endpoint, the Bot Connector) and of
// Slack's Web API run on 127.0.0.1 (test/support/fake-chat); the chat
// transport sends every call there, so nothing reaches Microsoft or Slack.
// Covered:
//
//   verify     Slack: signed, wrong secret, stale timestamp, no headers,
//              another workspace, url_verification; Teams: a good token,
//              an unlisted key, alg, issuer, audience, expiry, serviceurl,
//              endorsement (channelId), tenant, no token; keys cached;
//              disconnected apps read nothing; 413 over 256 KB
//   identity   Teams by Entra object ID through the directory; Slack by a
//              confirmed address (self-set, shared and unconfirmed-by-Slack
//              addresses refused); "ask IT to add you"
//   raise      Slack DM → suggestion (stamped type) + card → Raise → ticket
//              (source slack, type, team), thread kept, double click raises
//              one; Teams DM → card → Edit (type, body) → ticket
//   follow     a public desk reply reaches the chat; an internal note and a
//              held newbie reply never do; a Slack thread reply and a Teams
//              plain reply become the requester's messages
//   approvals  the card goes to the approver; their click decides it (and
//              replaces the card); someone else is told "Only … can
//              decide this"; a decline needs a reason
//   channels   a mention in a configured channel opens a ticket for its
//              team; a reaction too; an unconfigured channel doesn't; an
//              unknown poster gets no ticket; one ticket per message;
//              agents' Turn into a ticket (toggle off: refused; not an
//              agent: refused)
//   settings   the route (settings.manage, no secret in the view, sealed at
//              rest, a new app ID needs the secret again, channel checks,
//              audit without secrets, disconnect forgets links); Test
//              (the secret scrubbed from Microsoft's error; missing Slack
//              scopes)
//   privacy    anonymising drops threads, merge moves them, the export lists
//              accounts and requests, account removal cascades
//   limits     20 messages a minute per chat account
//
// Parallel-safe: people, teams, types, tickets and chat ids are this file's
// own (STAMP). Chat settings are overridden in-process; the settings-route
// test writes the real row under an advisory lock and restores it.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-chat.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startFakeChat, slackMember, SERVICE_URL, type FakeChat, type Obj } from "./support/fake-chat";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-chat.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-chat.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const jar = () => {
    const m = new Map<string, string>();
    for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) m.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
    }
    return m;
  };
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const j = jar();
      return { get: (name: string) => (j.has(name) ? { name, value: j.get(name) } : undefined), getAll: () => [...j].map(([name, value]) => ({ name, value })), has: (n: string) => j.has(n) };
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

// Secrets are sealed at rest: give secretbox a key so it never needs the uploads key file.
process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

/* eslint-disable @typescript-eslint/no-require-imports */
const settings = require("../src/lib/helpdesk/chat/settings") as typeof import("../src/lib/helpdesk/chat/settings");
const chatHttp = require("../src/lib/helpdesk/chat/http") as typeof import("../src/lib/helpdesk/chat/http");
const teamsMod = require("../src/lib/helpdesk/chat/teams") as typeof import("../src/lib/helpdesk/chat/teams");
const slackMod = require("../src/lib/helpdesk/chat/slack") as typeof import("../src/lib/helpdesk/chat/slack");
const core = require("../src/lib/helpdesk/chat/core") as typeof import("../src/lib/helpdesk/chat/core");
const inbound = require("../src/lib/helpdesk/chat/inbound") as typeof import("../src/lib/helpdesk/chat/inbound");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const withTx = (require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core")).withTx;
const adminRoute = require("../src/app/api/helpdesk/admin/chat/route") as typeof import("../src/app/api/helpdesk/admin/chat/route");
const adminTestRoute = require("../src/app/api/helpdesk/admin/chat/test/route") as typeof import("../src/app/api/helpdesk/admin/chat/test/route");
const teamsRoute = require("../src/app/api/helpdesk/chat/teams/messages/route") as typeof import("../src/app/api/helpdesk/chat/teams/messages/route");
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, req: Request): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve({}) });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}
const adminReq = (session: string, body?: unknown, method = body === undefined ? "GET" : "PUT") =>
  new Request("http://localhost/api/helpdesk/admin/chat", { method, headers: { cookie: `compass_session=${session}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const STAMP = `hdch-${Date.now()}-${process.pid}`;
const STARTED = new Date().toISOString();
const SID = `${Date.now().toString(36)}${process.pid.toString(36)}`.toUpperCase();
const APP_ID = randomUUID();
const TENANT = randomUUID();
const SECRET = `teams-secret-${STAMP}-abcdefghijkl`;
const SLACK_TOKEN = `xoxb-${SID}-fake-token`;
const SIGNING = "0123456789abcdef0123456789abcdef";
const P: Record<string, { id: number; session: string; name: string; email: string; aad: string; slack: string }> = {};
const personIds: number[] = [];
const teamIds: number[] = [];
const typeIds: number[] = [];
const workflowIds: number[] = [];
const dirIds: number[] = [];
let IT = 0;
let FAC = 0;
let fake: FakeChat;

function chatSettings(over: Partial<import("../src/lib/helpdesk/chat/settings").ChatSettings> = {}): import("../src/lib/helpdesk/chat/settings").ChatSettings {
  const ab = { raise: true, follow: true, approve: true, channel_ticket: true };
  const stamp = { connected_at: new Date().toISOString(), connected_by: "Test", last_test: null };
  return {
    teams: { app_id: APP_ID, secret: SECRET, tenant_id: TENANT, abilities: { ...ab }, ...stamp },
    slack: { bot_token: SLACK_TOKEN, signing_secret: SIGNING, team_id: "T0FAKE", team_name: "Acme", bot_user_id: "UBOT", abilities: { ...ab }, ...stamp },
    channels: [
      { id: "c1", app: "slack", channel_id: `C${SID}1`, name: "it-help", team_id: IT, trigger: "mention", reaction: "" },
      { id: "c2", app: "slack", channel_id: `C${SID}2`, name: "facilities", team_id: FAC, trigger: "reaction", reaction: "ticket" },
      { id: "c3", app: "teams", channel_id: `19:${SID}@thread.tacv2`, name: "it-help", team_id: IT, trigger: "mention", reaction: "" },
    ],
    ...over,
  };
}

async function person(key: string, name: string, opts: { selfSet?: boolean; deskRole?: string; aad?: boolean } = {}) {
  const mail = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, email_self_set) VALUES ($1, $2, $3, 'viewer', 'active', $4) RETURNING id`, [`${STAMP}-${key}`, name, mail, opts.selfSet ? 1 : 0]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  personIds.push(id);
  if (opts.deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, opts.deskRole]);
  const aad = randomUUID();
  if (opts.aad !== false) {
    const dp = await pool().query("INSERT INTO directory_people (source, external_id, name, email) VALUES ('graph', $1, $2, $3) RETURNING id", [aad, name, mail]);
    dirIds.push(dp.rows[0].id);
    await pool().query("UPDATE users SET directory_person_id = $2 WHERE id = $1", [id, dp.rows[0].id]);
  }
  const slack = `U${SID}${key.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
  P[key] = { id, session, name, email: mail, aad, slack };
  fake.state.slack.users.push(slackMember(slack, mail, name));
}

// --- Requests the platforms would send -------------------------------------------------------

function slackReq(body: string | Obj, opts: { secret?: string; ts?: number; form?: boolean; headers?: Record<string, string> } = {}): Request {
  const raw = typeof body === "string" ? body : opts.form ? `payload=${encodeURIComponent(JSON.stringify(body))}` : JSON.stringify(body);
  const h = fake.slackHeaders(opts.secret ?? SIGNING, raw, opts.ts);
  return new Request("http://localhost/api/helpdesk/chat/slack/events", {
    method: "POST",
    headers: { "content-type": opts.form ? "application/x-www-form-urlencoded" : "application/json", ...h, ...(opts.headers ?? {}) },
    body: raw,
  });
}

async function slack(body: Obj, opts: { form?: boolean } = {}) {
  const r = await inbound.handleSlackRequest(slackReq(body, opts));
  if (r.work) await r.work();
  return r;
}

let evSeq = 0;
const slackDm = (who: string, text: string, extra: Obj = {}) =>
  slack({ type: "event_callback", team_id: "T0FAKE", event_id: `Ev${SID}${++evSeq}`, event: { type: "message", channel_type: "im", channel: `D${P[who].slack.slice(1)}`, user: P[who].slack, text, ts: `${1_800_000_000 + evSeq}.0001`, ...extra } });

function teamsActivity(who: string, over: Obj = {}): Obj {
  return {
    type: "message",
    id: `a-${SID}-${++evSeq}`,
    channelId: "msteams",
    serviceUrl: SERVICE_URL,
    from: { id: `29:${P[who]?.aad ?? "x"}`, aadObjectId: P[who]?.aad ?? randomUUID(), name: P[who]?.name ?? "Stranger" },
    recipient: { id: `28:${APP_ID}`, name: "CompassDocs" },
    conversation: { id: `a:${SID}-${who}`, conversationType: "personal", tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    ...over,
  };
}

function teamsReq(activity: Obj, token?: string | null): Request {
  return new Request("http://localhost/api/helpdesk/chat/teams/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token ?? fake.teamsJwt()}` }) },
    body: JSON.stringify(activity),
  });
}

async function teams(activity: Obj, token?: string | null) {
  const r = await inbound.handleTeamsRequest(teamsReq(activity, token));
  if (r.work) await r.work();
  return r;
}

const slackSent = (channel: string) => fake.state.slack.messages.get(channel) ?? [];
const lastSlack = (channel: string) => slackSent(channel).at(-1);
const teamsSent = (conv: string) => fake.state.teams.posted.filter((p) => decodeURIComponent(p.path).includes(conv));
const dmOf = (who: string) => `D${P[who].slack.slice(1)}`;
async function until<T>(fn: () => T | Promise<T>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}
const ticketsOf = async (who: string) =>
  (await pool().query("SELECT id, number, subject, source, team_id, request_type_id FROM hd_tickets WHERE requester_id = $1 ORDER BY id", [P[who].id])).rows;
const auditRows = async (action: string) => (await pool().query("SELECT actor_id, details FROM audit_log WHERE action = $1 AND actor_id = ANY($2) ORDER BY id", [action, personIds])).rows;

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  email.setHelpdeskTransportForTests(async () => {});
  fake = await startFakeChat({ appId: APP_ID, secret: SECRET, tenant: TENANT, slackToken: SLACK_TOKEN });
  chatHttp.setChatTransportForTests(fake.transport);
  teamsMod.resetTeamsKeysForTests();
  for (const [k, n] of [["IT", "IT Service Desk"], ["FAC", "Facilities"]] as const) {
    const r = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9500) RETURNING id", [`${STAMP} ${n}`]);
    teamIds.push(r.rows[0].id);
    if (k === "IT") IT = r.rows[0].id;
    else FAC = r.rows[0].id;
  }
  await person("req", "Daniel Okafor");
  await person("appr", "Ana Kowalski");
  await person("agent", "Ivy Agent", { deskRole: "agent" });
  await person("newbie", "Nia Newbie", { deskRole: "newbie" });
  await person("other", "Omar Other");
  await person("selfset", "Sam Selfset", { selfSet: true });
  await person("dup1", "Dee One");
  await person("dup2", "Dee Two");
  await pool().query("UPDATE users SET email = $2 WHERE id = $1", [P.dup2.id, P.dup1.email]);
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent')", [IT, P.agent.id, P.newbie.id]);
  fake.state.slack.users.push(slackMember(`U${SID}UNCONF`, P.other.email, "Unconfirmed", { is_email_confirmed: false }));
  fake.state.slack.users.push(slackMember(`U${SID}NOBODY`, `${STAMP}-nobody@example.test`, "Nobody"));
  // A type the chat can raise (no required question), with stamped words to match on.
  const rt = await requestTypes.validateRequestTypeInput({ title: `Zorbex quillon problem ${STAMP}`, description: "Zorbex laptops and docks", team_id: IT, form: [] });
  assert.ok(rt.ok);
  typeIds.push((await requestTypes.createRequestType(rt.value)).id);
  settings.setChatSettingsForTests(chatSettings());
});

after(async () => {
  settings.setChatSettingsForTests(null);
  chatHttp.setChatTransportForTests(null);
  email.setHelpdeskTransportForTests(null);
  await fake.close();
  const ts = (await pool().query("SELECT id FROM hd_tickets WHERE requester_id = ANY($1) OR team_id = ANY($2)", [personIds, teamIds])).rows.map((r) => r.id);
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL, merged_into = NULL WHERE id = ANY($1)", [ts]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [ts]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ts]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1)", [workflowIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [teamIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM directory_people WHERE id = ANY($1)", [dirIds]);
  // Replay keys and channel claims are hashes: this run's are the ones written since it started (only chat events write here).
  await pool().query("DELETE FROM hd_chat_seen WHERE event_id LIKE $1 OR at >= $2::timestamptz", [`%${SID}%`, STARTED]);
  await pool().end();
});

// --- Verification --------------------------------------------------------------------------

describe("verification", () => {
  test("Slack: a signed request is read; a wrong secret, a stale timestamp or no signature is 401", async () => {
    const ok = await inbound.handleSlackRequest(slackReq({ type: "url_verification", challenge: "abc123" }));
    assert.deepEqual([ok.status, ok.body], [200, { challenge: "abc123" }]);
    for (const r of [
      slackReq({ type: "url_verification", challenge: "x" }, { secret: "ffffffffffffffffffffffffffffffff" }),
      slackReq({ type: "url_verification", challenge: "x" }, { ts: Math.floor(Date.now() / 1000) - 301 }),
      new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "url_verification", challenge: "x" }) }),
      slackReq(JSON.stringify({ type: "url_verification", challenge: "x" }), { headers: { "x-slack-signature": "v0=00" } }),
    ]) {
      const res = await inbound.handleSlackRequest(r);
      assert.equal(res.status, 401);
      assert.equal(res.work, undefined);
    }
    // Another workspace's event, signed with our secret all the same, is refused.
    const other = await inbound.handleSlackRequest(slackReq({ type: "event_callback", team_id: "TOTHER", event_id: "Ev1", event: { type: "message" } }));
    assert.equal(other.status, 401);
    assert.equal(slackMod.verifySlackSignature(SIGNING, "1", "{}", slackMod.slackSignature(SIGNING, "1", "{}"), 1000 + 300_000), true);
  });

  test("Teams: only a Bot Framework token for this app, channel, service and tenant is read", async () => {
    const a = (over: Obj = {}) => teamsActivity("req", { type: "conversationUpdate", ...over });
    assert.equal((await teams(a())).status, 200);
    const bad: [string, string | null, Obj?][] = [
      ["no token", null],
      ["unlisted key", fake.teamsJwt({}, { rogue: true })],
      ["unknown kid", fake.teamsJwt({}, { kid: "nope" })],
      ["HS256", fake.teamsJwt({}, { alg: "HS256" })],
      ["issuer", fake.teamsJwt({ iss: "https://evil.example" })],
      ["audience", fake.teamsJwt({ aud: randomUUID() })],
      ["expired", fake.teamsJwt({ exp: Math.floor(Date.now() / 1000) - 600 })],
      ["not yet", fake.teamsJwt({ nbf: Math.floor(Date.now() / 1000) + 900 })],
      ["serviceurl", fake.teamsJwt({ serviceurl: "https://smba.trafficmanager.net/other/" })],
      ["endorsement", fake.teamsJwt(), { channelId: "webchat" }],
      ["tenant", fake.teamsJwt(), { conversation: { id: "a:x", conversationType: "personal", tenantId: randomUUID() }, channelData: {} }],
    ];
    for (const [why, token, over] of bad) {
      const r = await inbound.handleTeamsRequest(teamsReq(a(over ?? {}), token));
      assert.equal(r.status, 401, why);
      assert.equal(r.work, undefined, why);
    }
    // The keys were read once and cached (an unknown kid refetches at most every 5 minutes).
    assert.equal(fake.state.teams.keyCalls, 1);
    // Through the route too.
    assert.equal((await call(teamsRoute.POST, teamsReq(a(), null))).status, 401);
  });

  test("a disconnected app reads nothing, and a body over 256 KB is 413", async () => {
    settings.setChatSettingsForTests(chatSettings({ slack: { ...chatSettings().slack, bot_token: "", signing_secret: "" }, teams: { ...chatSettings().teams, secret: "" } }));
    try {
      assert.equal((await inbound.handleSlackRequest(slackReq({ type: "url_verification", challenge: "x" }))).status, 401);
      assert.equal((await inbound.handleTeamsRequest(teamsReq(teamsActivity("req")))).status, 401);
    } finally {
      settings.setChatSettingsForTests(chatSettings());
    }
    const big = await inbound.handleSlackRequest(slackReq({ type: "event_callback", pad: "x".repeat(300 * 1024) }));
    assert.equal(big.status, 413);
  });
});

// --- Identity and raising ---------------------------------------------------------------------

describe("raise and follow", () => {
  test("Slack: people who don't map get 'ask IT to add you' and no ticket", async () => {
    for (const id of [`U${SID}NOBODY`, `U${SID}UNCONF`, P.selfset.slack, P.dup1.slack]) {
      const ch = `D${id.slice(1)}`;
      await slack({ type: "event_callback", team_id: "T0FAKE", event_id: `Ev${SID}${++evSeq}`, event: { type: "message", channel_type: "im", channel: ch, user: id, text: "My zorbex quillon is broken", ts: "1.1" } });
      assert.match(lastSlack(ch)?.text ?? "", /Ask IT to add you/, id);
    }
    assert.equal((await ticketsOf("selfset")).length, 0);
    assert.equal((await ticketsOf("dup1")).length, 0);
  });

  test("Slack: a DM suggests the type and raises one ticket from the card, however often it is clicked", async () => {
    await slackDm("req", "My zorbex quillon won't connect to the VPN from home");
    const sent = slackSent(dmOf("req"));
    assert.match(sent.at(-2)!.text, /Zorbex quillon problem/);
    assert.match(sent.at(-2)!.text, /IT Service Desk/);
    const card = sent.at(-1)!;
    const raise = card.blocks.find((b: Obj) => b.type === "actions").elements.find((e: Obj) => e.action_id === "cd_raise");
    const click = { type: "block_actions", team: { id: "T0FAKE" }, user: { id: P.req.slack }, channel: { id: dmOf("req") }, message: { ts: card.ts }, actions: [{ action_id: "cd_raise", value: raise.value }] };
    await slack(click, { form: true });
    await slack(click, { form: true });
    const mine = await ticketsOf("req");
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0].source, mine[0].team_id, mine[0].request_type_id], ["slack", IT, typeIds[0]]);
    assert.match(mine[0].subject, /zorbex quillon/);
    const texts = slackSent(dmOf("req")).map((m) => m.text);
    assert.ok(texts.some((t) => t.includes(`Done: *#${mine[0].number}*`)));
    assert.ok(texts.some((t) => t.includes(`Already raised: *#${mine[0].number}*`)));
    const thread = (await pool().query("SELECT app, kind, conversation_id, thread_id FROM hd_chat_threads WHERE ticket_id = $1", [mine[0].id])).rows[0];
    assert.deepEqual([thread.app, thread.kind, thread.conversation_id], ["slack", "dm", dmOf("req")]);
    assert.ok(thread.thread_id);
    assert.equal((await auditRows("helpdesk.chat.request_raised")).filter((r) => r.actor_id === P.req.id).length, 1);
  });

  test("follow: a public desk reply reaches the Slack thread; a note and a held newbie reply never do; the requester's thread reply comes back", async () => {
    const [t] = await ticketsOf("req");
    const thread = (await pool().query("SELECT thread_id FROM hd_chat_threads WHERE ticket_id = $1", [t.id])).rows[0].thread_id;
    const before = slackSent(dmOf("req")).length;
    await messages.addMessage(t.id, { kind: "internal", body: "Internal: check the RADIUS logs", author: { id: P.agent.id, name: P.agent.name, email: P.agent.email }, via: "desk" });
    const held = await messages.addMessage(t.id, { kind: "public", body: "Held newbie reply", author: { id: P.newbie.id, name: P.newbie.name, email: P.newbie.email }, via: "desk" });
    assert.equal(held?.held, true);
    await messages.addMessage(t.id, { kind: "public", body: "Could you follow the 3 steps in **Re-pair the VPN client**?", author: { id: P.agent.id, name: P.agent.name, email: P.agent.email }, via: "desk" });
    const reply = await until(() => slackSent(dmOf("req")).slice(before).find((m) => /replied on/.test(m.text)));
    assert.ok(reply, "the reply reached Slack");
    assert.match(reply.text, new RegExp(`\\*Ivy Agent \\(${STAMP} IT Service Desk\\)\\* replied on #${t.number}`));
    assert.equal(reply.thread_ts, thread);
    const all = slackSent(dmOf("req")).slice(before).map((m) => m.text).join("\n");
    assert.doesNotMatch(all, /RADIUS|Held newbie/);
    // The requester answers in the thread.
    await slackDm("req", "That worked, thanks!", { thread_ts: thread });
    const last = (await pool().query("SELECT author_id, kind, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
    assert.deepEqual([last.author_id, last.kind, last.body], [P.req.id, "public", "That worked, thanks!"]);
  });

  test("Teams: a DM card's Edit raises with the chosen type and text; a plain reply later goes to that request", async () => {
    const conv = `a:${SID}-appr`;
    await teams(teamsActivity("appr", { text: "<p>The printer on floor 3 jams</p>" }));
    const card = teamsSent(conv).at(-1)!.body;
    const draft = card.attachments[0].content.actions[0].data.d;
    assert.equal(card.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
    await teams(teamsActivity("appr", { value: { cd: "raise", d: draft, edited: true, type: String(typeIds[0]), body: "Floor 3 printer jams on every job" } }));
    const [t] = await ticketsOf("appr");
    assert.deepEqual([t.source, t.request_type_id, t.team_id], ["teams", typeIds[0], IT]);
    assert.match(t.subject, /Floor 3 printer jams/);
    assert.match(teamsSent(conv).at(-1)!.body.text, new RegExp(`Done: \\*\\*#${t.number}\\*\\*`));
    // Sent with the bot's own token.
    assert.match(teamsSent(conv).at(-1)!.auth, /^Bearer bot-token-/);
    await teams(teamsActivity("appr", { text: "It works after a restart" }));
    const last = (await pool().query("SELECT author_id, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
    assert.deepEqual([last.author_id, last.body], [P.appr.id, "It works after a restart"]);
    assert.match(teamsSent(conv).at(-1)!.body.text, new RegExp(`Added to #${t.number}`));
    // "new request" starts over.
    await teams(teamsActivity("appr", { text: "new request" }));
    assert.match(teamsSent(conv).at(-1)!.body.text, /What do you need help with/);
  });

  test("Teams: an unknown person gets the polite reply and no ticket", async () => {
    const act = teamsActivity("nobody", { from: { id: "29:x", aadObjectId: randomUUID(), name: "Stranger" }, conversation: { id: `a:${SID}-nobody`, conversationType: "personal", tenantId: TENANT }, text: "help me with my zorbex" });
    await teams(act);
    assert.match(teamsSent(`a:${SID}-nobody`).at(-1)!.body.text, /Ask IT to add you/);
  });

  test("20 messages a minute per chat account, then a slow-down line", async () => {
    const ch = dmOf("other");
    // other's Slack account is unconfirmed-by-address? No: P.other has a confirmed member too; use them.
    for (let i = 0; i < 21; i++) await slackDm("other", "hello");
    assert.match(lastSlack(ch)!.text, /lot of messages/);
  });
});

// --- Approvals ------------------------------------------------------------------------------

describe("approvals", () => {
  let approvalId = 0;
  let accessType = 0;
  test("the approver gets a card; someone else's click is refused; the approver's own click decides", async () => {
    const steps = [
      { key: "a", kind: "approval", title: "Ana approves", approver: { kind: "user", user_id: P.appr.id }, on_decline: "close" },
      { key: "done", kind: "finish", title: "Done", csat: false },
    ];
    const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} flow` });
    const def = workflows.parseWorkflowDefinition({ trigger: {}, steps });
    assert.ok(meta.ok && def.ok);
    const wf = await workflows.createWorkflow(meta.value, def.value);
    workflowIds.push(wf.id);
    const rtIn = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Access to an app`, team_id: IT, form: [], workflow_id: wf.id });
    assert.ok(rtIn.ok);
    const rt = await requestTypes.createRequestType(rtIn.value);
    typeIds.push(rt.id);
    accessType = rt.id;
    assert.ok((await workflows.publishWorkflow(wf.id)).ok);
    // Ana has a Teams chat with the app (it was installed for her).
    await teams(teamsActivity("appr", { type: "installationUpdate", action: "add" }));
    const before = teamsSent(`a:${SID}-appr`).length;
    const t = await tickets.createTicket({ subject: `${STAMP} Figma`, body: "Design reviews", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, request_type_id: rt.id, answers: {} }, { actorId: P.req.id });
    const card = await until(() => teamsSent(`a:${SID}-appr`).slice(before).find((p) => p.body.attachments?.[0]?.content?.body?.[0]?.text === "Approval needed"));
    assert.ok(card, "the approval card was sent to Ana's chat");
    assert.match(card.body.attachments[0].content.body[1].text, new RegExp(`Daniel Okafor asks for .* · #${t.number}`));
    approvalId = card.body.attachments[0].content.actions[0].data.a;
    // Omar clicks (a forwarded card): refused, nothing decided.
    const omar = await core.handleApprovalClick((await core.portFor("teams"))!, { person: { app: "teams", id: P.other.aad, name: "Omar" }, action: "approve", approvalId, ref: { service_url: SERVICE_URL, conversation_id: `a:${SID}-other` }, cardId: "" });
    assert.deepEqual(omar, { ok: false, error: "Only Ana Kowalski can decide this." });
    // A decline needs a reason.
    const noNote = await core.handleApprovalClick((await core.portFor("teams"))!, { person: { app: "teams", id: P.appr.aad, name: "Ana" }, action: "decline", approvalId, text: "", ref: { service_url: SERVICE_URL, conversation_id: `a:${SID}-appr` }, cardId: "" });
    assert.equal(noNote.ok, false);
    // Review fix (high): Ask a question from the card reaches the requester like the web's (here: their bell).
    const bells = async () => (await pool().query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND link LIKE $2", [P.req.id, `/help/requests/${t.number}%`])).rows[0].n as number;
    const bellsBefore = await bells();
    await teams(teamsActivity("appr", { value: { cd: "ask", a: approvalId, question: "Which cost centre?" } }));
    const q = (await pool().query("SELECT author_id, kind, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
    assert.deepEqual([q.author_id, q.kind, q.body], [P.appr.id, "public", "Which cost centre?"]);
    assert.ok(await until(async () => (await bells()) > bellsBefore), "the requester was told about the question");
    assert.match(teamsSent(`a:${SID}-appr`).at(-1)!.body.text, /Your question is on/);
    // Ana approves from the card: decided in her name, the card replaced.
    await teams(teamsActivity("appr", { replyToId: "act-card-1", value: { cd: "approve", a: approvalId } }));
    const row = (await pool().query("SELECT decision, decided_by FROM hd_approvals WHERE id = $1", [approvalId])).rows[0];
    assert.deepEqual([row.decision, row.decided_by], ["approved", P.appr.id]);
    const put = fake.state.teams.posted.find((p) => p.method === "PUT" && p.path.endsWith("/act-card-1"));
    assert.ok(put);
    assert.equal(put.body.attachments[0].content.body[0].text, "Approved");
    const a = (await pool().query("SELECT actor_id, target_id, details FROM audit_log WHERE action = 'helpdesk.chat.approval_clicked' AND actor_id = $1 ORDER BY id", [P.appr.id])).rows;
    assert.ok(a.some((r) => r.details.app === "teams" && r.details.outcome === "approved"));
    // Review fix: filed under the ticket's id, not its number.
    assert.ok(a.every((r) => r.target_id === String(t.id)));
    // A second click: already decided.
    await teams(teamsActivity("appr", { value: { cd: "approve", a: approvalId } }));
    assert.match(teamsSent(`a:${SID}-appr`).at(-1)!.body.text, /already been decided/);
  });

  test("Slack: an approver found by address gets the card; Decline… asks for the reason in a modal", async () => {
    const before = fake.state.slack.calls.length;
    await core.sendApprovalCards(approvalId, [P.appr.id]);
    // Already decided: no card.
    assert.equal(fake.state.slack.calls.slice(before).filter((c) => c.method === "chat.postMessage").length, 0);
    const click = { type: "block_actions", team: { id: "T0FAKE" }, user: { id: P.appr.slack }, channel: { id: dmOf("appr") }, trigger_id: "trig-1", message: { ts: "1.2" }, actions: [{ action_id: "cd_decline", value: String(approvalId) }] };
    await slack(click, { form: true });
    const view = fake.state.slack.calls.filter((c) => c.method === "views.open").at(-1)!;
    assert.equal(view.body.view.callback_id, "cd_decline");
    // Submitting it on a decided approval shows the refusal in the form.
    const sub: { body?: any } = await inbound.handleSlackRequest(slackReq({ type: "view_submission", team: { id: "T0FAKE" }, user: { id: P.appr.slack }, view: { callback_id: "cd_decline", private_metadata: view.body.view.private_metadata, state: { values: { text: { v: { value: "No budget" } } } } } }, { form: true }));
    assert.equal(sub.body.response_action, "errors");
    assert.match(sub.body.errors.text, /already been decided/);
  });

  test("Slack: a Decline modal is answered at once and decided after the answer; an empty reason is refused in the form", async () => {
    const t = await tickets.createTicket({ subject: `${STAMP} Miro`, body: "Workshops", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, request_type_id: accessType, answers: {} }, { actorId: P.req.id });
    const ap = await until(async () => (await pool().query("SELECT id FROM hd_approvals WHERE ticket_id = $1", [t.id])).rows[0]?.id as number | undefined);
    assert.ok(ap);
    const submit = (text: string) =>
      inbound.handleSlackRequest(slackReq({ type: "view_submission", team: { id: "T0FAKE" }, user: { id: P.appr.slack }, view: { callback_id: "cd_decline", private_metadata: JSON.stringify({ a: ap, c: dmOf("appr"), ts: "1.3" }), state: { values: { text: { v: { value: text } } } } } }, { form: true }));
    const empty: { body?: any } = await submit("  ");
    assert.equal(empty.body.response_action, "errors");
    const r = await submit("No budget this quarter");
    assert.deepEqual(r.body, { response_action: "clear" });
    assert.ok(r.work, "the decision runs after the answer");
    assert.equal((await pool().query("SELECT decision FROM hd_approvals WHERE id = $1", [ap])).rows[0].decision, "pending");
    await r.work!();
    const row = (await pool().query("SELECT decision, decided_by, note FROM hd_approvals WHERE id = $1", [ap])).rows[0];
    assert.deepEqual([row.decision, row.decided_by, row.note], ["declined", P.appr.id, "No budget this quarter"]);
  });
});

// --- Channels -------------------------------------------------------------------------------

describe("channels", () => {
  test("a mention in a configured channel opens a ticket for its team, once; an unconfigured channel doesn't", async () => {
    const ch = `C${SID}1`;
    fake.state.slack.messages.set(ch, []);
    const ev = (ts: string, channel = ch, user = P.newbie.slack) => ({ type: "event_callback", team_id: "T0FAKE", event_id: `Ev${SID}${++evSeq}`, event: { type: "app_mention", channel, user, text: `<@UBOT> The badge reader by the lift is dead`, ts } });
    await slack(ev("1700000100.000200"));
    await slack(ev("1700000100.000200"));
    const mine = await ticketsOf("newbie");
    const t = mine.find((x) => x.source === "slack")!;
    assert.ok(t);
    assert.equal(t.team_id, IT);
    assert.match(t.subject, /badge reader by the lift is dead/);
    const body = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 ORDER BY id LIMIT 1", [t.id])).rows[0].body;
    assert.match(body, /\[Open the message in Slack\]\(https:\/\/acme\.slack\.com\/archives\//);
    const replies = slackSent(ch);
    assert.match(replies[0].text, new RegExp(`Opened \\*#${t.number}\\* for ${STAMP} IT Service Desk`));
    assert.equal(replies[0].thread_ts, "1700000100.000200");
    assert.match(replies[1].text, /already #/);
    // Elsewhere: an ephemeral line, no ticket.
    await slack(ev("1700000101.000200", `C${SID}9`));
    assert.match(lastSlack(`C${SID}9`)!.text, /doesn't open tickets/);
    assert.equal(lastSlack(`C${SID}9`)!.method, "chat.postEphemeral");
  });

  test("the chosen reaction opens a ticket from the message, with its poster as requester; an unknown poster gets none", async () => {
    const ch = `C${SID}2`;
    fake.state.slack.messages.set(ch, [
      { ts: "1700000200.000100", user: P.req.slack, text: "The kitchen tap is leaking" },
      { ts: "1700000201.000100", user: `U${SID}NOBODY`, text: "Lights out in room 4" },
    ]);
    const react = (ts: string, reaction = "ticket") => ({ type: "event_callback", team_id: "T0FAKE", event_id: `Ev${SID}${++evSeq}`, event: { type: "reaction_added", user: P.agent.slack, reaction, item: { type: "message", channel: ch, ts } } });
    await slack(react("1700000200.000100", "thumbsup"));
    assert.equal((await ticketsOf("req")).filter((t) => t.team_id === FAC).length, 0);
    await slack(react("1700000200.000100"));
    const t = (await ticketsOf("req")).find((x) => x.team_id === FAC);
    assert.ok(t);
    assert.match(t.subject, /kitchen tap/);
    await slack(react("1700000201.000100"));
    assert.match(lastSlack(ch)!.text, /Ask IT to add you/);
  });

  test("Turn into a ticket: agents only, and only with the toggle on", async () => {
    const ch = `C${SID}3`;
    fake.state.slack.messages.set(ch, []);
    const action = (who: string, ts: string) => ({ type: "message_action", callback_id: "cd_make_ticket", team: { id: "T0FAKE" }, user: { id: P[who].slack }, channel: { id: ch, name: "general" }, message: { ts, user: P.req.slack, text: "Wifi in the annex keeps dropping" } });
    settings.setChatSettingsForTests(chatSettings({ slack: { ...chatSettings().slack, abilities: { raise: true, follow: true, approve: true, channel_ticket: false } } }));
    await slack(action("agent", "1700000300.1"), { form: true });
    assert.match(lastSlack(ch)!.text, /off for this app/);
    settings.setChatSettingsForTests(chatSettings());
    await slack(action("req", "1700000300.1"), { form: true });
    assert.match(lastSlack(ch)!.text, /Only helpdesk agents/);
    await slack(action("agent", "1700000300.1"), { form: true });
    const t = (await ticketsOf("req")).find((x) => /annex/.test(x.subject));
    assert.ok(t);
    assert.equal(t.team_id, IT); // the agent's one team
    const note = (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 AND kind = 'internal'", [t.id])).rows[0];
    assert.match(note.body, /Ivy Agent opened this from a message in #general/);
  });
});

// --- Review fixes (1.19.4 C1 review) -------------------------------------------------------

describe("review fixes", () => {
  test("Teams: a domain is refused as the tenant, and an activity naming no tenant is 401", async () => {
    const base = settings.parseChatSettings(JSON.stringify({ teams: { app_id: APP_ID, tenant_id: "contoso.onmicrosoft.com" } }));
    assert.equal(settings.appConnected({ ...base, teams: { ...base.teams, secret: SECRET } }, "teams"), false, "a domain never counts as connected");
    await assert.rejects(settings.saveChatSettings({ teams: { app_id: APP_ID, tenant_id: "contoso.onmicrosoft.com", secret: SECRET } }, "Test", new Set()), /tenant ID, a GUID/);
    const noTenant = teamsActivity("req", { type: "conversationUpdate", conversation: { id: "a:x", conversationType: "personal" }, channelData: {} });
    assert.equal((await inbound.handleTeamsRequest(teamsReq(noTenant))).status, 401);
  });

  test("Teams: the replay key includes the conversation, so the same activity id in two chats is handled twice", async () => {
    const id = `same-${SID}`;
    await teams(teamsActivity("req", { id, text: "hello" }));
    await teams(teamsActivity("agent", { id, text: "hello" }));
    assert.match(teamsSent(`a:${SID}-req`).at(-1)!.body.text, /What do you need help with/);
    assert.match(teamsSent(`a:${SID}-agent`).at(-1)!.body.text, /What do you need help with/);
    // And a true replay (same chat, same id) is still done once.
    const n = teamsSent(`a:${SID}-agent`).length;
    await teams(teamsActivity("agent", { id, text: "hello" }));
    assert.equal(teamsSent(`a:${SID}-agent`).length, n);
  });

  test("Teams: a whisper never posts in a channel: an unknown person's Get help says nothing there", async () => {
    const channelConv = `19:${SID}@thread.tacv2;messageid=777`;
    const before = fake.state.teams.posted.length;
    const act = teamsActivity("req", {
      type: "invoke",
      name: "composeExtension/fetchTask",
      from: { id: "29:stranger", aadObjectId: randomUUID(), name: "Stranger" },
      conversation: { id: channelConv, conversationType: "channel", tenantId: TENANT },
      channelData: { tenant: { id: TENANT }, channel: { id: `19:${SID}@thread.tacv2` } },
      value: { commandId: "getHelp", messagePayload: { id: "777", body: { content: "printer broken" }, from: { user: { id: randomUUID(), displayName: "Pat" } } } },
    });
    const r = await teams(act);
    assert.equal(r.status, 200);
    assert.equal(fake.state.teams.posted.slice(before).filter((p) => decodeURIComponent(p.path).includes(`19:${SID}`)).length, 0);
  });

  test("Slack: a reply in a thread that belongs to no request starts a new one instead of joining the focused request", async () => {
    const [t] = await ticketsOf("req");
    await pool().query("UPDATE hd_chat_people SET focus_ticket_id = $2, focus_at = now() WHERE app = 'slack' AND user_id = $1", [P.req.id, t.id]);
    const last = async () => (await pool().query("SELECT max(id) AS id FROM hd_messages WHERE ticket_id = $1", [t.id])).rows[0].id;
    const before = await last();
    await slackDm("req", "Also my zorbex token expired", { thread_ts: "1799999999.000100" });
    assert.equal(await last(), before, "nothing was added to the focused request");
    const card = lastSlack(dmOf("req"))!;
    assert.equal(card.text, "Raise a request?");
    assert.equal(card.thread_ts, "1799999999.000100");
  });

  test("Slack: the link is only renewed by a real check, raising re-reads the person, and a member whose address moved stops getting the old account's replies", async () => {
    // A message alone doesn't renew the link.
    await pool().query("UPDATE hd_chat_people SET checked_at = now() - interval '23 hours' WHERE app = 'slack' AND chat_user_id = $1", [P.req.slack]);
    await slackDm("req", "new request");
    const age = (await pool().query("SELECT extract(epoch FROM now() - checked_at)::int AS s FROM hd_chat_people WHERE app = 'slack' AND chat_user_id = $1", [P.req.slack])).rows[0].s;
    assert.ok(age > 22 * 3600, "checked_at was not refreshed by the message");
    // Raising reads the person from Slack again (users.info), whatever the cache says.
    await slackDm("req", "My zorbex dock flickers");
    const card = lastSlack(dmOf("req"))!;
    const value = card.blocks.find((b: Obj) => b.type === "actions").elements[0].value;
    const infoCalls = () => fake.state.slack.calls.filter((c) => c.method === "users.info" && c.body.user === P.req.slack).length;
    const n = infoCalls();
    await slack({ type: "block_actions", team: { id: "T0FAKE" }, user: { id: P.req.slack }, channel: { id: dmOf("req") }, message: { ts: card.ts }, actions: [{ action_id: "cd_raise", value }] }, { form: true });
    assert.equal(infoCalls(), n + 1);
    // Mover's Slack address is changed to someone else's: their old direct chat gets no more desk replies.
    await person("mover", "Max Mover");
    const conv = `D${P.mover.slack.slice(1)}`;
    const t = await tickets.createTicket({ subject: `${STAMP} mover`, body: "x", requester: { id: P.mover.id, name: P.mover.name, email: P.mover.email }, team_id: IT }, { actorId: P.mover.id });
    await pool().query("INSERT INTO hd_chat_people (app, chat_user_id, user_id, dm_ref, checked_at) VALUES ('slack', $1, $2, $3::jsonb, now() - interval '2 days')", [P.mover.slack, P.mover.id, JSON.stringify({ conversation_id: conv })]);
    await pool().query("INSERT INTO hd_chat_threads (ticket_id, app, kind, user_id, conversation_id) VALUES ($1, 'slack', 'dm', $2, $3)", [t.id, P.mover.id, conv]);
    const member = fake.state.slack.users.find((u) => u.id === P.mover.slack)!;
    member.profile.email = P.other.email;
    try {
      await messages.addMessage(t.id, { kind: "public", body: "Here is your answer", author: { id: P.agent.id, name: P.agent.name, email: P.agent.email }, via: "desk" });
      await core.sendDeskReply(t.id, (await pool().query("SELECT max(id) AS id FROM hd_messages WHERE ticket_id = $1", [t.id])).rows[0].id);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(slackSent(conv).length, 0, "nothing went to the member who is no longer Max");
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_chat_threads WHERE ticket_id = $1 AND conversation_id = $2", [t.id, conv])).rows[0].n, 0);
    } finally {
      member.profile.email = P.mover.email;
    }
  });

  test("Slack: when the Done line can't be posted the request keeps its chat link", async () => {
    await slackDm("agent", "My zorbex keyboard lost keys");
    const card = lastSlack(dmOf("agent"))!;
    const value = card.blocks.find((b: Obj) => b.type === "actions").elements[0].value;
    fake.state.fail.set("slack.com/api/chat.postMessage", { status: 500, times: 1 });
    try {
      await slack({ type: "block_actions", team: { id: "T0FAKE" }, user: { id: P.agent.slack }, channel: { id: dmOf("agent") }, message: { ts: card.ts }, actions: [{ action_id: "cd_raise", value }] }, { form: true });
    } finally {
      fake.state.fail.delete("slack.com/api/chat.postMessage");
    }
    const t = (await ticketsOf("agent")).find((x) => /keyboard/.test(x.subject));
    assert.ok(t);
    const row = (await pool().query("SELECT kind, conversation_id FROM hd_chat_threads WHERE ticket_id = $1", [t.id])).rows[0];
    assert.deepEqual([row.kind, row.conversation_id], ["dm", dmOf("agent")]);
    assert.equal((await pool().query("SELECT focus_ticket_id FROM hd_chat_people WHERE app = 'slack' AND chat_user_id = $1", [P.agent.slack])).rows[0].focus_ticket_id, t.id);
  });

  test("two triggers for one message arriving together open one ticket", async () => {
    const ch = `C${SID}2`;
    const ts = "1700000400.000100";
    fake.state.slack.messages.set(ch, [{ ts, user: P.other.slack, text: "Fire door on floor 2 won't close" }]);
    const react = (who: string) => ({ type: "event_callback", team_id: "T0FAKE", event_id: `Ev${SID}${++evSeq}`, event: { type: "reaction_added", user: P[who].slack, reaction: "ticket", item: { type: "message", channel: ch, ts } } });
    await Promise.all([slack(react("agent")), slack(react("newbie")), slack(react("req"))]);
    const made = (await ticketsOf("other")).filter((x) => /Fire door/.test(x.subject));
    assert.equal(made.length, 1);
    const idx = (await pool().query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_hd_chat_threads_channel_msg'")).rows[0]?.indexdef ?? "";
    assert.match(idx, /UNIQUE/);
  });
});

// --- Privacy --------------------------------------------------------------------------------

describe("privacy", () => {
  test("the export lists chat accounts and requests; merge moves threads; anonymising drops them; account removal cascades", async () => {
    const own = await ticketsOf("req");
    const ex = await retention.personalHelpdeskExport(P.req.id);
    if (ex.included) {
      assert.ok(ex.chat!.accounts.some((a) => a.app === "Slack"));
      assert.ok(ex.chat!.requests.some((r) => r.number === own[0].number && r.app === "Slack" && r.where === "direct chat"));
    }
    // Merge: a ticket opened from a channel message into a fresh one.
    const keep = await tickets.createTicket({ subject: `${STAMP} keep`, body: "x", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, team_id: IT }, { actorId: P.req.id });
    // Review fix: Nia's channel request merged into Daniel's ticket stays in Nia's export (by its own number) and never shows in Daniel's.
    const nia = (await ticketsOf("newbie")).find((x) => x.source === "slack")!;
    const annex = own.find((x) => /annex/.test(x.subject))!;
    await merge.mergeTickets({ id: P.agent.id, name: P.agent.name, username: "agent", role: "viewer" } as never, { keep: keep.number, merge: [annex.number, nia.number], notify: false });
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_chat_threads WHERE ticket_id = $1", [keep.id])).rows[0].n >= 2, true);
    const mine = await retention.personalHelpdeskExport(P.req.id);
    const hers = await retention.personalHelpdeskExport(P.newbie.id);
    if (mine.included && hers.included) {
      assert.ok(!mine.chat!.requests.some((r) => r.number === nia.number || r.number === keep.number), "no one else's chat thread");
      assert.ok(mine.chat!.requests.some((r) => r.number === annex.number && r.where === "channel"), "a merged request keeps its own number");
      assert.ok(hers.chat!.requests.some((r) => r.number === nia.number && r.app === "Slack" && r.where === "channel"));
    }
    await withTx((client) => retention.anonymiseTicketTx(client, keep.id));
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_chat_threads WHERE ticket_id = $1", [keep.id])).rows[0].n, 0);
    // Removing an account takes its chat links, cards and threads with it.
    const gone = (await fixtureQuery("INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Gil Gone', $2, 'viewer', 'active') RETURNING id", [`${STAMP}-gone`, `${STAMP}-gone@example.test`])).rows[0].id as number;
    await pool().query("INSERT INTO hd_chat_people (app, chat_user_id, user_id) VALUES ('slack', $1, $2)", [`U${SID}GONE`, gone]);
    await pool().query("INSERT INTO hd_chat_drafts (id, app, user_id, chat_user_id) VALUES ($1, 'slack', $2, 'x')", [`${SID}gone`.toLowerCase(), gone]);
    await pool().query("INSERT INTO hd_chat_threads (ticket_id, app, user_id, conversation_id) VALUES ($1, 'slack', $2, 'Dx')", [keep.id, gone]);
    await pool().query("DELETE FROM users WHERE id = $1", [gone]);
    for (const table of ["hd_chat_people", "hd_chat_drafts", "hd_chat_threads"]) {
      assert.equal((await pool().query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [gone])).rows[0].n, 0, table);
    }
  });
});

// --- Settings and Test ----------------------------------------------------------------------

describe("settings", () => {
  test("the route: settings.manage only; no secret leaves; sealed at rest; a new app ID needs the secret again; audit without secrets", async () => {
    await person("admin", "Ada Admin", { deskRole: "admin", aad: false });
    assert.equal((await call(adminRoute.GET, adminReq(P.req.session))).status, 403);
    const client = await pool().connect();
    try {
      await client.query("SELECT pg_advisory_lock(728_419_404)");
      const saved = await getSetting(settings.CHAT_SETTINGS_KEY);
      settings.setChatSettingsForTests(null);
      try {
        await pool().query("DELETE FROM settings WHERE key = $1", [settings.CHAT_SETTINGS_KEY]);
        const put = await call(adminRoute.PUT, adminReq(P.admin.session, { teams: { app_id: APP_ID, secret: SECRET, tenant_id: TENANT }, slack: { bot_token: SLACK_TOKEN, signing_secret: SIGNING }, channels: [{ app: "slack", channel_id: `C${SID}1`, name: "it-help", team_id: IT, trigger: "mention" }] }));
        assert.equal(put.status, 200, JSON.stringify(put.body));
        assert.equal(put.body.teams.connected, true);
        assert.equal(put.body.slack.connected, true);
        const text = JSON.stringify(put.body);
        for (const s of [SECRET, SLACK_TOKEN, SIGNING]) assert.ok(!text.includes(s));
        const raw = (await getSetting(settings.CHAT_SETTINGS_KEY))!;
        for (const s of [SECRET, SLACK_TOKEN, SIGNING]) assert.ok(!raw.includes(s), "sealed at rest");
        assert.equal((await settings.getChatSettings()).teams.secret, SECRET);
        // A new app ID without the secret is refused.
        const again = await call(adminRoute.PUT, adminReq(P.admin.session, { teams: { app_id: randomUUID() } }));
        assert.equal(again.status, 400);
        assert.match(again.body.error, /client secret again/);
        // Channel checks.
        for (const ch of [{ app: "slack", channel_id: "nope", team_id: IT }, { app: "teams", channel_id: `19:${SID}@thread.tacv2`, team_id: IT, trigger: "reaction", reaction: "ticket" }, { app: "slack", channel_id: `C${SID}1`, team_id: 999_999_999 }]) {
          assert.equal((await call(adminRoute.PUT, adminReq(P.admin.session, { channels: [ch] }))).status, 400);
        }
        const audits = await auditRows("helpdesk.chat.settings_changed");
        assert.ok(audits.length >= 1);
        for (const s of [SECRET, SLACK_TOKEN, SIGNING]) assert.ok(!JSON.stringify(audits).includes(s));
        assert.ok(audits[0].details.changed.includes("teams.secret"));
        // Review fix: the first event pins the workspace with one atomic update of that field only.
        await settings.pinSlackTeam("T0PIN1");
        await settings.pinSlackTeam("T0OTHER");
        const pinned = await settings.getChatSettings();
        assert.deepEqual([pinned.slack.team_id, pinned.slack.bot_token, pinned.channels.length], ["T0PIN1", SLACK_TOKEN, 1]);
        // Disconnect Slack: its links are forgotten.
        await pool().query("INSERT INTO hd_chat_people (app, chat_user_id, user_id) VALUES ('slack', $1, $2) ON CONFLICT DO NOTHING", [`U${SID}DISC`, P.admin.id]);
        const off = await call(adminRoute.PUT, adminReq(P.admin.session, { slack: { disconnect: true } }));
        assert.equal(off.body.slack.connected, false);
        assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_chat_people WHERE app = 'slack'")).rows[0].n, 0);
        assert.equal((await auditRows("helpdesk.chat.disconnected")).length, 1);
        // A late event can't bring a disconnected Slack back (nothing is written while no token is saved).
        await settings.pinSlackTeam("T0LATE");
        const after = await settings.getChatSettings();
        assert.deepEqual([after.slack.team_id, after.slack.bot_token], ["", ""]);
      } finally {
        if (saved === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [settings.CHAT_SETTINGS_KEY]);
        else await pool().query("UPDATE settings SET value = $2 WHERE key = $1", [settings.CHAT_SETTINGS_KEY, saved]);
        settings.setChatSettingsForTests(chatSettings());
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(728_419_404)");
      client.release();
    }
  });

  test("Test: Microsoft's refusal names no secret; Slack names missing scopes and pins the workspace", async () => {
    settings.setChatSettingsForTests(chatSettings({ teams: { ...chatSettings().teams, secret: `${SECRET}-wrong` } }));
    const bad = await call(adminTestRoute.POST, new Request("http://localhost/api/helpdesk/admin/chat/test", { method: "POST", headers: { cookie: `compass_session=${P.admin.session}`, "content-type": "application/json" }, body: JSON.stringify({ app: "teams" }) }));
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.message, /refused the app ID and client secret/);
    assert.ok(!JSON.stringify(bad.body).includes(SECRET));
    settings.setChatSettingsForTests(chatSettings({ slack: { ...chatSettings().slack, team_id: "", team_name: "" } }));
    fake.state.slack.scopes = fake.state.slack.scopes.filter((s) => s !== "users:read.email");
    const sl = await call(adminTestRoute.POST, new Request("http://localhost/api/helpdesk/admin/chat/test", { method: "POST", headers: { cookie: `compass_session=${P.admin.session}`, "content-type": "application/json" }, body: JSON.stringify({ app: "slack" }) }));
    assert.equal(sl.body.ok, false);
    assert.match(sl.body.message, /missing users:read\.email/);
    assert.equal(sl.body.settings.slack.team_name, "Acme");
    fake.state.slack.scopes.push("users:read.email");
    settings.setChatSettingsForTests(chatSettings());
  });
});

test("rendering: mrkdwn escapes and converts links and bold; Teams text keeps Markdown", () => {
  assert.equal(slackMod.mrkdwn("**#12** <b> & [Open](https://x.example/a)"), "*#12* &lt;b&gt; &amp; <https://x.example/a|Open>");
  assert.equal(inbound.slackPlain("<@U123> hi <https://a.example|there> &amp;"), "hi there (https://a.example) &");
  assert.equal(inbound.teamsPlain("<at>CompassDocs</at> <p>VPN &amp; wifi</p>"), "VPN & wifi");
  assert.equal(core.bestType("my zorbex quillon", [{ id: 1, title: "Zorbex quillon problem", description: "", category: "" }, { id: 2, title: "Other", description: "zorbex", category: "" }])?.id, 1);
  assert.equal(core.bestType("hello there", [{ id: 1, title: "Zorbex", description: "", category: "" }]), null);
});
