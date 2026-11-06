// Helpdesk tools over the Claude connector (1.19.1, agent V1), called through
// POST /api/mcp with personal API tokens exactly as a connected assistant
// calls them, plus the desk's drafts API and Desk settings → Claude connector.
//
// What is pinned: each tool's happy path and its refusals (licence 402, the
// tool's side, desk capabilities, team scope: a ticket outside the caller's
// queues answers like one that does not exist); the workspace level (read /
// notes / update) hides and refuses writes; no tool can send a public reply,
// decide an approval or publish (no such tool exists, a draft writes no
// message, workflow and request type drafts stay unpublished / switched off);
// a requester never sees internal notes or drafts; every write is audited
// with via "mcp" and the caller's address; MCP messages carry via 'mcp' and
// ticket changes end "via Claude" on the timeline.
//
// Parallel-safe: every team, account, role, request type, workflow, macro
// and ticket here is this file's own (STAMP) and removed in after(). The
// desk matrix and the connector level are pinned in this process only
// (roles.setRoleMatrixForTests, setClaudeLevelForTests); the one test that
// saves the stored level does it under an advisory lock and puts it back.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/mcp-helpdesk.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createApiToken, createSession } from "../src/lib/db";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.mcp-helpdesk.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.mcp-helpdesk.virtual.js");
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
const claude = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const draftsRoute = require("../src/app/api/helpdesk/tickets/[number]/drafts/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/drafts/route");
const draftRoute = require("../src/app/api/helpdesk/tickets/[number]/drafts/[id]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/drafts/[id]/route");
const requestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
const claudeRoute = require("../src/app/api/helpdesk/admin/claude/route") as typeof import("../src/app/api/helpdesk/admin/claude/route");
const deskMessagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";

const CLIENT_IP = "203.0.113.91";

type ToolAnswer = { isError: boolean; text: string; out: any };

async function rpc(bearer: string, method: string, params: Record<string, unknown>): Promise<any> {
  const mcp = await import("../src/app/api/mcp/route");
  currentRequest = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-forwarded-for": CLIENT_IP },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  try {
    const res = await mcp.POST(currentRequest);
    assert.equal(res.status, 200);
    return await res.json();
  } finally {
    currentRequest = null;
  }
}

async function tool(who: string, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const body = await rpc(P[who].token, "tools/call", { name, arguments: args });
  const text: string = body.result?.content?.[0]?.text ?? "";
  let out: any = null;
  try {
    out = JSON.parse(text);
  } catch {
    /* a sentence */
  }
  return { isError: body.result?.isError === true, text, out };
}

async function toolNames(who: string): Promise<string[]> {
  const body = await rpc(P[who].token, "tools/list", {});
  return (body.result.tools as { name: string }[]).map((t) => t.name);
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, who: string, url: string, method = "GET", body?: unknown, params: Record<string, string> = {}) {
  currentRequest = new Request(`http://localhost${url}`, {
    method,
    headers: { cookie: `compass_session=${P[who].session}`, "content-type": "application/json", "x-forwarded-for": CLIENT_IP },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const res = await (handler as Handler)(currentRequest, { params: Promise.resolve(params) });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* none */
    }
    return { status: res.status, body: json };
  } finally {
    currentRequest = null;
  }
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `mcphd-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  name: string;
  email: string;
  token: string;
  session: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
const ticketIds: number[] = [];
let T1 = 0;
let T2 = 0;
let groupId = 0;
let rtId = 0;
const rtSlug = `${STAMP}-laptop`;
let wfId = 0;

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
  const token = (await createApiToken(id, `${STAMP} ${key}`, ["read", "write"])).token;
  P[key] = { id, name, email, token, session };
  return P[key];
}

async function grant(userId: number, perms: string[], tag: string): Promise<void> {
  const r = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-${tag}`]);
  const roleId = r.rows[0].id as number;
  roleIds.push(roleId);
  for (const p of perms) await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)", [roleId, p]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [roleId, userId]);
}

async function deskRole(userId: number, role: HdRole) {
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [userId, role]);
}
async function member(teamId: number, userId: number, role: "agent" | "lead" = "agent") {
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [teamId, userId, role]);
}

async function newTicket(subject: string, teamId: number | null, requester = P.req) {
  const r = await fixtureQuery(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status)
     VALUES ($1, $2, $3, $4, $5, 'open') RETURNING id, number`,
    [`${STAMP} ${subject}`, requester.id, requester.name, requester.email, teamId]
  );
  ticketIds.push(r.rows[0].id);
  await pool().query(
    "INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via) VALUES ($1, $2, $3, $4, 'public', $5, 'portal')",
    [r.rows[0].id, requester.id, requester.name, requester.email, `Opening message of ${subject}`]
  );
  return r.rows[0] as { id: number; number: number };
}

const messages = async (ticketId: number) =>
  (await pool().query<{ kind: string; body: string; via: string; author_id: number | null }>("SELECT kind, body, via, author_id FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows;

async function auditRows(action: string, actorId: number) {
  const r = await pool().query<{ details: Record<string, any>; ip: string | null; target_id: string | null }>(
    "SELECT details, ip, target_id FROM audit_log WHERE action = $1 AND actor_id = $2 ORDER BY id",
    [action, actorId]
  );
  return r.rows;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
  claude.setClaudeLevelForTests("notes");
  for (const [k, n] of [
    ["req", "Rae Requester"],
    ["req2", "Ray Second"],
    ["agent", "Ana Agent"],
    ["newbie", "Nia Newbie"],
    ["outsider", "Otto Outsider"],
    ["manager", "Milo Manager"],
    ["dadmin", "Dee Deskadmin"],
  ] as const) {
    await person(k, n);
  }
  T1 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9201) RETURNING id", [`${STAMP} IT`])).rows[0].id;
  T2 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9202) RETURNING id", [`${STAMP} HR`])).rows[0].id;
  for (const k of Object.keys(P)) await grant(P[k].id, ["helpdesk.request"], `req-${k}`);
  await deskRole(P.agent.id, "agent");
  await deskRole(P.newbie.id, "newbie");
  await deskRole(P.outsider.id, "agent");
  await deskRole(P.manager.id, "manager");
  await deskRole(P.dadmin.id, "admin");
  await member(T1, P.agent.id);
  await member(T1, P.newbie.id);
  await member(T2, P.outsider.id);
  await member(T1, P.manager.id);

  // A request type only this file's group sees (visibility groups), with one required question.
  groupId = (await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} Requesters`])).rows[0].id;
  await fixtureQuery("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, P.req.id]);
  const form = [
    { key: "model", label: "Which laptop?", type: "choice", required: true, options: [{ value: "mac", label: "MacBook" }, { value: "pc", label: "ThinkPad" }] },
  ];
  rtId = (
    await fixtureQuery(
      `INSERT INTO hd_request_types (slug, title, description, team_id, form, visibility, active, position)
       VALUES ($1, $2, 'A new laptop', $3, $4, 'groups', 1, 9201) RETURNING id`,
      [rtSlug, `${STAMP} New laptop`, T1, JSON.stringify(form)]
    )
  ).rows[0].id;
  await fixtureQuery("INSERT INTO hd_request_type_groups (request_type_id, group_id) VALUES ($1, $2)", [rtId, groupId]);
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  claude.setClaudeLevelForTests(null);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1) OR requester_id = ANY($2)", [ticketIds, userIds]);
  await pool().query("DELETE FROM hd_request_types WHERE id = $1 OR title LIKE $2", [rtId, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_workflows WHERE id = $1 OR title LIKE $2", [wfId, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_macros WHERE created_by = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[T1, T2]]);
  await pool().query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE role_id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM api_tokens WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Listing and the never-list ------------------------------------------------------

describe("tools/list", () => {
  test("each person sees the helpdesk tools of their side; no tool sends, approves or publishes", async () => {
    const req = await toolNames("req");
    assert.ok(req.includes("hd_create_request") && req.includes("hd_my_approvals"));
    assert.ok(!req.includes("hd_queue") && !req.includes("hd_draft_workflow"), "a requester sees no desk or admin tools");
    const agent = await toolNames("agent");
    assert.ok(agent.includes("hd_queue") && agent.includes("hd_draft_reply") && agent.includes("hd_add_internal_note"));
    assert.ok(!agent.includes("hd_update_ticket"), "updates are off at the default level");
    assert.ok(!agent.includes("hd_draft_workflow"), "an Agent has no workflows.manage");
    const manager = await toolNames("manager");
    assert.ok(manager.includes("hd_draft_workflow") && manager.includes("hd_draft_request_type") && manager.includes("hd_draft_macro") && manager.includes("hd_report"));
    // The owner's rules: no tool exists that could send, decide or publish.
    for (const n of hdTools.HELPDESK_TOOL_DEFS.map((d) => d.name)) {
      assert.doesNotMatch(n, /send|approve|decline|decide|publish/, n);
    }
    // The core tool list is still there.
    assert.ok(manager.includes("search_docs"));
  });

  test("unlicensed: no helpdesk tools listed, and a call answers 402", async () => {
    edition.features = [];
    try {
      assert.ok(!(await toolNames("agent")).some((n) => n.startsWith("hd_")));
      const r = await tool("agent", "hd_queue");
      assert.equal(r.isError, true);
      assert.match(r.text, /licence.*402/);
    } finally {
      edition.features = ["helpdesk"];
    }
  });

  test("tools that do not exist are unknown, whatever their name promises", async () => {
    for (const n of ["hd_send_reply", "hd_approve", "hd_decide_approval", "hd_publish_workflow"]) {
      const r = await tool("manager", n, { number: 1 });
      assert.equal(r.isError, true);
      assert.match(r.text, /Unknown tool/);
    }
  });
});

// --- Requester side ------------------------------------------------------------------

describe("requester tools", () => {
  let created = 0;

  test("hd_request_types lists what the person may use, with the form", async () => {
    const r = await tool("req", "hd_request_types");
    assert.equal(r.isError, false, r.text);
    const mine = r.out.request_types.find((t: any) => t.slug === rtSlug);
    assert.ok(mine, "the group's request type is listed for a member");
    assert.equal(mine.form[0].key, "model");
    assert.equal(mine.form[0].required, true);
    // Someone outside the group never sees it.
    const other = await tool("req2", "hd_request_types");
    assert.ok(!other.out.request_types.some((t: any) => t.slug === rtSlug));
    assert.equal((await tool("req2", "hd_request_types", { slug: rtSlug })).isError, true);
    const one = await tool("req", "hd_request_types", { slug: rtSlug });
    assert.equal(one.out.slug, rtSlug);
    assert.ok("prefilled_answers" in one.out);
  });

  test("hd_suggest_articles answers within the person's scope", async () => {
    const r = await tool("req", "hd_suggest_articles", { query: "laptop vpn" });
    assert.equal(r.isError, false, r.text);
    assert.ok(Array.isArray(r.out.articles));
  });

  test("hd_create_request validates like the form, then raises the request via Claude, audited", async () => {
    const bad = await tool("req", "hd_create_request", { request_type: rtSlug, answers: {} });
    assert.equal(bad.isError, true);
    const outside = await tool("req2", "hd_create_request", { request_type: rtSlug, answers: { model: "mac" } });
    assert.equal(outside.isError, true, "a type the person may not use is refused");
    const r = await tool("req", "hd_create_request", { request_type: rtSlug, answers: { model: "mac" }, body: "Mine is five years old." });
    assert.equal(r.isError, false, r.text);
    assert.match(r.out.url, /\/help\/requests\/\d+$/);
    const t = (await pool().query("SELECT id, requester_id, team_id, form_answers FROM hd_tickets WHERE number = $1", [r.out.number])).rows[0];
    created = t.id;
    ticketIds.push(t.id);
    assert.equal(t.requester_id, P.req.id);
    assert.equal(t.form_answers.model, "mac");
    const ms = await messages(t.id);
    assert.equal(ms[0].via, "mcp");
    const rows = await auditRows("helpdesk.request.created", P.req.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].details.via, "mcp");
    assert.equal(rows[0].details.number, r.out.number);
    assert.equal(rows[0].ip, CLIENT_IP);
  });

  test("hd_my_requests and hd_read_request show the person's own request, never internal notes or drafts", async () => {
    const t = await newTicket("Printer jam", T1);
    await tool("agent", "hd_add_internal_note", { number: t.number, body: "SECRET-NOTE: the requester's printer is on the old driver." });
    await tool("agent", "hd_draft_reply", { number: t.number, body: "SECRET-DRAFT: please try the new driver." });
    const mine = await tool("req", "hd_my_requests");
    assert.ok(mine.out.requests.some((x: any) => x.number === t.number));
    const r = await tool("req", "hd_read_request", { number: t.number });
    assert.equal(r.isError, false, r.text);
    assert.doesNotMatch(r.text, /SECRET-NOTE|SECRET-DRAFT/);
    assert.ok(r.out.conversation.every((m: any) => m.kind !== "internal"));
    // The app's own requester read agrees.
    const viaApp = await call(requestRoute.GET, "req", `/api/helpdesk/requests/${t.number}`, "GET", undefined, { number: String(t.number) });
    assert.equal(viaApp.status, 200);
    assert.doesNotMatch(JSON.stringify(viaApp.body), /SECRET-NOTE|SECRET-DRAFT/);
    // Someone else's request is not found.
    assert.equal((await tool("req2", "hd_read_request", { number: t.number })).isError, true);
  });

  test("hd_reply_to_request: the requester's own reply on their own request only", async () => {
    assert.ok(created);
    const number = (await pool().query("SELECT number FROM hd_tickets WHERE id = $1", [created])).rows[0].number;
    assert.equal((await tool("req2", "hd_reply_to_request", { number, body: "Not mine" })).isError, true);
    assert.equal((await tool("agent", "hd_reply_to_request", { number, body: "An agent can't reply here" })).isError, true);
    const r = await tool("req", "hd_reply_to_request", { number, body: "Any news?" });
    assert.equal(r.isError, false, r.text);
    const last = (await messages(created)).at(-1)!;
    assert.deepEqual([last.kind, last.via, last.author_id], ["public", "mcp", P.req.id]);
    assert.equal((await auditRows("helpdesk.request.replied", P.req.id))[0].details.via, "mcp");
  });

  // 1.19.1 integration with CCs (agent V3): a CC reads what the requester reads, never more.
  test("a CC sees the request in hd_my_requests and hd_read_request, requester-safe only, and may reply as in Get help", async () => {
    const t = await newTicket("Shared drive full", T1);
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, name) VALUES ($1, $2, $3)", [t.id, P.req2.id, P.req2.name]);
    await tool("agent", "hd_add_internal_note", { number: t.number, body: "SECRET-CC-NOTE: the drive belongs to finance." });
    await tool("agent", "hd_draft_reply", { number: t.number, body: "SECRET-CC-DRAFT: we'll grow it." });
    // A newbie's reply held for review is not the requester's to read either.
    await pool().query(
      "INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, review_state) VALUES ($1, $2, $3, 'public', 'SECRET-CC-HELD', 'desk', 'pending')",
      [t.id, P.newbie.id, P.newbie.name]
    );
    const mine = await tool("req2", "hd_my_requests");
    assert.ok(mine.out.requests.some((x: any) => x.number === t.number), "copied requests are listed");
    const r = await tool("req2", "hd_read_request", { number: t.number });
    assert.equal(r.isError, false, r.text);
    assert.doesNotMatch(r.text, /SECRET-CC-(NOTE|DRAFT|HELD)/);
    assert.ok(r.out.conversation.every((m: any) => m.kind !== "internal"));
    // Agent tools stay closed to a CC.
    assert.equal((await tool("req2", "hd_read_ticket", { number: t.number })).isError, true);
    assert.equal((await tool("req2", "hd_draft_reply", { number: t.number, body: "x" })).isError, true);
    const reply = await tool("req2", "hd_reply_to_request", { number: t.number, body: "Copied in: same here." });
    assert.equal(reply.isError, false, reply.text);
    const last = (await messages(t.id)).at(-1)!;
    assert.deepEqual([last.kind, last.via, last.author_id], ["public", "mcp", P.req2.id]);
    // Once the CC is removed, the request is not theirs.
    await pool().query("DELETE FROM hd_ticket_ccs WHERE ticket_id = $1", [t.id]);
    assert.equal((await tool("req2", "hd_read_request", { number: t.number })).isError, true);
    assert.equal((await tool("req2", "hd_reply_to_request", { number: t.number, body: "again" })).isError, true);
  });

  test("hd_my_approvals lists what waits for the person with approve_url, and nothing decides it", async () => {
    const t = await newTicket("Access to finance share", T1, P.req2);
    const run = (await pool().query("INSERT INTO hd_workflow_runs (ticket_id, state) VALUES ($1, 'waiting') RETURNING id", [t.id])).rows[0].id;
    const step = (
      await pool().query(
        `INSERT INTO hd_workflow_steps (run_id, step_key, kind, state, result) VALUES ($1, 'approve', 'approval', 'active', '{"title":"Finance approves"}') RETURNING id`,
        [run]
      )
    ).rows[0].id;
    const ap = (
      await pool().query(
        "INSERT INTO hd_approvals (run_id, step_id, ticket_id, approver_kind, approver_user_id) VALUES ($1, $2, $3, 'user', $4) RETURNING id",
        [run, step, t.id, P.req.id]
      )
    ).rows[0].id;
    const r = await tool("req", "hd_my_approvals");
    assert.equal(r.isError, false, r.text);
    const a = r.out.approvals.find((x: any) => x.id === ap);
    assert.ok(a, "the approval is listed");
    assert.equal(a.can_decide, true);
    assert.match(a.approve_url, /\/help\/approvals$/);
    assert.match(r.out.note, /No tool approves or declines/);
    // Every tool the person has, called with the approval: nothing decides it.
    for (const n of await toolNames("req")) await tool("req", n, { number: t.number, id: ap });
    assert.equal((await pool().query("SELECT decision FROM hd_approvals WHERE id = $1", [ap])).rows[0].decision, "pending");
  });
});

// --- Agent side ----------------------------------------------------------------------

describe("agent tools", () => {
  let t: { id: number; number: number };
  before(async () => {
    t = await newTicket("VPN drops at home", T1);
  });

  test("hd_queue: the person's queues only, with the teams they work", async () => {
    const r = await tool("agent", "hd_queue", { team: T1, view: "all" });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.out.tickets.some((x: any) => x.number === t.number));
    assert.ok(r.out.teams.some((x: any) => x.id === T1));
    const o = await tool("outsider", "hd_queue", { view: "all", query: `${STAMP} VPN` });
    assert.ok(!o.out.tickets.some((x: any) => x.number === t.number), "another team's agent does not see it");
    assert.equal((await tool("req", "hd_queue")).isError, true, "a requester has no desk role");
    assert.equal((await tool("agent", "hd_queue", { view: "nonsense" })).isError, true);
  });

  test("hd_read_ticket: the agent's full view, the same not-found outside the queues", async () => {
    await tool("agent", "hd_add_internal_note", { number: t.number, body: "Checked the logs." });
    const r = await tool("agent", "hd_read_ticket", { number: t.number });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.out.conversation.some((m: any) => m.kind === "internal" && m.via === "Claude"));
    assert.equal(r.out.requester.name, P.req.name);
    assert.ok(Array.isArray(r.out.assignable_agents));
    const o = await tool("outsider", "hd_read_ticket", { number: t.number });
    const none = await tool("outsider", "hd_read_ticket", { number: 999999999 });
    assert.equal(o.isError, true);
    assert.equal(o.text.replace(String(t.number), "N"), none.text.replace("999999999", "N"), "a hidden ticket reads like a missing one");
  });

  test("hd_add_internal_note: agent-only, via Claude, audited; needs Add internal notes", async () => {
    const r = await tool("agent", "hd_add_internal_note", { number: t.number, body: "Second note." });
    assert.equal(r.isError, false, r.text);
    const note = (await messages(t.id)).filter((m) => m.kind === "internal").at(-1)!;
    assert.equal(note.via, "mcp");
    const rows = await auditRows("helpdesk.note.added", P.agent.id);
    assert.ok(rows.length >= 1 && rows.every((x) => x.details.via === "mcp" && x.ip === CLIENT_IP));
    // A matrix without internal notes for Agents: refused.
    const m = structuredClone(shared.HD_DEFAULT_MATRIX);
    m.agent = m.agent.filter((c) => c !== "tickets.internal_note");
    roles.setRoleMatrixForTests(m);
    try {
      const refused = await tool("agent", "hd_add_internal_note", { number: t.number, body: "Nope." });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /403/);
    } finally {
      roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
    }
    assert.equal((await tool("outsider", "hd_add_internal_note", { number: t.number, body: "x" })).isError, true);
  });

  test("hd_draft_reply saves a draft and writes no message: nothing reaches the requester", async () => {
    const before = (await messages(t.id)).length;
    const r = await tool("agent", "hd_draft_reply", { number: t.number, body: "Hi Rae, please re-pair the VPN client." });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.sent, false);
    assert.equal((await messages(t.id)).length, before, "a draft is never a message");
    const d = (await pool().query("SELECT created_by, source, body, used_at, discarded_at FROM hd_reply_drafts WHERE id = $1", [r.out.draft_id])).rows[0];
    assert.deepEqual([d.created_by, d.source, d.used_at, d.discarded_at], [P.agent.id, "claude", null, null]);
    const rows = await auditRows("helpdesk.reply_draft.created", P.agent.id);
    assert.ok(rows.some((x) => x.details.draft_id === r.out.draft_id && x.details.via === "mcp"));
    // A Newbie may draft (they reply after review); an outsider may not.
    assert.equal((await tool("newbie", "hd_draft_reply", { number: t.number, body: "Newbie draft" })).isError, false);
    assert.equal((await tool("outsider", "hd_draft_reply", { number: t.number, body: "x" })).isError, true);
  });

  // 1.19.1 integration with the send guard (agent V4): a draft is not a send, so a newer message never blocks it.
  test("hd_draft_reply is never stopped by the collision guard; the desk send it becomes is", async () => {
    const t2 = await newTicket("Monitor flickers", T1);
    const last = (await pool().query("SELECT max(id)::int AS id FROM hd_messages WHERE ticket_id = $1", [t2.id])).rows[0].id as number;
    // Someone else (the requester) writes after the agent's last look.
    await pool().query("INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via) VALUES ($1, $2, $3, 'public', 'Now it is black', 'portal')", [
      t2.id,
      P.req.id,
      P.req.name,
    ]);
    const d = await tool("agent", "hd_draft_reply", { number: t2.number, body: "Try another cable." });
    assert.equal(d.isError, false, d.text);
    // The desk send with the stale expectation is warned; with force it goes.
    const stale = await call(deskMessagesRoute.POST, "agent", `/api/helpdesk/tickets/${t2.number}/messages`, "POST", { kind: "public", body: "Try another cable.", expect_last_message_id: last }, { number: String(t2.number) });
    assert.equal(stale.status, 409);
    assert.ok(stale.body.newer.some((m: any) => /Now it is black/.test(m.body)));
    const forced = await call(deskMessagesRoute.POST, "agent", `/api/helpdesk/tickets/${t2.number}/messages`, "POST", { kind: "public", body: "Try another cable.", expect_last_message_id: last, force: true }, { number: String(t2.number) });
    assert.equal(forced.status, 201, JSON.stringify(forced.body));
  });

  test("hd_ticket_summary gives the conversation and similar tickets", async () => {
    const similar = await newTicket("VPN drops in the office", T1);
    const r = await tool("agent", "hd_ticket_summary", { number: t.number });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.out.conversation.length >= 2);
    assert.ok(r.out.similar_tickets.some((x: any) => x.number === similar.number));
    assert.ok(!r.out.similar_tickets.some((x: any) => x.number === t.number));
  });

  test("hd_update_ticket: only at the update level, within the desk role, via Claude on the timeline", async () => {
    const off = await tool("agent", "hd_update_ticket", { number: t.number, priority: "high" });
    assert.equal(off.isError, true);
    assert.match(off.text, /Read, add internal notes/);
    claude.setClaudeLevelForTests("update");
    try {
      assert.ok((await toolNames("agent")).includes("hd_update_ticket"));
      const r = await tool("agent", "hd_update_ticket", { number: t.number, priority: "high", assignee_id: "me", tags: ["vpn"] });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual([...r.out.changed].sort(), ["assignee_id", "priority", "tags"]);
      const lines = (await messages(t.id)).filter((m) => m.via === "system");
      assert.ok(lines.some((m) => /changed the priority from Normal to High via Claude$/.test(m.body)), JSON.stringify(lines));
      assert.ok(lines.some((m) => /took the ticket via Claude$/.test(m.body)));
      const rows = await auditRows("helpdesk.ticket.updated", P.agent.id);
      assert.equal(rows.at(-1)!.details.via, "mcp");
      // A Newbie has no Change priority.
      const nb = await tool("newbie", "hd_update_ticket", { number: t.number, priority: "low" });
      assert.equal(nb.isError, true);
      assert.match(nb.text, /403/);
      // Assigning to someone outside the team: the core refuses.
      const away = await tool("agent", "hd_update_ticket", { number: t.number, assignee_id: P.outsider.id });
      assert.equal(away.isError, true);
      assert.equal((await tool("outsider", "hd_update_ticket", { number: t.number, status: "solved" })).isError, true);
    } finally {
      claude.setClaudeLevelForTests("notes");
    }
  });

  test("a merged ticket is locked for Claude as in the desk: no reopen, note or draft", async () => {
    const keep = await newTicket("Merged keep", T1);
    const gone = await newTicket("Merged away", T1);
    await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now(), merged_into = $2 WHERE id = $1", [gone.id, keep.id]);
    const before = (await messages(gone.id)).length;
    const note = await tool("agent", "hd_add_internal_note", { number: gone.number, body: "Lost note" });
    assert.equal(note.isError, true);
    assert.match(note.text, new RegExp(`merged into #${keep.number}.*\\(409\\)`));
    const draft = await tool("agent", "hd_draft_reply", { number: gone.number, body: "Lost draft" });
    assert.equal(draft.isError, true);
    assert.match(draft.text, /409/);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_reply_drafts WHERE ticket_id = $1", [gone.id])).rows[0].n, 0);
    claude.setClaudeLevelForTests("update");
    try {
      const reopen = await tool("agent", "hd_update_ticket", { number: gone.number, status: "open" });
      assert.equal(reopen.isError, true);
      assert.match(reopen.text, /409/);
      assert.equal((await pool().query("SELECT status FROM hd_tickets WHERE id = $1", [gone.id])).rows[0].status, "closed");
      // Other fields still change, as in the desk.
      const pri = await tool("agent", "hd_update_ticket", { number: gone.number, priority: "high" });
      assert.equal(pri.isError, false, pri.text);
    } finally {
      claude.setClaudeLevelForTests("notes");
    }
    assert.equal((await messages(gone.id)).filter((m) => m.via !== "system").length, before, "only the priority line was added");
  });

  test("an agent copied on a ticket they work can't reply through hd_reply_to_request", async () => {
    const tk = await newTicket("Agent copied", T1);
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, name) VALUES ($1, $2, $3)", [tk.id, P.newbie.id, P.newbie.name]);
    const r = await tool("newbie", "hd_reply_to_request", { number: tk.number, body: "Skipping review" });
    assert.equal(r.isError, true);
    assert.match(r.text, /reply from the desk/);
    assert.ok(!(await messages(tk.id)).some((m) => m.body === "Skipping review"));
  });

  test("hd_report: the reports route's rule", async () => {
    const all = await tool("agent", "hd_report");
    assert.equal(all.isError, true, "an Agent has no All reports");
    const mine = await tool("agent", "hd_report", { mine: true });
    assert.equal(mine.isError, false, mine.text);
    assert.equal(mine.out.scope, "your tickets");
    const team = await tool("manager", "hd_report", { team: T1 });
    assert.equal(team.isError, false, team.text);
    assert.equal(typeof team.out.created, "number");
    assert.equal((await tool("req", "hd_report")).isError, true);
  });
});

// --- The drafts API (desk) -----------------------------------------------------------

describe("drafts API", () => {
  test("agents who work the ticket list, use and discard drafts; nobody else", async () => {
    const t = await newTicket("Monitor flickers", T1);
    const a = await tool("agent", "hd_draft_reply", { number: t.number, body: "Draft A" });
    const b = await tool("agent", "hd_draft_reply", { number: t.number, body: "Draft B" });
    const params = { number: String(t.number) };
    const list = await call(draftsRoute.GET, "agent", `/api/helpdesk/tickets/${t.number}/drafts`, "GET", undefined, params);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.drafts.map((d: any) => d.body), ["Draft B", "Draft A"]);
    assert.equal(list.body.drafts[0].created_by_name, P.agent.name);
    assert.equal((await call(draftsRoute.GET, "outsider", `/x`, "GET", undefined, params)).status, 404);
    assert.equal((await call(draftsRoute.GET, "req", `/x`, "GET", undefined, params)).status, 403, "requesters never reach drafts");

    const use = await call(draftRoute.PATCH, "agent", `/x`, "PATCH", { state: "used" }, { ...params, id: String(b.out.draft_id) });
    assert.equal(use.status, 200);
    assert.ok(use.body.draft.used_at);
    assert.equal((await call(draftRoute.PATCH, "agent", `/x`, "PATCH", { state: "used" }, { ...params, id: String(b.out.draft_id) })).status, 409);
    assert.equal((await call(draftRoute.DELETE, "outsider", `/x`, "DELETE", undefined, { ...params, id: String(a.out.draft_id) })).status, 404);
    const del = await call(draftRoute.DELETE, "agent", `/x`, "DELETE", undefined, { ...params, id: String(a.out.draft_id) });
    assert.equal(del.status, 200);
    const after = await call(draftsRoute.GET, "agent", `/x`, "GET", undefined, params);
    assert.equal(after.body.drafts.length, 0);
    // A draft of another ticket is not found through this one.
    const other = await newTicket("Keyboard", T1);
    const c = await tool("agent", "hd_draft_reply", { number: other.number, body: "Draft C" });
    assert.equal((await call(draftRoute.DELETE, "agent", `/x`, "DELETE", undefined, { ...params, id: String(c.out.draft_id) })).status, 404);
    assert.equal((await auditRows("helpdesk.reply_draft.used", P.agent.id)).length, 1);
    assert.equal((await auditRows("helpdesk.reply_draft.discarded", P.agent.id)).length, 1);
  });
});

// --- Admin side: drafts only ----------------------------------------------------------

describe("admin tools", () => {
  test("hd_draft_workflow creates an unpublished workflow and drafts on a published one", async () => {
    assert.equal((await tool("agent", "hd_list_workflows")).isError, true, "an Agent has no workflows.manage");
    const definition = { trigger: {}, steps: [{ key: "t1", kind: "task", title: "Set up the laptop", team_id: T1 }] };
    const r = await tool("manager", "hd_draft_workflow", { title: `${STAMP} Onboarding`, definition });
    assert.equal(r.isError, false, r.text);
    wfId = r.out.id;
    let w = (await pool().query("SELECT published, definition, draft FROM hd_workflows WHERE id = $1", [wfId])).rows[0];
    assert.equal(w.published, 0);
    assert.equal(w.draft.steps.length, 1);
    // Published by a person (simulated), then Claude drafts a change: the live version is untouched.
    await pool().query("UPDATE hd_workflows SET definition = draft, draft = NULL, published = 1 WHERE id = $1", [wfId]);
    const change = { trigger: {}, steps: [...definition.steps, { key: "f", kind: "finish", title: "Done" }] };
    const d = await tool("manager", "hd_draft_workflow", { id: wfId, definition: change });
    assert.equal(d.isError, false, d.text);
    w = (await pool().query("SELECT published, definition, draft, version FROM hd_workflows WHERE id = $1", [wfId])).rows[0];
    assert.equal(w.definition.steps.length, 1, "the published steps are unchanged");
    assert.equal(w.draft.steps.length, 2);
    assert.equal(w.version, 1);
    const one = await tool("manager", "hd_list_workflows", { id: wfId });
    assert.equal(one.out.definition.steps.length, 2);
    assert.equal(one.out.unpublished_changes, true);
    const bad = await tool("manager", "hd_draft_workflow", { title: `${STAMP} Bad`, definition: { trigger: {}, steps: [{ key: "x", kind: "launch" }] } });
    assert.equal(bad.isError, true);
    const rows = [...(await auditRows("helpdesk.workflow.created", P.manager.id)), ...(await auditRows("helpdesk.workflow.updated", P.manager.id))];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.details.via === "mcp"));
  });

  test("hd_draft_request_type saves it switched off", async () => {
    const r = await tool("manager", "hd_draft_request_type", {
      title: `${STAMP} Parking permit`,
      team_id: T2,
      form: [{ key: "plate", label: "Number plate", type: "text", required: true }],
    });
    assert.equal(r.isError, false, r.text);
    const rt = (await pool().query("SELECT active, form FROM hd_request_types WHERE id = $1", [r.out.id])).rows[0];
    assert.equal(rt.active, 0);
    assert.equal(rt.form[0].key, "plate");
    assert.equal((await auditRows("helpdesk.request_type.created", P.manager.id))[0].details.active, false);
    assert.equal((await tool("agent", "hd_draft_request_type", { title: `${STAMP} Nope` })).isError, true);
  });

  test("hd_draft_macro saves the person's own personal macro", async () => {
    const r = await tool("agent", "hd_draft_macro", { title: `${STAMP} VPN re-pair`, body: "Hi {{requester.first_name}}, please re-pair." });
    assert.equal(r.isError, false, r.text);
    const m = (await pool().query("SELECT owner_id, team_id FROM hd_macros WHERE id = $1", [r.out.id])).rows[0];
    assert.deepEqual([m.owner_id, m.team_id], [P.agent.id, null]);
    assert.equal((await auditRows("helpdesk.macro.created", P.agent.id))[0].details.via, "mcp");
  });
});

// --- Levels and the settings page ------------------------------------------------------

describe("workspace level", () => {
  test("read only: writes are hidden and refused, and nothing is written", async () => {
    const t = await newTicket("Read-only check", T1);
    claude.setClaudeLevelForTests("read");
    try {
      const names = await toolNames("manager");
      assert.ok(names.includes("hd_read_ticket") && names.includes("hd_queue"));
      for (const w of hdTools.HELPDESK_TOOL_DEFS.filter((d) => d.write).map((d) => d.name)) assert.ok(!names.includes(w), w);
      const before = (await messages(t.id)).length;
      for (const [n, args] of [
        ["hd_add_internal_note", { number: t.number, body: "x" }],
        ["hd_draft_reply", { number: t.number, body: "x" }],
        ["hd_create_request", { subject: `${STAMP} ro`, body: "x" }],
        ["hd_update_ticket", { number: t.number, priority: "low" }],
        ["hd_draft_macro", { title: `${STAMP} ro`, body: "x" }],
      ] as const) {
        const r = await tool("manager", n, args);
        assert.equal(r.isError, true, n);
        assert.match(r.text, /Read only/, n);
      }
      assert.equal((await messages(t.id)).length, before);
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_reply_drafts WHERE ticket_id = $1", [t.id])).rows[0].n, 0);
    } finally {
      claude.setClaudeLevelForTests("notes");
    }
  });

  test("Desk settings → Claude connector: settings.manage reads and saves the level; activity lists connector writes", async () => {
    claude.setClaudeLevelForTests(null);
    const lock = await pool().connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext('helpdesk_claude_connector'))");
      const stored = await getSetting(claude.HD_CLAUDE_KEY);
      try {
        assert.equal((await call(claudeRoute.GET, "manager", "/api/helpdesk/admin/claude")).status, 403, "a Manager has no settings.manage");
        const got = await call(claudeRoute.GET, "dadmin", "/api/helpdesk/admin/claude");
        assert.equal(got.status, 200);
        assert.ok(["read", "notes", "update"].includes(got.body.level));
        assert.ok(got.body.activity.some((x: any) => x.actor_id === P.agent.id && /^Saved a reply draft on #\d+$/.test(x.summary)));
        assert.equal((await call(claudeRoute.PUT, "dadmin", "/x", "PUT", { level: "send" })).status, 400);
        const target = got.body.level === "update" ? "read" : "update";
        const put = await call(claudeRoute.PUT, "dadmin", "/x", "PUT", { level: target });
        assert.equal(put.status, 200);
        assert.equal(await claude.getClaudeLevel(), target);
        const rows = await auditRows("helpdesk.settings.updated", P.dadmin.id);
        assert.deepEqual([rows.at(-1)!.details.section, rows.at(-1)!.details.to], ["claude_connector", target]);
      } finally {
        if (stored === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [claude.HD_CLAUDE_KEY]);
        else await pool().query("UPDATE settings SET value = $2 WHERE key = $1", [claude.HD_CLAUDE_KEY, stored]);
        claude.setClaudeLevelForTests("notes");
      }
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext('helpdesk_claude_connector'))");
      lock.release();
    }
  });
});
