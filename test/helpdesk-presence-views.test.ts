// Helpdesk 1.19.1 collision warnings and saved views (agent V4).
//
//   presence   the heartbeat lists the other agents (viewing / replying)
//              for 30 s; stale rows are ignored and swept; requesters and
//              agents outside the ticket's team never read or write it
//   send guard a newer public reply or internal note by someone else since
//              expect_last_message_id answers 409 { newer } and posts
//              nothing (the messages route and a macro's reply alike);
//              force sends; one's own messages, timeline lines and no
//              expectation never block
//   views      personal views are their owner's alone; a team view is
//              created and changed by a lead of that team and seen by its
//              members; filters are the tickets API's whitelist and parser;
//              counts run in each viewer's own scope; every write audited
//
// Parallel-safe: every account, team, ticket, macro and view is this file's
// own (STAMP); nobody is a workspace administrator.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-presence-views.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-pv.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-pv.virtual.js");
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
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messagesLib = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const macros = require("../src/lib/helpdesk/macros") as typeof import("../src/lib/helpdesk/macros");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const presence = require("../src/lib/helpdesk/presence") as typeof import("../src/lib/helpdesk/presence");
const savedViews = require("../src/lib/helpdesk/saved-views") as typeof import("../src/lib/helpdesk/saved-views");
const presenceRoute = require("../src/app/api/helpdesk/tickets/[number]/presence/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/presence/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const macroRoute = require("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route");
const ticketsRoute = require("../src/app/api/helpdesk/tickets/route") as typeof import("../src/app/api/helpdesk/tickets/route");
const viewsRoute = require("../src/app/api/helpdesk/views/route") as typeof import("../src/app/api/helpdesk/views/route");
const viewRoute = require("../src/app/api/helpdesk/views/[id]/route") as typeof import("../src/app/api/helpdesk/views/[id]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdTicket } from "../src/lib/helpdesk/types";

type AnyHandler = (req: Request, ctx?: any) => Promise<Response>;

async function call(handler: AnyHandler, req: Request, params?: Record<string, string>): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = params ? await handler(req, { params: Promise.resolve(params) }) : await handler(req);
    let body: any = null;
    try {
      body = await res.clone().json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

const URL_BASE = "http://localhost/api/helpdesk";
function req(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`${URL_BASE}${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdpv-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
  email: string;
}
const P: Record<string, Person> = {};
const personIds: number[] = [];
const roleIds: number[] = [];
const teamIds: number[] = [];
const ticketIds: number[] = [];
const macroIds: number[] = [];
let A = 0;
let B = 0;

async function person(key: string, name: string): Promise<Person> {
  const addr = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    addr,
  ]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  personIds.push(id);
  P[key] = { id, session, name, email: addr };
  return P[key];
}

async function team(name: string, members: [string, "agent" | "lead"][]): Promise<number> {
  const r = await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} ${name}`]);
  const id = r.rows[0].id as number;
  teamIds.push(id);
  for (const [k, role] of members) await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3)", [id, P[k].id, role]);
  return id;
}

async function raise(teamId: number, subject: string): Promise<HdTicket> {
  const t = await tickets.createTicket(
    {
      subject,
      body: "Since this morning the VPN client says Authentication failed.",
      requester: { id: P.req.id, name: P.req.name, email: P.req.email },
      team_id: teamId,
      answers: {} as never,
    } as never,
    { silent: true, actorId: P.req.id, actorName: P.req.name }
  );
  ticketIds.push(t.id);
  return (await tickets.getTicketById(t.id))!;
}

const lastId = async (ticketId: number) =>
  Number((await pool().query("SELECT max(id) AS id FROM hd_messages WHERE ticket_id = $1", [ticketId])).rows[0].id);
const countMessages = async (ticketId: number) => Number((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1", [ticketId])).rows[0].n);

const beat = (who: Person, n: number, state: string) => call(presenceRoute.POST as AnyHandler, req(`/tickets/${n}/presence`, who.session, { state }), { number: String(n) });
const look = (who: Person, n: number) => call(presenceRoute.GET as AnyHandler, req(`/tickets/${n}/presence`, who.session), { number: String(n) });
const post = (who: Person, n: number, body: Record<string, unknown>) =>
  call(messagesRoute.POST as AnyHandler, req(`/tickets/${n}/messages`, who.session, body), { number: String(n) });

before(async () => {
  await getSetting("__schema_bootstrap__");
  await pool().query(roles.HD_ROLES_SCHEMA);
  for (const [k, n] of [
    ["req", "Daniel Okafor"],
    ["lead", "Lena Lead"],
    ["sam", "Sam Lee"],
    ["ana", "Ana Kowalski"],
    ["other", "Otto Other"],
  ] as const) {
    await person(k, n);
  }
  const role = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-request`]);
  roleIds.push(role.rows[0].id);
  await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.request')", [role.rows[0].id]);
  for (const id of personIds) await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [role.rows[0].id, id]);
  for (const [k, r] of [["lead", "team_lead"], ["sam", "agent"], ["ana", "agent"], ["other", "agent"]] as const) {
    await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [P[k].id, r]);
  }
  A = await team("IT", [["lead", "lead"], ["sam", "agent"], ["ana", "agent"]]);
  B = await team("Facilities", [["other", "agent"]]);
  notify.setAgentDeliverySpyForTests(() => {});
  email.setHelpdeskTransportForTests(async () => {});
});

after(async () => {
  notify.setAgentDeliverySpyForTests(null);
  email.setHelpdeskTransportForTests(null);
  await pool().query("DELETE FROM hd_saved_views WHERE owner_id = ANY($1) OR team_id = ANY($2)", [personIds, teamIds]);
  await pool().query("DELETE FROM hd_ticket_presence WHERE ticket_id = ANY($1) OR user_id = ANY($2)", [ticketIds, personIds]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ticketIds]);
  await pool().query("DELETE FROM hd_macros WHERE id = ANY($1)", [macroIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [teamIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [personIds]);
  await pool().end();
});

// --- Presence ----------------------------------------------------------------------

describe("presence", () => {
  test("the heartbeat lists the other agents with their state, never oneself", async () => {
    const t = await raise(A, `${STAMP} presence`);
    const first = await beat(P.sam, t.number, "viewing");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.present, []);
    const second = await beat(P.ana, t.number, "replying");
    assert.equal(second.status, 200);
    assert.equal(second.body.present.length, 1);
    assert.equal(second.body.present[0].name, "Sam Lee");
    assert.equal(second.body.present[0].initials, "SL");
    assert.equal(second.body.present[0].state, "viewing");
    const seen = await look(P.sam, t.number);
    assert.equal(seen.status, 200);
    assert.deepEqual(
      seen.body.present.map((p: any) => [p.name, p.state]),
      [["Ana Kowalski", "replying"]]
    );
    // A bad state is refused.
    assert.equal((await beat(P.sam, t.number, "typing")).status, 400);
  });

  test("a row older than 30 seconds counts as gone, and the sweep deletes old rows", async () => {
    const t = await raise(A, `${STAMP} ttl`);
    await beat(P.sam, t.number, "viewing");
    await pool().query("UPDATE hd_ticket_presence SET seen_at = now() - interval '31 seconds' WHERE ticket_id = $1 AND user_id = $2", [t.id, P.sam.id]);
    assert.deepEqual((await look(P.ana, t.number)).body.present, []);
    await pool().query("UPDATE hd_ticket_presence SET seen_at = now() - interval '10 minutes' WHERE ticket_id = $1 AND user_id = $2", [t.id, P.sam.id]);
    await presence.sweepPresence(new Date());
    const rows = await pool().query("SELECT 1 FROM hd_ticket_presence WHERE ticket_id = $1", [t.id]);
    assert.equal(rows.rowCount, 0);
  });

  test("leaving deletes one's own row at once", async () => {
    const t = await raise(A, `${STAMP} leave`);
    await beat(P.sam, t.number, "viewing");
    const del = await call(presenceRoute.DELETE as AnyHandler, req(`/tickets/${t.number}/presence`, P.sam.session, undefined, "DELETE"), { number: String(t.number) });
    assert.equal(del.status, 200);
    assert.deepEqual((await look(P.ana, t.number)).body.present, []);
  });

  test("requesters and agents outside the ticket's team can't read or write presence", async () => {
    const t = await raise(A, `${STAMP} private`);
    await beat(P.sam, t.number, "replying");
    // The requester holds helpdesk.request only: no desk role.
    assert.equal((await look(P.req, t.number)).status, 403);
    assert.equal((await beat(P.req, t.number, "viewing")).status, 403);
    // An agent of another team: the same 404 as a missing ticket.
    assert.equal((await look(P.other, t.number)).status, 404);
    assert.equal((await beat(P.other, t.number, "viewing")).status, 404);
    const rows = await pool().query("SELECT user_id FROM hd_ticket_presence WHERE ticket_id = $1", [t.id]);
    assert.deepEqual(rows.rows.map((r) => r.user_id), [P.sam.id]);
  });
});

// --- The send guard ------------------------------------------------------------------

describe("send guard", () => {
  test("a reply that landed while typing answers 409 with it, and nothing is posted", async () => {
    const t = await raise(A, `${STAMP} collide`);
    const start = await lastId(t.id);
    const sam = await post(P.sam, t.number, { kind: "public", body: "I've reset your VPN token.", expect_last_message_id: start });
    assert.equal(sam.status, 201, JSON.stringify(sam.body));
    const before = await countMessages(t.id);
    const ana = await post(P.ana, t.number, { kind: "public", body: "Could you re-pair the client?", expect_last_message_id: start });
    assert.equal(ana.status, 409);
    assert.equal(ana.body.newer.length, 1);
    assert.equal(ana.body.newer[0].author_name, "Sam Lee");
    assert.equal(ana.body.newer[0].kind, "public");
    assert.equal(ana.body.newer[0].from_requester, false);
    assert.match(ana.body.newer[0].body, /reset your VPN token/);
    assert.equal(await countMessages(t.id), before, "nothing was posted");
    // Send anyway.
    const forced = await post(P.ana, t.number, { kind: "public", body: "Could you re-pair the client?", expect_last_message_id: start, force: true });
    assert.equal(forced.status, 201);
  });

  test("one's own messages, timeline lines and a missing expectation never block", async () => {
    const t = await raise(A, `${STAMP} own`);
    const start = await lastId(t.id);
    assert.equal((await post(P.sam, t.number, { kind: "internal", body: "Looking now.", expect_last_message_id: start })).status, 201);
    await messagesLib.addSystemMessage(t.id, "Status changed", { internal: true });
    await messagesLib.addSystemMessage(t.id, "Assigned", {});
    // Sam's own note and the two timeline lines are newer, but none counts.
    assert.equal((await post(P.sam, t.number, { kind: "public", body: "Fixed.", expect_last_message_id: start })).status, 201);
    // No expectation (older clients): sent as before.
    assert.equal((await post(P.ana, t.number, { kind: "public", body: "Thanks Sam." })).status, 201);
    // A malformed expectation is refused.
    assert.equal((await post(P.ana, t.number, { kind: "public", body: "x", expect_last_message_id: "abc" })).status, 400);
  });

  test("someone else's internal note counts too, and so does the requester's reply", async () => {
    const t = await raise(A, `${STAMP} notes`);
    const start = await lastId(t.id);
    await post(P.sam, t.number, { kind: "internal", body: "MFA re-enrolled yesterday." });
    const r = await post(P.ana, t.number, { kind: "internal", body: "Token cached?", expect_last_message_id: start });
    assert.equal(r.status, 409);
    assert.equal(r.body.newer[0].kind, "internal");
    const mid = await lastId(t.id);
    await messagesLib.addMessage(t.id, { kind: "public", body: "Still broken.", author: { id: P.req.id, name: P.req.name, email: P.req.email }, via: "portal", asRequester: true });
    const r2 = await post(P.ana, t.number, { kind: "public", body: "Try again?", expect_last_message_id: mid });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.newer.length, 1);
    assert.equal(r2.body.newer[0].from_requester, true);
  });

  test("a macro's reply takes the same guard, and force sends it", async () => {
    const t = await raise(A, `${STAMP} macro`);
    const m = await macros.createMacro({ title: `${STAMP} macro`, body: "Please sign out of the VPN client and back in.", actions: {}, team_id: A }, null);
    macroIds.push(m.id);
    const start = await lastId(t.id);
    await post(P.sam, t.number, { kind: "public", body: "On it." });
    const before = await countMessages(t.id);
    const apply = (body: Record<string, unknown>) =>
      call(macroRoute.POST as AnyHandler, req(`/tickets/${t.number}/macro/${m.id}`, P.ana.session, body), { number: String(t.number), macroId: String(m.id) });
    // A preview writes nothing and is never guarded.
    assert.equal((await apply({ preview: true, expect_last_message_id: start })).status, 200);
    const blocked = await apply({ expect_last_message_id: start });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.newer[0].author_name, "Sam Lee");
    assert.equal(await countMessages(t.id), before);
    const forced = await apply({ expect_last_message_id: start, force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.equal(await countMessages(t.id), before + 1);
  });
});

// --- Saved views ----------------------------------------------------------------------

const views = (who: Person) => call(viewsRoute.GET as AnyHandler, req("/views", who.session));
const createV = (who: Person, body: Record<string, unknown>) => call(viewsRoute.POST as AnyHandler, req("/views", who.session, body));
const patchV = (who: Person, id: number, body: Record<string, unknown>) =>
  call(viewRoute.PATCH as AnyHandler, req(`/views/${id}`, who.session, body, "PATCH"), { id: String(id) });
const deleteV = (who: Person, id: number) => call(viewRoute.DELETE as AnyHandler, req(`/views/${id}`, who.session, undefined, "DELETE"), { id: String(id) });
const audits = async (action: string, id: number) =>
  Number((await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND target_id = $2", [action, String(id)])).rows[0].n);

describe("saved views", () => {
  test("a personal view is its owner's alone", async () => {
    const r = await createV(P.sam, { name: "  VPN   this week ", filters: { view: "all", q: "VPN", status_group: "open", created_within: "7", sort: "priority" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const v = r.body.view;
    assert.equal(v.name, "VPN this week");
    assert.equal(v.owner_id, P.sam.id);
    assert.equal(v.can_edit, true);
    assert.deepEqual(v.filters, { view: "all", q: "VPN", status_group: "open", created_within: "7" }, "sort is the list's, not the view's");
    assert.equal(await audits("helpdesk.view.created", v.id), 1);
    assert.ok(!(await views(P.ana)).body.views.some((x: any) => x.id === v.id));
    assert.equal((await patchV(P.ana, v.id, { name: "Mine now" })).status, 404);
    assert.equal((await deleteV(P.lead, v.id)).status, 404);
    const renamed = await patchV(P.sam, v.id, { name: "VPN, open" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.view.name, "VPN, open");
    assert.equal(await audits("helpdesk.view.updated", v.id), 1);
    assert.equal((await deleteV(P.sam, v.id)).status, 200);
    assert.equal(await audits("helpdesk.view.deleted", v.id), 1);
  });

  test("a team view: leads create and change it, members see it, other teams don't", async () => {
    assert.equal((await createV(P.sam, { name: "Urgent", filters: { priority: "urgent" }, team_id: A })).status, 403);
    assert.equal((await createV(P.lead, { name: "Urgent", filters: { priority: "urgent" }, team_id: B })).status, 403, "not a lead of that team");
    const lists = await views(P.lead);
    assert.deepEqual(lists.body.share_teams.map((t: any) => t.id), [A]);
    assert.deepEqual((await views(P.sam)).body.share_teams, []);
    const r = await createV(P.lead, { name: "Urgent and high", filters: { view: "open", priority: "urgent" }, team_id: A });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.view.id;
    const seen = (await views(P.sam)).body.views.find((x: any) => x.id === id);
    assert.ok(seen, "a member sees the team's view");
    assert.equal(seen.can_edit, false);
    assert.equal(seen.team_name, `${STAMP} IT`);
    assert.ok(!(await views(P.other)).body.views.some((x: any) => x.id === id), "another team doesn't");
    assert.equal((await patchV(P.sam, id, { name: "Mine" })).status, 403);
    assert.equal((await deleteV(P.sam, id)).status, 403);
    assert.equal((await patchV(P.other, id, { name: "Mine" })).status, 404);
    assert.equal((await patchV(P.lead, id, { filters: { view: "open", priority: "high" } })).status, 200);
    assert.equal((await deleteV(P.lead, id)).status, 200);
  });

  test("filters are the tickets API's whitelist, checked by the same parser", async () => {
    const bad = async (filters: unknown) => (await createV(P.sam, { name: "Bad", filters })).status;
    assert.equal(await bad({ owner: "me" }), 400, "unknown key");
    assert.equal(await bad({ priority: "nope" }), 400);
    assert.equal(await bad({ view: "everything" }), 400);
    assert.equal(await bad({ created_from: "2026-02-31" }), 400);
    assert.equal(await bad({ created_within: "0" }), 400);
    assert.equal(await bad({ assignee: { id: 1 } }), 400);
    assert.equal(await bad(["view", "all"]), 400);
    assert.equal((await createV(P.sam, { name: "", filters: {} })).status, 400);
    assert.equal((await createV(P.sam, { name: "x".repeat(61), filters: {} })).status, 400);
    // The list route reads created_within through the same parser.
    const list = await call(ticketsRoute.GET as AnyHandler, req(`/tickets?view=all&created_within=1&q=${STAMP}`, P.sam.session));
    assert.equal(list.status, 200);
    assert.equal((await call(ticketsRoute.GET as AnyHandler, req(`/tickets?created_within=abc`, P.sam.session))).status, 400);
  });

  test("counts run in each viewer's own scope", async () => {
    const token = `${STAMP}-count`;
    await raise(A, `${token} one`);
    await raise(A, `${token} two`);
    await raise(B, `${token} three`);
    const filters = { view: "all", q: token };
    const mine = (await createV(P.sam, { name: "Count", filters })).body.view;
    const theirs = (await createV(P.other, { name: "Count", filters })).body.view;
    const team = (await createV(P.lead, { name: "Team count", filters, team_id: A })).body.view;
    savedViews.clearViewCountCache();
    const sam = (await views(P.sam)).body.views;
    assert.equal(sam.find((v: any) => v.id === mine.id).count, 2);
    assert.equal(sam.find((v: any) => v.id === team.id).count, 2);
    assert.equal((await views(P.other)).body.views.find((v: any) => v.id === theirs.id).count, 1);
    // Without counts.
    const quick = await call(viewsRoute.GET as AnyHandler, req("/views?counts=0", P.sam.session));
    assert.equal(quick.body.views.find((v: any) => v.id === mine.id).count, undefined);
  });
});
