// Helpdesk 1.19.2 canned responses (agent W4).
//
// What is pinned:
//   pure       the ";" trigger (start of a word only: never mid-word, in a
//              URL, "; " or ";)"), rendering (unknown placeholders and
//              missing values leave no {{braces}}; names escaped for
//              Markdown), the picker's groups (ticket's team, other teams,
//              Workspace, Mine), share parsing, placeholder chips
//   library    who writes which sharing (an Agent only their own; a team
//              lead their own teams'; a Manager the workspace's), someone
//              else's personal response is never listed, read, edited or
//              used; unknown placeholders are refused; folders; every write
//              audited (helpdesk.canned.*)
//   use        the composer's insert fills the placeholders for the ticket
//              and the caller, counts the use (Used, 30 days), and never
//              changes the ticket or writes a message; a ticket the caller
//              doesn't work is a 404; the picker lists the ticket's team's
//              responses for an agent assigned outside their teams
//   connector  hd_canned_responses lists read-only, fills for a ticket the
//              person works, counts nothing, refuses a ticket they don't
//
// Parallel-safe: every account, team, ticket and response is this file's own
// (STAMP) and removed in after(); the desk matrix is pinned in this process
// only (roles.setRoleMatrixForTests).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-canned.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createApiToken, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import {
  CANNED_LIMITS,
  cannedMatches,
  cannedTrigger,
  groupCanned,
  inlinePickerShows,
  parseShare,
  renderCanned,
  splitPlaceholders,
  strayBraces,
  unknownPlaceholders,
  type HdCanned,
} from "../src/lib/helpdesk/canned-shared";

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-canned.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-canned.virtual.js");
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
const cannedLib = require("../src/lib/helpdesk/canned") as typeof import("../src/lib/helpdesk/canned");
const libraryRoute = require("../src/app/api/helpdesk/admin/canned/route") as typeof import("../src/app/api/helpdesk/admin/canned/route");
const itemRoute = require("../src/app/api/helpdesk/admin/canned/[id]/route") as typeof import("../src/app/api/helpdesk/admin/canned/[id]/route");
const pickerRoute = require("../src/app/api/helpdesk/canned/route") as typeof import("../src/app/api/helpdesk/canned/route");
const useRoute = require("../src/app/api/helpdesk/canned/[id]/use/route") as typeof import("../src/app/api/helpdesk/canned/[id]/use/route");
const inactiveRoute = require("../src/app/api/helpdesk/admin/canned/inactive/route") as typeof import("../src/app/api/helpdesk/admin/canned/inactive/route");
const teamCountRoute = require("../src/app/api/helpdesk/admin/canned/team-count/route") as typeof import("../src/app/api/helpdesk/admin/canned/team-count/route");
const teamRoute = require("../src/app/api/helpdesk/admin/teams/[id]/route") as typeof import("../src/app/api/helpdesk/admin/teams/[id]/route");
const periodic = require("../src/lib/periodic") as typeof import("../src/lib/periodic");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";

const CLIENT_IP = "203.0.113.94";

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

async function tool(who: string, name: string, args: Record<string, unknown> = {}) {
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

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdcan-${Date.now()}-${process.pid}`;
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
let T1 = 0; // IT: agent, lead, newbie, manager
let T2 = 0; // HR: outsider
let T1name = "";

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

async function newTicket(subject: string, teamId: number | null, requester = P.req, assignee: number | null = null) {
  const r = await fixtureQuery(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, assignee_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open') RETURNING id, number`,
    [`${STAMP} ${subject}`, requester.id, requester.name, requester.email, teamId, assignee]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0] as { id: number; number: number };
}

async function auditRows(action: string, actorId: number) {
  const r = await pool().query<{ details: Record<string, any>; target_id: string | null }>(
    "SELECT details, target_id FROM audit_log WHERE action = $1 AND actor_id = $2 ORDER BY id",
    [action, actorId]
  );
  return r.rows;
}

/** A response written straight to the table (fixture). */
async function seed(title: string, body: string, share: { owner?: number; team?: number } = {}, folder = "") {
  const r = await fixtureQuery(
    "INSERT INTO hd_canned_responses (title, body, folder, owner_id, team_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [`${STAMP} ${title}`, body, folder, share.owner ?? null, share.team ?? null, P.manager.id]
  );
  return r.rows[0].id as number;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
  claude.setClaudeLevelForTests("notes");
  for (const [k, n] of [
    ["req", "Daniel (Dan) Okafor"],
    ["agent", "Ana Agent"],
    ["lead", "Lee Lead"],
    ["newbie", "Nia Newbie"],
    ["outsider", "Otto Outsider"],
    ["manager", "Milo Manager"],
  ] as const) {
    await person(k, n);
  }
  T1name = `${STAMP} IT`;
  T1 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9401) RETURNING id", [T1name])).rows[0].id;
  T2 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9402) RETURNING id", [`${STAMP} HR`])).rows[0].id;
  for (const k of Object.keys(P)) await grant(P[k].id, ["helpdesk.request"], `req-${k}`);
  await deskRole(P.agent.id, "agent");
  await deskRole(P.lead.id, "team_lead");
  await deskRole(P.newbie.id, "newbie");
  await deskRole(P.outsider.id, "agent");
  await deskRole(P.manager.id, "manager");
  await member(T1, P.agent.id);
  await member(T1, P.lead.id, "lead");
  await member(T1, P.newbie.id);
  await member(T2, P.outsider.id);
  await member(T1, P.manager.id);
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  claude.setClaudeLevelForTests(null);
  await pool().query("DELETE FROM hd_canned_responses WHERE title LIKE $1 OR created_by = ANY($2) OR owner_id = ANY($2)", [`${STAMP}%`, userIds]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1) OR requester_id = ANY($2)", [ticketIds, userIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1) OR name LIKE $2", [[T1, T2], `${STAMP}%`]);
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

// --- Pure ----------------------------------------------------------------------------

describe("the ; trigger", () => {
  const at = (s: string) => cannedTrigger(s, s.length);
  test("fires at the start of the box, after a space or a line break", () => {
    assert.deepEqual(at(";"), { start: 0, query: "" });
    assert.deepEqual(at("Thanks for letting us know. ;vpn"), { start: 28, query: "vpn" });
    assert.deepEqual(at("Hi Daniel,\n;vp"), { start: 11, query: "vp" });
    assert.deepEqual(at("Hi ;vpn re"), { start: 3, query: "vpn re" });
  });
  test("never mid-word, in a URL, as punctuation or a wink", () => {
    for (const s of ["a;b", "foo;", "see https://x.test/a;jsessionid=1", "http://x.test/;v", "one; two", "; ", " ;)", ";-)", ";;", "x ;vpn  too", ";a;b"]) {
      assert.equal(at(s), null, s);
    }
  });
  test("stays on the caret's line and under the length cap", () => {
    assert.equal(at(";vpn\nmore"), null);
    assert.equal(cannedTrigger(";vpn\nmore", 4)?.query, "vpn");
    assert.equal(at(`;${"a".repeat(41)}`), null);
    assert.equal(cannedTrigger("", 0), null);
  });
  test("does not clash with the / macro and [[ article triggers", () => {
    assert.equal(at("/"), null);
    assert.equal(at("see [["), null);
  });
});

describe("rendering", () => {
  const v = { requesterName: "Daniel *Dan* Okafor", ticketNumber: 1047, teamName: "IT_Desk", agentName: "Ana Kowalski" };
  test("fills the placeholders, escaping names for Markdown", () => {
    const out = renderCanned("Hi {{requester.first_name}}, #{{ticket.number}} ({{team.name}}). {{ agent.first_name }} / {{AGENT.NAME}} / {{requester.name}}", v);
    assert.equal(out, "Hi Daniel, #1047 (IT\\_Desk). Ana / Ana Kowalski / Daniel \\*Dan\\* Okafor");
  });
  test("unknown placeholders and missing values leave no braces", () => {
    const out = renderCanned("A {{ticket.url}} B {{nope}} C {{ }} D {{team.name}}E", { requesterName: "", ticketNumber: null, teamName: "", agentName: "" });
    assert.equal(out, "A  B  C  D E");
    assert.doesNotMatch(out, /\{\{|\}\}/);
    assert.equal(renderCanned("Hi {{requester.first_name}}", { ...v, requesterName: "  " }), "Hi there");
  });
  test("unknownPlaceholders and splitPlaceholders", () => {
    assert.deepEqual(unknownPlaceholders("{{requester.first_name}} {{ticket.url}} {{ticket.url}} {{x}}"), ["{{ticket.url}}", "{{x}}"]);
    assert.deepEqual(splitPlaceholders("Hi {{Requester.First_Name}}, bye {{x}}"), [{ text: "Hi " }, { tag: "requester.first_name" }, { text: ", bye {{x}}" }]);
  });
  test("parseShare", () => {
    assert.deepEqual(parseShare("me"), { scope: "personal", teamId: null });
    assert.deepEqual(parseShare("workspace"), { scope: "workspace", teamId: null });
    assert.deepEqual(parseShare("team:12"), { scope: "team", teamId: 12 });
    for (const bad of ["team:0", "team:x", "everyone", 3, null]) assert.equal(parseShare(bad), null);
  });
});

describe("picker groups", () => {
  const c = (id: number, title: string, scope: HdCanned["scope"], team: number | null = null, uses = 0): HdCanned => ({
    id,
    title,
    body: `body ${title}`,
    folder: "",
    scope,
    owner_id: scope === "personal" ? 1 : null,
    team_id: team,
    team_name: team ? `Team ${team}` : null,
    uses_30d: uses,
    updated_at: "",
  });
  const list = [
    c(1, "VPN logs", "personal"),
    c(2, "VPN outage", "team", 7, 3),
    c(3, "VPN re-pair", "team", 7, 46),
    c(4, "Printer jam", "team", 5),
    c(5, "Thanks, closing", "workspace"),
    c(6, "VPN known", "workspace"),
  ];
  test("the ticket's team first, then other teams, Workspace, Mine; most used first", () => {
    const g = groupCanned(list, "", 7);
    assert.deepEqual(g.map((x) => x.key), ["team:7", "team:5", "workspace", "mine"]);
    assert.deepEqual(g[0].items.map((x) => x.id), [3, 2]);
    const v = groupCanned(list, "vpn", 5);
    assert.deepEqual(v.map((x) => x.key), ["team:7", "workspace", "mine"]);
    assert.deepEqual(groupCanned(list, "zzz", null), []);
  });
});

// --- Library -----------------------------------------------------------------------------

describe("library: sharing and capabilities", () => {
  test("an Agent saves their own; not a team's or the workspace's", async () => {
    const own = await call(libraryRoute.POST, "agent", "/api/helpdesk/admin/canned", "POST", {
      title: `${STAMP} VPN logs`,
      body: "Open the VPN client, choose Help, then Export logs, {{requester.first_name}}.",
      folder: "  VPN  ",
      share: "me",
    });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(own.body.canned.scope, "personal");
    assert.equal(own.body.canned.owner_id, P.agent.id);
    assert.equal(own.body.canned.folder, "VPN");
    for (const share of [`team:${T1}`, "workspace"]) {
      const r = await call(libraryRoute.POST, "agent", "/api/helpdesk/admin/canned", "POST", { title: `${STAMP} no`, body: "x", share });
      assert.equal(r.status, 403, share);
    }
    const audit = await auditRows("helpdesk.canned.created", P.agent.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.scope, "personal");
    // A Newbie holds no manage capability: no library at all.
    assert.equal((await call(libraryRoute.GET, "newbie", "/api/helpdesk/admin/canned")).status, 403);
  });

  test("a team lead writes their own team's, not another team's or the workspace's", async () => {
    const ok = await call(libraryRoute.POST, "lead", "/api/helpdesk/admin/canned", "POST", {
      title: `${STAMP} VPN: re-pair after a phone change`,
      body: "Could you follow the 3 steps, {{requester.first_name}}, and tell me if it connects? I'll keep #{{ticket.number}} open.\n\n{{agent.first_name}}",
      folder: "VPN",
      share: `team:${T1}`,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.canned.team_id, T1);
    assert.equal((await call(libraryRoute.POST, "lead", "/api/helpdesk/admin/canned", "POST", { title: `${STAMP} x`, body: "x", share: `team:${T2}` })).status, 403);
    assert.equal((await call(libraryRoute.POST, "lead", "/api/helpdesk/admin/canned", "POST", { title: `${STAMP} x`, body: "x", share: "workspace" })).status, 403);
    const lib = await call(libraryRoute.GET, "lead", "/api/helpdesk/admin/canned");
    assert.equal(lib.status, 200);
    assert.deepEqual(
      lib.body.share_options.map((o: { value: string }) => o.value),
      ["me", `team:${T1}`],
      "the lead may share with themselves and their own team"
    );
    const row = lib.body.canned.find((c: any) => c.id === ok.body.canned.id);
    assert.equal(row.can_edit, true);
    // An Agent in the same team sees it but can't edit it.
    const agentLib = await call(libraryRoute.GET, "agent", "/api/helpdesk/admin/canned");
    const seen = agentLib.body.canned.find((c: any) => c.id === ok.body.canned.id);
    assert.equal(seen.can_edit, false);
    assert.equal((await call(itemRoute.PATCH, "agent", `/api/helpdesk/admin/canned/${row.id}`, "PATCH", { title: "Hijack" }, { id: String(row.id) })).status, 403);
    // The lead edits it; moving it to the workspace is not theirs to do.
    const ed = await call(itemRoute.PATCH, "lead", `/api/helpdesk/admin/canned/${row.id}`, "PATCH", { folder: "Remote access" }, { id: String(row.id) });
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    assert.equal(ed.body.canned.folder, "Remote access");
    assert.equal((await call(itemRoute.PATCH, "lead", `/api/helpdesk/admin/canned/${row.id}`, "PATCH", { share: "workspace" }, { id: String(row.id) })).status, 403);
    const upd = await auditRows("helpdesk.canned.updated", P.lead.id);
    assert.deepEqual(upd.at(-1)?.details.changed, ["folder"]);
    // The other team's agent never sees it.
    const out = await call(libraryRoute.GET, "outsider", "/api/helpdesk/admin/canned");
    assert.ok(!out.body.canned.some((c: any) => c.id === row.id));
    assert.equal((await call(itemRoute.DELETE, "outsider", `/api/helpdesk/admin/canned/${row.id}`, "DELETE", undefined, { id: String(row.id) })).status, 404);
  });

  test("a Manager writes the workspace's and every team's; moving scope is audited", async () => {
    const r = await call(libraryRoute.POST, "manager", "/api/helpdesk/admin/canned", "POST", {
      title: `${STAMP} Thanks, closing this one`,
      body: "Thanks {{requester.first_name}}, I'll close this one.",
      folder: "General",
      share: "workspace",
    });
    assert.equal(r.status, 201);
    const moved = await call(itemRoute.PATCH, "manager", `/api/helpdesk/admin/canned/${r.body.canned.id}`, "PATCH", { share: `team:${T2}` }, { id: String(r.body.canned.id) });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.canned.team_id, T2);
    const a = (await auditRows("helpdesk.canned.updated", P.manager.id)).at(-1)!;
    assert.equal(a.details.from_scope, "workspace");
    assert.equal(a.details.scope, "team");
    const del = await call(itemRoute.DELETE, "manager", `/api/helpdesk/admin/canned/${r.body.canned.id}`, "DELETE", undefined, { id: String(r.body.canned.id) });
    assert.equal(del.status, 200);
    assert.equal((await auditRows("helpdesk.canned.deleted", P.manager.id)).length, 1);
  });

  test("someone else's personal response is invisible, even to a Manager", async () => {
    const id = await seed("Ana's private", "mine only", { owner: P.agent.id });
    for (const who of ["manager", "lead", "outsider"]) {
      const lib = await call(libraryRoute.GET, who, "/api/helpdesk/admin/canned");
      assert.ok(!lib.body.canned.some((c: any) => c.id === id), who);
      assert.equal((await call(itemRoute.PATCH, who, `/api/helpdesk/admin/canned/${id}`, "PATCH", { title: "x" }, { id: String(id) })).status, 404, who);
    }
    const t = await newTicket("private check", T1);
    assert.equal((await call(useRoute.POST, "manager", `/api/helpdesk/canned/${id}/use`, "POST", { number: t.number }, { id: String(id) })).status, 404);
  });

  test("validation: names, unknown placeholders, folder length, sharing", async () => {
    const bad = async (body: Record<string, unknown>) => (await call(libraryRoute.POST, "manager", "/api/helpdesk/admin/canned", "POST", body)).body?.error ?? "";
    assert.match(await bad({ title: "", body: "x", share: "me" }), /name/);
    assert.match(await bad({ title: `${STAMP} t`, body: "  ", share: "me" }), /text/);
    assert.match(await bad({ title: `${STAMP} t`, body: "See {{ticket.url}}", share: "me" }), /\{\{ticket\.url\}\} isn't a placeholder/);
    assert.match(await bad({ title: `${STAMP} t`, body: "x", folder: "f".repeat(61), share: "me" }), /folder/);
    assert.match(await bad({ title: `${STAMP} t`, body: "x", share: "everyone" }), /shared/);
    assert.match(await bad({ title: `${STAMP} t`, body: "x", share: "team:999999999" }), /Unknown team/);
  });
});

// --- Using -----------------------------------------------------------------------------

describe("inserting in the composer", () => {
  test("fills for the ticket and the caller, counts the use, never changes the ticket", async () => {
    const id = await seed(
      "re-pair",
      "Could you follow the steps, {{requester.first_name}}? I'll keep #{{ticket.number}} open. {{team.name}}\n\n{{agent.first_name}}",
      { team: T1 },
      "VPN"
    );
    const t = await newTicket("VPN from home", T1);
    const before = (await pool().query("SELECT status, priority, team_id, tags, updated_at FROM hd_tickets WHERE id = $1", [t.id])).rows[0];
    const msgs = async () => Number((await pool().query("SELECT count(*) FROM hd_messages WHERE ticket_id = $1", [t.id])).rows[0].count);
    const m0 = await msgs();
    const r = await call(useRoute.POST, "agent", `/api/helpdesk/canned/${id}/use`, "POST", { number: t.number }, { id: String(id) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.body, `Could you follow the steps, Daniel? I'll keep #${t.number} open. ${T1name.replace(/_/g, "\\_")}\n\nAna`);
    assert.doesNotMatch(r.body.body, /\{\{/);
    const after = (await pool().query("SELECT status, priority, team_id, tags, updated_at FROM hd_tickets WHERE id = $1", [t.id])).rows[0];
    assert.deepEqual(after, before, "the ticket is untouched");
    assert.equal(await msgs(), m0, "no message is written");
    // A newbie inserts it too (canned responses need no capability).
    assert.equal((await call(useRoute.POST, "newbie", `/api/helpdesk/canned/${id}/use`, "POST", { number: t.number }, { id: String(id) })).status, 200);
    const row = await cannedLib.getCanned(id);
    assert.equal(row?.uses_30d, 2);
    const uses = await pool().query("SELECT user_id, ticket_id FROM hd_canned_uses WHERE canned_id = $1 ORDER BY id", [id]);
    assert.deepEqual(uses.rows, [
      { user_id: P.agent.id, ticket_id: t.id },
      { user_id: P.newbie.id, ticket_id: t.id },
    ]);
    // Old uses drop out of the 30-day count.
    await pool().query("UPDATE hd_canned_uses SET used_at = now() - interval '45 days' WHERE canned_id = $1 AND user_id = $2", [id, P.newbie.id]);
    assert.equal((await cannedLib.getCanned(id))?.uses_30d, 1);
  });

  test("a ticket the caller doesn't work, or another team's response, is a 404", async () => {
    const id = await seed("hr only", "HR text", { team: T2 });
    const itT = await newTicket("IT ticket", T1);
    const hrT = await newTicket("HR ticket", T2);
    assert.equal((await call(useRoute.POST, "outsider", `/api/helpdesk/canned/${id}/use`, "POST", { number: itT.number }, { id: String(id) })).status, 404);
    assert.equal((await call(useRoute.POST, "agent", `/api/helpdesk/canned/${id}/use`, "POST", { number: itT.number }, { id: String(id) })).status, 404);
    assert.equal((await call(useRoute.POST, "agent", `/api/helpdesk/canned/${id}/use`, "POST", { number: hrT.number }, { id: String(id) })).status, 404);
    assert.equal((await call(useRoute.POST, "agent", `/api/helpdesk/canned/${id}/use`, "POST", {}, { id: String(id) })).status, 400);
    assert.equal((await call(useRoute.POST, "req", `/api/helpdesk/canned/${id}/use`, "POST", { number: itT.number }, { id: String(id) })).status, 403);
  });

  test("the picker: workspace, my teams', mine, and the ticket's team when I'm assigned outside my teams", async () => {
    const ws = await seed("ws", "Workspace text");
    const it = await seed("it", "IT text", { team: T1 });
    const hr = await seed("hr", "HR text", { team: T2 });
    const mine = await seed("mine", "My text", { owner: P.outsider.id });
    const theirs = await seed("theirs", "Not yours", { owner: P.agent.id });
    const plain = await call(pickerRoute.GET, "outsider", "/api/helpdesk/canned");
    const ids = (b: any) => b.canned.map((c: any) => c.id);
    assert.ok(ids(plain.body).includes(ws) && ids(plain.body).includes(hr) && ids(plain.body).includes(mine));
    assert.ok(!ids(plain.body).includes(it) && !ids(plain.body).includes(theirs));
    // Assigned an IT ticket: IT's responses join, IT first.
    const t = await newTicket("assigned outside", T1, P.req, P.outsider.id);
    const onTicket = await call(pickerRoute.GET, "outsider", `/api/helpdesk/canned?ticket=${t.number}`);
    assert.ok(ids(onTicket.body).includes(it));
    assert.equal(onTicket.body.ticket_team_id, T1);
    assert.equal((await call(useRoute.POST, "outsider", `/api/helpdesk/canned/${it}/use`, "POST", { number: t.number }, { id: String(it) })).status, 200);
    // A ticket they can't work adds nothing.
    const other = await newTicket("not theirs", T1);
    const no = await call(pickerRoute.GET, "outsider", `/api/helpdesk/canned?ticket=${other.number}`);
    assert.ok(!ids(no.body).includes(it));
    assert.equal(no.body.ticket_team_id, null);
    // Unlicensed: 402.
    edition.features = [];
    try {
      assert.equal((await call(pickerRoute.GET, "outsider", "/api/helpdesk/canned")).status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });
});

// --- Claude connector --------------------------------------------------------------------

describe("hd_canned_responses", () => {
  test("listed for agents, read only, filled for a ticket they work, counts nothing", async () => {
    const id = await seed("connector", "Hi {{requester.first_name}}, about #{{ticket.number}}. {{agent.name}}", { team: T1 }, "VPN");
    const t = await newTicket("connector ticket", T1);
    const list = await rpc(P.agent.token, "tools/list", {});
    assert.ok(list.result.tools.some((x: { name: string }) => x.name === "hd_canned_responses"));
    const reqList = await rpc(P.req.token, "tools/list", {});
    assert.ok(!reqList.result.tools.some((x: { name: string }) => x.name === "hd_canned_responses"), "requesters don't see it");
    const r = await tool("agent", "hd_canned_responses", { query: "connector", number: t.number });
    assert.equal(r.isError, false, r.text);
    const hit = r.out.canned_responses.find((c: any) => c.id === id);
    assert.equal(hit.filled, `Hi Daniel, about #${t.number}. Ana Agent`);
    assert.equal(hit.folder, "VPN");
    assert.equal((await cannedLib.getCanned(id))?.uses_30d, 0, "reading via Claude is not a use");
    const plain = await tool("agent", "hd_canned_responses", { query: "connector" });
    assert.equal(plain.out.canned_responses[0].filled, undefined);
    const hrT = await newTicket("hr ticket for connector", T2);
    const no = await tool("agent", "hd_canned_responses", { number: hrT.number });
    assert.equal(no.isError, true);
    assert.match(no.text, /No ticket/);
    // Read only: listed even when the connector is set to read only.
    claude.setClaudeLevelForTests("read");
    try {
      assert.equal((await tool("agent", "hd_canned_responses", { query: "connector" })).isError, false);
    } finally {
      claude.setClaudeLevelForTests("notes");
    }
  });
});

// --- 1.19.2 review fixes ---------------------------------------------------------------

describe("review: limits, rate limit, deactivated owners", () => {
  test("personal responses count per owner (200), never against the workspace's shared ones", async () => {
    // Fill the agent's own list to the limit.
    await pool().query(
      `INSERT INTO hd_canned_responses (title, body, owner_id, created_by)
       SELECT $1 || ' fill ' || g, 'x', $2, $2 FROM generate_series(1, $3::int) g`,
      [STAMP, P.agent.id, CANNED_LIMITS.personal - (await pool().query("SELECT count(*)::int AS n FROM hd_canned_responses WHERE owner_id = $1", [P.agent.id])).rows[0].n]
    );
    const full = await call(libraryRoute.POST, "agent", "/api/helpdesk/admin/canned", "POST", { title: `${STAMP} one more`, body: "x", share: "me" });
    assert.equal(full.status, 409);
    assert.match(full.body.error, /up to 200 personal/);
    // Everyone else is unaffected: a Manager still creates a workspace one.
    const ws = await call(libraryRoute.POST, "manager", "/api/helpdesk/admin/canned", "POST", { title: `${STAMP} still fine`, body: "x", share: "workspace" });
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    // Moving a shared one into a full personal list is refused too.
    const team = await seed("move me", "x", { team: T1 });
    await deskRole(P.agent.id, "team_lead");
    try {
      const mv = await call(itemRoute.PATCH, "agent", `/api/helpdesk/admin/canned/${team}`, "PATCH", { share: "me" }, { id: String(team) });
      assert.equal(mv.status, 409);
    } finally {
      await deskRole(P.agent.id, "agent");
    }
    await pool().query("DELETE FROM hd_canned_responses WHERE owner_id = $1 AND title LIKE $2", [P.agent.id, `${STAMP} fill %`]);
  });

  test("the library's POST is rate limited (30 a minute)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await call(libraryRoute.POST, "outsider", "/api/helpdesk/admin/canned", "POST", { title: "", body: "", share: "me" })).status);
    assert.deepEqual(codes.slice(0, 30), Array(30).fill(400));
    assert.equal(codes[30], 429);
  });

  test("a Manager deletes a deactivated person's personal responses unread; an active person's are refused", async () => {
    const gone = await person("gone", "Gina Gone");
    await seed("gone 1", "secret text one", { owner: gone.id });
    await seed("gone 2", "secret text two", { owner: gone.id });
    await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [gone.id]);
    const lib = await call(libraryRoute.GET, "manager", "/api/helpdesk/admin/canned");
    const row = lib.body.inactive_owners.find((o: any) => o.owner_id === gone.id);
    assert.deepEqual(row, { owner_id: gone.id, name: "Gina Gone", count: 2 });
    assert.doesNotMatch(JSON.stringify(lib.body), /secret text/, "the text is never sent");
    assert.equal((await call(libraryRoute.GET, "lead", "/api/helpdesk/admin/canned")).body.inactive_owners, undefined, "only macros.manage_all sees the list");
    assert.equal((await call(inactiveRoute.DELETE, "lead", "/api/helpdesk/admin/canned/inactive", "DELETE", { owner_id: gone.id })).status, 403);
    assert.equal((await call(inactiveRoute.DELETE, "manager", "/api/helpdesk/admin/canned/inactive", "DELETE", { owner_id: P.agent.id })).status, 409);
    const del = await call(inactiveRoute.DELETE, "manager", "/api/helpdesk/admin/canned/inactive", "DELETE", { owner_id: gone.id });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, 2);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_canned_responses WHERE owner_id = $1", [gone.id])).rows[0].n, 0);
    const a = await auditRows("helpdesk.canned.purged", P.manager.id);
    assert.equal(a.at(-1)?.details.count, 2);
    assert.equal(a.at(-1)?.target_id, String(gone.id));
  });
});

describe("review: the ; picker never eats ordinary typing", () => {
  const list: HdCanned[] = [
    { id: 1, title: "VPN: re-pair", body: "Dear customer, do this", folder: "Remote", scope: "workspace", owner_id: null, team_id: null, team_name: null, uses_30d: 99, updated_at: "" },
    { id: 2, title: "Password reset", body: "Did you try", folder: "Accounts", scope: "workspace", owner_id: null, team_id: null, team_name: null, uses_30d: 1, updated_at: "" },
  ];
  const label = (q: string) => groupCanned(list, q, null, "label").flatMap((g) => g.items).length;
  test("an empty or one-letter query never shows the picker (' ;' Enter, ';D', ';P')", () => {
    for (const text of ["Voici les étapes ;", "Voici les étapes ;", "Thanks ;D", "Sure ;P", ";v"]) {
      const t = cannedTrigger(text, text.length);
      assert.ok(t, text);
      assert.equal(inlinePickerShows(t!.query, label(t!.query)), false, text);
    }
  });
  test("names and folders match, the text does not; nothing matching shows nothing", () => {
    assert.equal(label("dear"), 0, "a word only in a body");
    assert.equal(label("do"), 0);
    assert.equal(inlinePickerShows("dear", label("dear")), false);
    assert.equal(label("vpn"), 1);
    assert.equal(label("remote"), 1, "the folder");
    assert.equal(inlinePickerShows("vp", label("vp")), true);
    // The button's search still reads the text.
    assert.ok(cannedMatches(list[0], "dear"));
    assert.equal(cannedMatches(list[0], "dear", "label"), false);
  });
});

describe("review: braces, pruning, counting, team delete, edits", () => {
  test("single-brace typos are refused on save and stripped on insert", async () => {
    for (const body of ["Hi {{requester.first_name}, thanks", "Ticket {{ticket.number", "a}} b", "{{a{b}}"]) {
      assert.equal(strayBraces(body), true, body);
      const r = await call(libraryRoute.POST, "manager", "/api/helpdesk/admin/canned", "POST", { title: `${STAMP} brace`, body, share: "me" });
      assert.equal(r.status, 400, body);
      assert.match(r.body.error, /braces|placeholder/);
    }
    assert.equal(strayBraces("Hi {{requester.first_name}}, #{{ticket.number}} {single}"), false);
    const v = { requesterName: "Daniel", ticketNumber: 7, teamName: "", agentName: "" };
    assert.equal(renderCanned("Hi {{requester.first_name}, thanks {{ticket.number}}", v), "Hi , thanks 7");
    assert.doesNotMatch(renderCanned("x {{ y }} z}} {{", v), /\{\{|\}\}/);
    // A typo saved before the check (straight in the table) never reaches the reply.
    const id = await seed("old typo", "Hi {{requester.first_name}, #{{ticket.number}}", { owner: P.agent.id });
    const t = await newTicket("typo", T1);
    const used = await call(useRoute.POST, "agent", `/api/helpdesk/canned/${id}/use`, "POST", { number: t.number }, { id: String(id) });
    assert.equal(used.body.body, `Hi , #${t.number}`);
  });

  test("uses older than 90 days are pruned for every response in one statement; the sweep runs it; indexes exist", async () => {
    const a = await seed("prune a", "x");
    const b = await seed("prune b", "x");
    await pool().query(
      `INSERT INTO hd_canned_uses (canned_id, user_id, used_at) VALUES ($1, $3, now() - interval '100 days'), ($2, $3, now() - interval '91 days'), ($2, $3, now() - interval '10 days')`,
      [a, b, P.agent.id]
    );
    const gone = await cannedLib.pruneCannedUses({ force: true });
    assert.ok(gone >= 2);
    const left = await pool().query("SELECT canned_id FROM hd_canned_uses WHERE canned_id = ANY($1)", [[a, b]]);
    assert.deepEqual(left.rows, [{ canned_id: b }]);
    assert.ok(periodic.HELPDESK_SWEEPS.some((s) => s.name === "hd_canned"));
    const idx = await pool().query("SELECT indexname FROM pg_indexes WHERE tablename = 'hd_canned_uses'");
    const names = idx.rows.map((r: { indexname: string }) => r.indexname);
    for (const n of ["idx_hd_canned_uses_ticket", "idx_hd_canned_uses_user", "idx_hd_canned_uses_used_at"]) assert.ok(names.includes(n), n);
  });

  test("a use counts once per person, response and ticket an hour", async () => {
    const id = await seed("count once", "x", { team: T1 });
    const t1 = await newTicket("count 1", T1);
    const t2 = await newTicket("count 2", T1);
    for (let i = 0; i < 5; i++) assert.equal((await call(useRoute.POST, "agent", `/api/helpdesk/canned/${id}/use`, "POST", { number: t1.number }, { id: String(id) })).status, 200);
    assert.equal((await cannedLib.getCanned(id))?.uses_30d, 1);
    await call(useRoute.POST, "agent", `/api/helpdesk/canned/${id}/use`, "POST", { number: t2.number }, { id: String(id) });
    await call(useRoute.POST, "lead", `/api/helpdesk/canned/${id}/use`, "POST", { number: t1.number }, { id: String(id) });
    assert.equal((await cannedLib.getCanned(id))?.uses_30d, 3);
    await pool().query("UPDATE hd_canned_uses SET used_at = now() - interval '61 minutes' WHERE canned_id = $1", [id]);
    assert.equal(await cannedLib.recordCannedUse(id, P.agent.id, t1.id), true);
    assert.equal((await cannedLib.getCanned(id))?.uses_30d, 4);
  });

  test("deleting a team says how many canned responses go, and the audit counts them", async () => {
    const T3 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9403) RETURNING id", [`${STAMP} Gone team`])).rows[0].id as number;
    await seed("team gone 1", "x", { team: T3 });
    await seed("team gone 2", "x", { team: T3 });
    const c = await call(teamCountRoute.GET, "manager", `/api/helpdesk/admin/canned/team-count?team=${T3}`);
    assert.deepEqual(c.body, { count: 2 });
    assert.equal((await call(teamCountRoute.GET, "agent", `/api/helpdesk/admin/canned/team-count?team=${T3}`)).status, 403);
    const del = await call(teamRoute.DELETE, "manager", `/api/helpdesk/admin/teams/${T3}`, "DELETE", undefined, { id: String(T3) });
    assert.equal(del.status, 200);
    const a = await auditRows("helpdesk.team.deleted", P.manager.id);
    assert.equal(a.at(-1)?.details.canned_responses_deleted, 2);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_canned_responses WHERE team_id = $1", [T3])).rows[0].n, 0);
  });

  test("an edit writes only the fields sent, refuses a concurrent sharing change, and audits only real changes", async () => {
    const id = await seed("partial", "original body", { team: T1 }, "F1");
    // Someone else's body change lands between our read and our title-only write: it survives.
    await pool().query("UPDATE hd_canned_responses SET body = 'their body' WHERE id = $1", [id]);
    const r = await call(itemRoute.PATCH, "lead", `/api/helpdesk/admin/canned/${id}`, "PATCH", { title: `${STAMP} renamed` }, { id: String(id) });
    assert.equal(r.status, 200);
    assert.equal(r.body.canned.body, "their body");
    assert.equal(r.body.canned.title, `${STAMP} renamed`);
    // Stale sharing: the write is refused and changes nothing.
    await assert.rejects(
      cannedLib.updateCanned(id, { title: "late" }, { owner_id: null, team_id: T2 }),
      (e: Error & { status?: number }) => e.status === 409 && /shared with just now/.test(e.message)
    );
    assert.equal((await cannedLib.getCanned(id))?.title, `${STAMP} renamed`);
    // The UI sends every field: only the one that changed is audited; no change, no audit row.
    const before = (await auditRows("helpdesk.canned.updated", P.lead.id)).length;
    const all = { title: `${STAMP} renamed again`, body: "their body", folder: "F1", share: `team:${T1}` };
    assert.equal((await call(itemRoute.PATCH, "lead", `/api/helpdesk/admin/canned/${id}`, "PATCH", all, { id: String(id) })).status, 200);
    const rows = await auditRows("helpdesk.canned.updated", P.lead.id);
    assert.equal(rows.length, before + 1);
    assert.deepEqual(rows.at(-1)?.details.changed, ["title"]);
    assert.equal((await call(itemRoute.PATCH, "lead", `/api/helpdesk/admin/canned/${id}`, "PATCH", all, { id: String(id) })).status, 200);
    assert.equal((await auditRows("helpdesk.canned.updated", P.lead.id)).length, before + 1);
  });
});
