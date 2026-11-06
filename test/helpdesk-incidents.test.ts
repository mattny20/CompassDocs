// Helpdesk 1.19.2 major incidents (agent W1): declaring opens the
// incident's own ticket and links the chosen ones (each checked: the agent
// works it and may link in its team; workflow tasks, merged and closed
// tickets, incidents and tickets linked elsewhere refused); linking and
// unlinking are checked per ticket; the rule links matching new tickets
// while the incident is open; an update is a public message on every open
// linked ticket and one hd_incident_update notice per person (requesters,
// CCs, Me too); solving goes through the normal solve path per ticket; the
// Get help banner follows its audience and Me too counts people without a
// ticket; queue rows carry the chip; the Status page mirror follows.
//
// Route handlers are called directly with real sessions (next/headers and
// lib/ee stubbed, as test/helpdesk-merge-bulk does). Parallel-safe: teams,
// people, tickets, incidents and the one Status page service are this
// file's own (STAMP); the role matrix is the process-local test seam.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-incidents.test.ts

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-incidents.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-incidents.virtual.js");
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
  ee.exports = {
    ee: () => ({ present: true, features: ["helpdesk"] }),
    eePresent: () => true,
    featureEnabled: async (feature: string) => feature === "helpdesk",
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
const shared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const dbCore = require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const incidents = require("../src/lib/helpdesk/incidents") as typeof import("../src/lib/helpdesk/incidents");
const inc$ = require("../src/lib/helpdesk/incidents-shared") as typeof import("../src/lib/helpdesk/incidents-shared");
const policy = require("../src/lib/notify-policy-shared") as typeof import("../src/lib/notify-policy-shared");
const templates = require("../src/lib/email-templates") as typeof import("../src/lib/email-templates");
const listRoute = require("../src/app/api/helpdesk/incidents/route") as typeof import("../src/app/api/helpdesk/incidents/route");
const settingsRoute = require("../src/app/api/helpdesk/incidents/[number]/route") as typeof import("../src/app/api/helpdesk/incidents/[number]/route");
const linksRoute = require("../src/app/api/helpdesk/incidents/[number]/links/route") as typeof import("../src/app/api/helpdesk/incidents/[number]/links/route");
const updatesRoute = require("../src/app/api/helpdesk/incidents/[number]/updates/route") as typeof import("../src/app/api/helpdesk/incidents/[number]/updates/route");
const ticketRoute = require("../src/app/api/helpdesk/incidents/ticket/[number]/route") as typeof import("../src/app/api/helpdesk/incidents/ticket/[number]/route");
const bannersRoute = require("../src/app/api/helpdesk/incidents/banners/route") as typeof import("../src/app/api/helpdesk/incidents/banners/route");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const mergeLib = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const ccs = require("../src/lib/helpdesk/ccs") as typeof import("../src/lib/helpdesk/ccs");
const deskTicketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const meTooRoute = require("../src/app/api/helpdesk/incidents/banners/[id]/route") as typeof import("../src/app/api/helpdesk/incidents/banners/[id]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string, body?: unknown, method?: string): Request {
  return new Request(`http://localhost/api/helpdesk${url}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdinc-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
  email: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
let T1 = 0;
let T2 = 0;
let serviceId = 0;
const mail: { to: string; cc?: string; subject: string; text: string }[] = [];
const told: { userId: number | null; email: string; ticketNumber: number | null }[] = [];

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
  userIds.push(id);
  P[key] = { id, session, name, email: addr };
  return P[key];
}

async function grant(userId: number, perms: string[], tag: string): Promise<void> {
  const r = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-${tag}`]);
  roleIds.push(r.rows[0].id);
  for (const p of perms) await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)", [r.rows[0].id, p]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [r.rows[0].id, userId]);
}

async function deskRole(userId: number, role: HdRole) {
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [userId, role]);
}
async function member(teamId: number, userId: number, role: "agent" | "lead" = "agent") {
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [teamId, userId, role]);
}

let seq = 0;
/** A ticket without the after-create hooks (no shared rules run on it). */
async function ticket(opts: { team?: number; requester?: Person; subject?: string; status?: "new" | "open" | "solved" | "closed"; source?: "portal" | "workflow"; parent?: number } = {}) {
  const who = opts.requester ?? P.req1;
  return dbCore.withTx((c) =>
    tickets.insertTicketTx(c, {
      subject: opts.subject ?? `${STAMP} printer ${++seq}`,
      body: `First message ${seq}`,
      requester: { id: who.id, name: who.name, email: who.email },
      team_id: opts.team ?? T1,
      status: opts.status,
      source: opts.source,
      parent_ticket_id: opts.parent ?? null,
    })
  );
}

const row = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const rowByNumber = async (n: number) => (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [n])).rows[0];
const messages = async (id: number) => (await pool().query("SELECT kind, body, author_id, via FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [id])).rows;
const declareRoute = (by: Person, body: Record<string, unknown>) => call(listRoute.POST, req("/incidents", by.session, { team_id: T1, title: `${STAMP} VPN is down`, ...body }));
/**
 * Set-ups declare through the library (the route allows 10 a minute per
 * person, which this file passes); the declare tests use the route. Same
 * answer shape as the route's.
 */
async function declare(by: Person, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  try {
    const input = inc$.validateDeclare({ team_id: T1, title: `${STAMP} VPN is down`, ...body });
    const r = await incidents.declareIncident({ id: by.id, role: "viewer", name: by.name, username: by.name, email: by.email }, input);
    await r.notices;
    return { status: 201, body: { id: r.id, number: r.number, linked: r.linked } };
  } catch (e) {
    const err = incidents.incidentErrorBody(e);
    if (err) return { status: err.status, body: err.body };
    throw e;
  }
}
const post = (by: Person, n: number, body: unknown) => call(updatesRoute.POST, req(`/incidents/${n}/updates`, by.session, body), { number: String(n) });
const link = (by: Person, n: number, numbers: number[]) => call(linksRoute.POST, req(`/incidents/${n}/links`, by.session, { numbers }), { number: String(n) });
/** Posting through the library (the route allows 10 a minute per person, which this file passes); same answer shape. */
async function postLib(by: Person, n: number, body: { body: string; solve?: boolean }): Promise<{ status: number; body: any }> {
  try {
    const r = await incidents.postUpdate({ id: by.id, role: "viewer", name: by.name, username: by.name, email: by.email }, n, { body: body.body, solve: body.solve === true });
    return { status: 200, body: { update: r.update, skipped: r.skipped, solve: r.solve } };
  } catch (e) {
    const err = incidents.incidentErrorBody(e);
    if (err) return { status: err.status, body: err.body };
    throw e;
  }
}
const banners = async (by: Person) => (await call(bannersRoute.GET, req("/incidents/banners", by.session))).body.banners as import("../src/lib/helpdesk/incidents-shared").IncidentBannerView[];
const mine = <T extends { title: string }>(bs: T[]): T[] => bs.filter((b) => b.title.startsWith(STAMP));

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
  for (const [k, n] of [
    ["agent", "Ana Agent"],
    ["lead", "Lee Lead"],
    ["newbie", "Ned Newbie"],
    ["other", "Oda Otherteam"],
    ["req1", "Tom Becker"],
    ["req2", "Priya Natarajan"],
    ["req3", "Daniel Okafor"],
    ["cc", "Carla Copied"],
    ["bystander", "Bea Bystander"],
    ["mgr", "Mia Manager"],
  ] as const) {
    await person(k, n);
  }
  T1 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9201) RETURNING id", [`${STAMP} IT`])).rows[0].id;
  T2 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9202) RETURNING id", [`${STAMP} HR`])).rows[0].id;
  await deskRole(P.agent.id, "agent");
  await deskRole(P.lead.id, "team_lead");
  await deskRole(P.newbie.id, "newbie");
  await deskRole(P.other.id, "agent");
  await deskRole(P.mgr.id, "manager");
  await member(T1, P.mgr.id);
  await member(T1, P.agent.id);
  await member(T1, P.newbie.id);
  await member(T1, P.lead.id, "lead");
  await member(T2, P.other.id);
  for (const k of ["req1", "req2", "req3", "cc", "bystander"]) await grant(P[k].id, ["helpdesk.request"], k);
  await grant(P.lead.id, ["status.incident_manage"], "lead-status");
  serviceId = (await fixtureQuery("INSERT INTO status_services (name, provider, source_url, status) VALUES ($1, 'manual', '', 'operational') RETURNING id", [`${STAMP} VPN`])).rows[0].id;
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push({ to: m.to, cc: m.cc, subject: m.subject, text: m.text });
  });
  incidents.setIncidentNoticeSpyForTests((w) => told.push(w));
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  email.setHelpdeskTransportForTests(null);
  incidents.setIncidentNoticeSpyForTests(null);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR subject LIKE $3", [[T1, T2], userIds, `${STAMP}%`])).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_incidents WHERE ticket_id = ANY($1)", [all]);
  await pool().query("UPDATE hd_tickets SET merged_into = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[T1, T2]]);
  await pool().query("DELETE FROM status_services WHERE id = $1", [serviceId]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR (action = 'helpdesk.incident.auto_linked' AND details->>'match' LIKE $2)", [userIds, `${STAMP}%`]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Pure pieces ---------------------------------------------------------------------

describe("shared", () => {
  test("the rule matches a term at a word start, case-insensitively, any of up to five", () => {
    assert.equal(inc$.matchesRule("VPN down for everyone", "vpn"), true);
    assert.equal(inc$.matchesRule("my laptop's vpn's slow", "vpn"), true);
    assert.equal(inc$.matchesRule("OpenVPN client update", "vpn"), false);
    assert.equal(inc$.matchesRule("Remote desktop not reachable", "vpn, remote desktop"), true);
    assert.equal(inc$.matchesRule("anything", ""), false);
    assert.equal(inc$.matchesRule("a (bb) c", "(bb"), true, "terms are literal, not patterns");
    assert.deepEqual(inc$.ruleTerms(" VPN, vpn ,Wifi,, "), ["vpn", "wifi"]);
  });

  test("input checks", () => {
    assert.throws(() => inc$.validateDeclare({ title: "  " }), /title/);
    assert.throws(() => inc$.validateDeclare({ title: "x", numbers: ["abc"] }), /Ticket numbers/);
    assert.throws(() => inc$.cleanMatch("a,b,c,d,e,f"), /Up to 5/);
    assert.throws(() => inc$.cleanMatch("vp"), /three letters/, "review W1 #9: at least three letters");
    assert.equal(inc$.matchesRule("vp is slow", "vp"), false, "a two-letter term stored before the limit is ignored");
    const d = inc$.validateDeclare({ title: " VPN  down ", team_id: 3, numbers: [1052, "#1051", 1052], match_text: "vpn" });
    assert.deepEqual(d, { title: "VPN down", team_id: 3, priority: "urgent", numbers: [1052, 1051], match_text: "vpn", banner: "workspace", notify_on_link: true });
    assert.equal(inc$.validateDeclare({ title: "x", banner: false }).banner, "off");
    assert.equal(inc$.sentLine(34, "workspace"), "sent to 34 requesters and shown in Get help");
    assert.equal(inc$.sentLine(1, "off"), "sent to 1 requester");
    assert.equal(inc$.listTicketNumbers([1052, 1051, 1049]), "#1052, #1051 and #1049");
  });

  test("the catalog event is urgent (email and bell, never a digest) and has its template", () => {
    const ev = policy.notifyEvent("hd_incident_update");
    assert.ok(ev);
    assert.equal(ev.digest, false);
    assert.deepEqual(ev.channels, { bell: true, email: true });
    assert.ok(templates.templateDef("hd_incident_update"));
    assert.ok((policy.HD_REQUESTER_EVENTS as readonly string[]).includes("hd_incident_update"));
  });

  test("roles: Agent links, Team lead runs; a role customised in 1.19.1 gets them only if it can change status (and reply)", () => {
    const m = shared.HD_DEFAULT_MATRIX;
    assert.ok(m.agent.includes("incidents.link") && !m.agent.includes("incidents.manage"));
    assert.ok(m.team_lead.includes("incidents.manage") && m.manager.includes("incidents.manage") && m.admin.includes("incidents.manage"));
    assert.ok(!m.newbie.includes("incidents.link"));
    const agentV2 = m.agent.filter((c) => !c.startsWith("incidents."));
    const lifted = shared.resolveMatrix({ v: 2, agent: agentV2, team_lead: m.team_lead.filter((c) => c !== "tickets.reply_public" && !c.startsWith("incidents.")) });
    assert.ok(lifted.agent.includes("incidents.link"));
    assert.ok(lifted.team_lead.includes("incidents.link") && !lifted.team_lead.includes("incidents.manage"), "no Reply publicly, no Run incidents");
  });
});

// --- Declare ------------------------------------------------------------------------

describe("declare", () => {
  test("opens the incident's ticket, links the chosen tickets, tells their requesters once each", async () => {
    const a = await ticket({ requester: P.req1 });
    const b = await ticket({ requester: P.req2 });
    const c = await ticket({ requester: P.req1 }); // the same person twice
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, name) VALUES ($1, $2, 'Carla Copied')", [b.id, P.cc.id]);
    mail.length = 0;
    told.length = 0;
    const r = await declareRoute(P.lead, { numbers: [a.number, b.number, c.number], match_text: `${STAMP}-zzz`, priority: "urgent" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const parent = await rowByNumber(r.body.number);
    assert.equal(parent.team_id, T1);
    assert.equal(parent.priority, "urgent");
    assert.equal(parent.status, "open");
    assert.equal(parent.requester_id, null, "nobody's request");
    assert.equal(parent.assignee_id, P.lead.id, "the declarer, who is in the team");
    const inc = (await pool().query("SELECT * FROM hd_incidents WHERE ticket_id = $1", [parent.id])).rows[0];
    assert.equal(inc.title, `${STAMP} VPN is down`);
    assert.equal(inc.banner, "workspace");
    const links = (await pool().query("SELECT ticket_id, via FROM hd_incident_links WHERE incident_id = $1 ORDER BY ticket_id", [inc.id])).rows;
    assert.deepEqual(links.map((l) => l.ticket_id), [a.id, b.id, c.id]);
    assert.ok(links.every((l) => l.via === "declare"));
    // The route sends the notices after answering: wait for them (a busy shared database can take a while).
    for (let i = 0; i < 100 && mail.filter((m) => /Update:/.test(m.subject)).length < 2; i++) await new Promise((res) => setTimeout(res, 100));
    for (const t of [a, b, c]) {
      const ms = await messages(t.id);
      assert.ok(ms.some((m) => m.kind === "internal" && m.body.includes(`linked this ticket to major incident #${parent.number}`)));
      assert.ok(ms.some((m) => m.kind === "public" && m.body === inc$.linkedNote(inc.title) && m.author_id === P.lead.id), "the requester reads it");
      assert.ok((await row(t.id)).first_replied_at, "an answer: the first reply clock stops");
    }
    // Tom (two tickets) once, Priya once, Carla (CC on Priya's) on Priya's mail's Cc.
    const toTom = mail.filter((m) => m.to === P.req1.email && /Update:/.test(m.subject));
    assert.equal(toTom.length, 1, JSON.stringify(mail.map((m) => [m.to, m.subject])));
    const toPriya = mail.filter((m) => m.to === P.req2.email);
    assert.equal(toPriya.length, 1);
    assert.match(toPriya[0].cc ?? "", new RegExp(P.cc.email));
    assert.match(toPriya[0].text, /We know about this problem/);
    assert.equal(told.filter((x) => x.userId === P.req1.id).length, 1);
    const aud = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.incident.declared' AND actor_id = $1", [P.lead.id])).rows;
    assert.ok(aud.some((x) => x.details.incident === parent.number));
  });

  test("refused: an Agent or a newbie can't run one; each ticket is checked (another team, a workflow task, already linked)", async () => {
    assert.equal((await declareRoute(P.agent, {})).status, 403);
    // Even with Run incidents granted, a role whose replies are reviewed can't post to everyone.
    roles.setRoleMatrixForTests({ ...shared.HD_DEFAULT_MATRIX, newbie: [...shared.HD_DEFAULT_MATRIX.newbie, "incidents.manage"] });
    try {
      const r = await declare(P.newbie, {});
      assert.equal(r.status, 403);
      assert.match(r.body.error, /reviewed/);
    } finally {
      roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
    }
    const hr = await ticket({ team: T2, requester: P.req3 });
    const parentTask = await ticket();
    const task = await ticket({ source: "workflow", parent: parentTask.id });
    const ok = await ticket();
    const r = await declare(P.lead, { numbers: [hr.number, task.number, ok.number] });
    assert.equal(r.status, 409, "mixed refusals");
    assert.deepEqual(
      r.body.refusals.map((x: { number: number }) => x.number),
      [hr.number, task.number]
    );
    assert.match(r.body.refusals[0].reason, /wasn't found in your queues/);
    assert.match(r.body.refusals[1].reason, /task in a workflow/);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_incident_links WHERE ticket_id = $1", [ok.id])).rows[0].n, 0, "all or nothing");
    const first = await declare(P.lead, { numbers: [ok.number], notify_on_link: false });
    assert.equal(first.status, 201);
    const again = await declare(P.lead, { numbers: [ok.number] });
    assert.equal(again.status, 409);
    assert.match(again.body.error, new RegExp(`already linked to major incident #${first.body.number}`));
    const self = await declare(P.lead, { numbers: [first.body.number] });
    assert.match(self.body.error, /is a major incident itself/);
  });
});

// --- Link, unlink and the rule -------------------------------------------------------

describe("links", () => {
  test("Link tickets checks each one; unlink is checked on the ticket's own team", async () => {
    const d = await declare(P.lead, { notify_on_link: false });
    const mineT = await ticket();
    const hrT = await ticket({ team: T2, requester: P.req3 });
    const r = await link(P.agent, d.body.number, [mineT.number, hrT.number]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.linked, [mineT.number]);
    assert.equal(r.body.results[1].ok, false);
    assert.match(r.body.results[1].error, /wasn't found/);
    // HR's agent links their own ticket to IT's incident.
    const r2 = await link(P.other, d.body.number, [hrT.number]);
    assert.deepEqual(r2.body.linked, [hrT.number]);
    // The repeat is fine and changes nothing.
    assert.deepEqual((await link(P.other, d.body.number, [hrT.number])).body.results, [{ number: hrT.number, ok: true }]);
    // IT's agent can't unlink HR's ticket; HR's agent can.
    assert.equal((await call(ticketRoute.DELETE, req(`/incidents/ticket/${hrT.number}`, P.agent.session, undefined, "DELETE"), { number: String(hrT.number) })).status, 404);
    const un = await call(ticketRoute.DELETE, req(`/incidents/ticket/${hrT.number}`, P.other.session, undefined, "DELETE"), { number: String(hrT.number) });
    assert.equal(un.status, 200);
    assert.equal(un.body.incident, d.body.number);
    assert.ok((await messages((await rowByNumber(d.body.number)).id)).some((m) => m.body.includes(`unlinked #${hrT.number}`)));
    // A newbie may not link at all.
    assert.equal((await link(P.newbie, d.body.number, [mineT.number])).status, 403);
  });

  test("the pane reads the incident on its ticket and the link on a linked one; queue rows carry the chip", async () => {
    const t = await ticket({ requester: P.req2 });
    const d = await declare(P.lead, { numbers: [t.number], notify_on_link: false });
    const own = await call(ticketRoute.GET, req(`/incidents/ticket/${d.body.number}`, P.agent.session), { number: String(d.body.number) });
    assert.equal(own.body.role, "incident");
    assert.equal(own.body.incident.linked_total, 1);
    assert.equal(own.body.incident.can_manage, false, "an Agent links but doesn't run it");
    assert.equal(own.body.incident.can_link, true);
    const lead = await call(ticketRoute.GET, req(`/incidents/ticket/${d.body.number}`, P.lead.session), { number: String(d.body.number) });
    assert.equal(lead.body.incident.can_manage, true);
    assert.deepEqual(lead.body.incident.status_page.services.find((s: { id: number }) => s.id === serviceId)?.id, serviceId);
    assert.equal(lead.body.incident.status_page.can_manage, true);
    const child = await call(ticketRoute.GET, req(`/incidents/ticket/${t.number}`, P.agent.session), { number: String(t.number) });
    assert.equal(child.body.role, "linked");
    assert.equal(child.body.link.incident.number, d.body.number);
    const list = await tickets.listTickets({ id: P.agent.id, role: "viewer" }, { view: "all", team_id: T1, limit: 100 });
    const parentRow = list.rows.find((x) => x.number === d.body.number);
    assert.deepEqual(parentRow?.incident, { kind: "incident", linked: 1 });
    assert.deepEqual(list.rows.find((x) => x.number === t.number)?.incident, { kind: "linked", number: d.body.number });
    // The nav lists it for IT's agents, not HR's; the picker lists it for anyone who may link.
    const nav = await call(listRoute.GET, req("/incidents", P.agent.session));
    assert.ok(nav.body.incidents.some((i: { number: number }) => i.number === d.body.number));
    const navHr = await call(listRoute.GET, req("/incidents", P.other.session));
    assert.ok(!navHr.body.incidents.some((i: { number: number }) => i.number === d.body.number));
    const pick = await call(listRoute.GET, req("/incidents?scope=link", P.other.session));
    assert.ok(pick.body.incidents.some((i: { number: number; can_open: boolean }) => i.number === d.body.number && !i.can_open));
  });

  test("the rule links matching new tickets of the incident's own team while it is open, with a notice that isn't a reply", async () => {
    const word = `zq${Date.now().toString(36)}`;
    const d = await declare(P.lead, { match_text: word });
    mail.length = 0;
    const req3 = { id: P.req3.id, name: P.req3.name, email: P.req3.email };
    const hit = await tickets.createTicket({ subject: `${STAMP} my ${word} is broken`, body: "help", requester: req3, team_id: T1, source: "portal" }, {});
    const miss = await tickets.createTicket({ subject: `${STAMP} open${word} glitch`, body: "x", requester: req3, team_id: T1, source: "portal" }, {});
    // Review W1 #0/#9: another team's ticket never joins (IT's lead doesn't work HR).
    const otherTeam = await tickets.createTicket({ subject: `${STAMP} HR ${word} contract`, body: "x", requester: req3, team_id: T2, source: "portal" }, {});
    const inBody = await tickets.createTicket(
      { subject: `${STAMP} can't log in`, body: `the ${word.toUpperCase()} says no`, requester: { id: P.req2.id, name: P.req2.name, email: P.req2.email }, team_id: T1, source: "portal" },
      {}
    );
    const linkOf = async (id: number) => (await pool().query("SELECT via FROM hd_incident_links WHERE ticket_id = $1", [id])).rows[0];
    assert.equal((await linkOf(hit.id))?.via, "rule");
    assert.equal(await linkOf(miss.id), undefined);
    assert.equal(await linkOf(otherTeam.id), undefined, "the incident's team can't work HR's ticket, so the rule leaves it");
    assert.equal((await linkOf(inBody.id))?.via, "rule");
    // Review W1 #5: the rule's notice is a system line, not a reply: no first reply, still New.
    const ms = await messages(hit.id);
    assert.ok(ms.some((m) => m.kind === "system" && m.body.startsWith("We know about this problem")));
    assert.ok(!ms.some((m) => m.kind === "public" && m.body.startsWith("We know about this problem")));
    const h = await row(hit.id);
    assert.equal(h.first_replied_at, null);
    assert.equal(h.status, "new");
    for (let i = 0; i < 50 && !mail.some((m) => m.to === P.req3.email && /Update:/.test(m.subject)); i++) await new Promise((res) => setTimeout(res, 100));
    assert.ok(mail.some((m) => m.to === P.req3.email && /Update:/.test(m.subject)), "the requester is still told");
    // Solved: the rule stops.
    await tickets.updateTicket((await rowByNumber(d.body.number)).id, { status: "solved" }, { id: P.lead.id, name: P.lead.name });
    const late = await tickets.createTicket({ subject: `${STAMP} ${word} again`, body: "x", requester: req3, team_id: T1, source: "portal" }, {});
    assert.equal(await linkOf(late.id), undefined);
  });

  test("the rule may link another team's ticket when the declarer works it and may link there", async () => {
    const word = `zr${Date.now().toString(36)}`;
    await member(T2, P.lead.id);
    try {
      await declare(P.lead, { match_text: word, notify_on_link: false });
      const t = await tickets.createTicket({ subject: `${STAMP} ${word} in HR`, body: "x", requester: { id: P.req3.id, name: P.req3.name, email: P.req3.email }, team_id: T2, source: "portal" }, {});
      assert.equal((await pool().query("SELECT via FROM hd_incident_links WHERE ticket_id = $1", [t.id])).rows[0]?.via, "rule");
    } finally {
      await pool().query("DELETE FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [T2, P.lead.id]);
    }
  });
});

// --- Updates and solving -----------------------------------------------------------

describe("updates", () => {
  test("an update is a public message on each open linked ticket and one notice per person; Me too people hear too", async () => {
    const a = await ticket({ requester: P.req1 });
    const b = await ticket({ requester: P.req1 });
    const c = await ticket({ requester: P.req2 });
    const done = await ticket({ requester: P.req3 });
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, name) VALUES ($1, $2, 'Carla Copied')", [c.id, P.cc.id]);
    const d = await declare(P.lead, { numbers: [a.number, b.number, c.number, done.number], notify_on_link: false });
    await tickets.updateTicket(done.id, { status: "solved" }, { id: P.agent.id, name: P.agent.name });
    const banner = mine(await banners(P.bystander)).find((x) => x.title === `${STAMP} VPN is down`);
    assert.ok(banner, "workspace banner shown to anyone who may use Get help");
    assert.equal((await call(meTooRoute.POST, req(`/incidents/banners/${d.body.id}`, P.bystander.session, { affected: true }), { id: String(d.body.id) })).status, 200);
    mail.length = 0;
    told.length = 0;
    const body = `${STAMP} We've found the cause: an expired certificate.`;
    const r = await post(P.lead, d.body.number, { body });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.update.sent_count, 3, "the solved one is left alone");
    // The route sends the notices after answering; Bea (Me too) is told last.
    for (let i = 0; i < 100 && !mail.some((m) => m.to === P.bystander.email); i++) await new Promise((res) => setTimeout(res, 100));
    for (const t of [a, b, c]) assert.ok((await messages(t.id)).some((m) => m.kind === "public" && m.body === body && m.author_id === P.lead.id));
    assert.ok(!(await messages(done.id)).some((m) => m.body === body));
    assert.equal(mail.filter((m) => m.to === P.req1.email).length, 1, "Tom has two linked tickets and hears once");
    assert.equal(mail.filter((m) => m.to === P.req2.email).length, 1);
    assert.match(mail.find((m) => m.to === P.req2.email)!.cc ?? "", new RegExp(P.cc.email));
    const by = mail.find((m) => m.to === P.bystander.email);
    assert.ok(by, "Me too people hear");
    assert.match(by!.text, /See it in Get help/);
    assert.ok(!mail.some((m) => m.to === P.lead.email), "never the poster");
    const bells = (await pool().query("SELECT user_id, title FROM notifications WHERE user_id = ANY($1) AND title LIKE 'Update:%'", [[P.req1.id, P.bystander.id]])).rows;
    assert.ok(bells.some((x) => x.user_id === P.req1.id) && bells.some((x) => x.user_id === P.bystander.id), "and the bell");
    // The banner now reads the update.
    const after = mine(await banners(P.req1)).find((x) => x.id === d.body.id)!;
    assert.equal(after.message, body);
    assert.equal(after.affected, 4, "Tom, Priya, Daniel (his ticket was solved, but he was affected) and Bea");
    assert.equal(after.me_too, false);
    assert.ok(!("number" in after), "no ticket numbers in Get help");
    const lines = await messages((await rowByNumber(d.body.number)).id);
    assert.ok(lines.some((m) => m.kind === "internal" && m.body.endsWith("posted an update to 3 linked tickets")));
  });

  test("only someone who runs incidents in the team may post; a solved incident takes no updates", async () => {
    const d = await declare(P.lead, {});
    assert.equal((await post(P.agent, d.body.number, { body: "x" })).status, 403);
    assert.equal((await post(P.other, d.body.number, { body: "x" })).status, 404, "another team's agent doesn't see it");
    assert.equal((await post(P.lead, d.body.number, { body: "" })).status, 400);
    const s = await post(P.lead, d.body.number, { body: "", solve: true });
    assert.equal(s.status, 200);
    assert.equal(s.body.update, null);
    assert.equal(s.body.solve.incident.ok, true);
    assert.equal((await post(P.lead, d.body.number, { body: "late" })).status, 409);
  });

  test("solve goes through the normal path per ticket: solved and surveyed, other teams' left open with the reason", async () => {
    const a = await ticket({ requester: P.req1 });
    const hrT = await ticket({ team: T2, requester: P.req3 });
    const d = await declare(P.lead, { numbers: [a.number], notify_on_link: false });
    assert.deepEqual((await link(P.other, d.body.number, [hrT.number])).body.linked, [hrT.number]);
    const r = await post(P.lead, d.body.number, { body: "Fixed: the VPN is back.", solve: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.solve.results.find((x: { number: number }) => x.number === a.number), { number: a.number, ok: true });
    const left = r.body.solve.results.find((x: { number: number }) => x.number === hrT.number);
    assert.equal(left.ok, false);
    assert.match(left.error, /Not in your queues/);
    assert.equal((await row(a.id)).status, "solved");
    assert.ok((await row(a.id)).solved_at);
    // Review W1 #10: the lead doesn't work HR's ticket, so the update skips it (with the reason) rather than replying there.
    assert.equal((await row(hrT.id)).status, "new", "neither updated nor solved");
    assert.ok(!(await messages(hrT.id)).some((m) => m.body === "Fixed: the VPN is back."));
    assert.deepEqual(r.body.skipped.map((x: { number: number }) => x.number), [hrT.number]);
    assert.match(r.body.skipped[0].error, /Not in your queues/);
    const parent = await rowByNumber(d.body.number);
    assert.equal(parent.status, "solved");
    assert.ok((await pool().query("SELECT solved_at FROM hd_incidents WHERE ticket_id = $1", [parent.id])).rows[0].solved_at);
    assert.ok((await messages(a.id)).some((m) => m.kind === "system" && m.body.includes("to Solved")), "the timeline says it, as any solve does");
    assert.ok(!mine(await banners(P.req1)).some((b) => b.id === d.body.id), "the banner goes");
    const aud = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.incident.solved' AND actor_id = $1", [P.lead.id])).rows;
    assert.ok(aud.some((x) => x.details.incident === d.body.number && x.details.left_open.length === 1));
  });
});

// --- Get help banner -----------------------------------------------------------------

describe("Get help banner", () => {
  test("the audience setting: everyone, the team's requesters (and the people on its tickets), or off; Me too only where shown", async () => {
    const d = await declare(P.lead, { banner: "team", title: `${STAMP} Payroll portal down` });
    const set = (banner: string) => call(settingsRoute.PATCH, req(`/incidents/${d.body.number}`, P.lead.session, { banner }, "PATCH"), { number: String(d.body.number) });
    const shown = async (p: Person) => mine(await banners(p)).some((b) => b.id === d.body.id);
    // Bea has never raised a request with IT; Tom has.
    assert.equal(await shown(P.bystander), false);
    assert.equal(await shown(P.req1), true);
    assert.equal((await call(meTooRoute.POST, req(`/incidents/banners/${d.body.id}`, P.bystander.session, { affected: true }), { id: String(d.body.id) })).status, 404);
    assert.equal((await set("workspace")).status, 200);
    assert.equal(await shown(P.bystander), true);
    const me = await call(meTooRoute.POST, req(`/incidents/banners/${d.body.id}`, P.bystander.session, { affected: true }), { id: String(d.body.id) });
    assert.equal(me.body.banner.me_too, true);
    assert.equal(me.body.banner.affected, 1);
    const again = await call(meTooRoute.POST, req(`/incidents/banners/${d.body.id}`, P.bystander.session, { affected: true }), { id: String(d.body.id) });
    assert.equal(again.body.banner.affected, 1, "a person counts once, however often they click");
    // Off: hidden even for the person who said Me too.
    assert.equal((await set("off")).status, 200);
    assert.equal(await shown(P.bystander), false);
    // Taking it back still works while hidden (review W1 #12).
    const back = await call(meTooRoute.POST, req(`/incidents/banners/${d.body.id}`, P.bystander.session, { affected: false }), { id: String(d.body.id) });
    assert.equal(back.status, 200);
    // Saying it again while hidden doesn't.
    assert.equal((await call(meTooRoute.POST, req(`/incidents/banners/${d.body.id}`, P.bystander.session, { affected: true }), { id: String(d.body.id) })).status, 404);
    // Only someone who runs it changes it.
    assert.equal((await call(settingsRoute.PATCH, req(`/incidents/${d.body.number}`, P.agent.session, { banner: "workspace" }, "PATCH"), { number: String(d.body.number) })).status, 403);
    const aud = (await pool().query("SELECT action FROM audit_log WHERE actor_id = $1 AND action LIKE 'helpdesk.incident.affected%'", [P.bystander.id])).rows;
    assert.ok(aud.length >= 1);
  });
});

// --- Status page ---------------------------------------------------------------------

describe("Status page", () => {
  test("mirrors the incident onto an internal Status page service: opened, updated, resolved", async () => {
    const d = await declare(P.lead, { title: `${STAMP} Mail is slow` });
    const r = await call(settingsRoute.PATCH, req(`/incidents/${d.body.number}`, P.lead.session, { status_service_id: serviceId }, "PATCH"), { number: String(d.body.number) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const inc = (await pool().query("SELECT status_incident_id FROM hd_incidents WHERE id = $1", [d.body.id])).rows[0];
    assert.ok(inc.status_incident_id);
    assert.equal((await pool().query("SELECT status FROM status_services WHERE id = $1", [serviceId])).rows[0].status, "outage");
    await post(P.lead, d.body.number, { body: "Queues are draining." });
    const ups = (await pool().query("SELECT body FROM status_incident_updates WHERE incident_id = $1 ORDER BY id", [inc.status_incident_id])).rows.map((x) => x.body);
    assert.ok(ups.includes("Queues are draining."));
    await post(P.lead, d.body.number, { body: "", solve: true });
    assert.equal((await pool().query("SELECT state FROM status_incidents WHERE id = $1", [inc.status_incident_id])).rows[0].state, "resolved");
    assert.equal((await pool().query("SELECT status FROM status_services WHERE id = $1", [serviceId])).rows[0].status, "operational");
  });

  test("needs the Status page's own permission, and only its internal services", async () => {
    const d = await declare(P.lead, {});
    roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
    const other = (await fixtureQuery("INSERT INTO status_services (name, provider, source_url) VALUES ($1, 'statuspage', 'https://status.example.test') RETURNING id", [`${STAMP} polled`])).rows[0].id;
    try {
      const r = await call(settingsRoute.PATCH, req(`/incidents/${d.body.number}`, P.lead.session, { status_service_id: other }, "PATCH"), { number: String(d.body.number) });
      assert.equal(r.status, 400);
    } finally {
      await pool().query("DELETE FROM status_services WHERE id = $1", [other]);
    }
  });
});

// --- Review W1 fixes -------------------------------------------------------------------

describe("review fixes", () => {
  const matrixWithout = (role: HdRole, drop: string[], add: string[] = []) => {
    const m = { ...shared.HD_DEFAULT_MATRIX };
    m[role] = [...m[role].filter((c) => !drop.includes(c)), ...(add as typeof m[HdRole])];
    roles.setRoleMatrixForTests(m);
  };
  const waitMail = async (pred: (m: (typeof mail)[number]) => boolean) => {
    for (let i = 0; i < 80 && !mail.some(pred); i++) await new Promise((res) => setTimeout(res, 100));
  };
  const status = async (id: number) => (await pool().query("SELECT state FROM status_incidents WHERE id = $1", [id])).rows[0]?.state;
  const serviceStatus = async () => (await pool().query("SELECT status FROM status_services WHERE id = $1", [serviceId])).rows[0].status;
  const boardId = async (incidentId: number) => (await pool().query("SELECT status_incident_id FROM hd_incidents WHERE id = $1", [incidentId])).rows[0].status_incident_id as number | null;
  const mirror = (by: Person, n: number, id: number | null) =>
    call(settingsRoute.PATCH, req(`/incidents/${n}`, by.session, { status_service_id: id }, "PATCH"), { number: String(n) });

  test("#3: running an incident needs Reply to the requester in its team", async () => {
    matrixWithout("team_lead", ["tickets.reply_public"]);
    try {
      const r = await declareRoute(P.lead, {});
      assert.equal(r.status, 403);
      assert.match(r.body.error, /can't reply to requesters/);
    } finally {
      roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
    }
  });

  test("#2/#13: one email per person per update, by account and by address, outside CCs included", async () => {
    ccs.setOutsideSendersForTests(true);
    try {
      const olga = `${STAMP}-olga@outside.test`;
      const a = await ticket({ requester: P.req1 });
      const b = await ticket({ requester: P.req2 });
      // Tom again, by address only (an email he sent before his account matched).
      const c = await dbCore.withTx((cl) => tickets.insertTicketTx(cl, { subject: `${STAMP} by mail`, body: "x", requester: { id: null, name: "Tom", email: P.req1.email.toUpperCase() }, team_id: T1 }));
      for (const t of [a, b]) await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, email, name) VALUES ($1, $2, 'Outside Olga')", [t.id, olga]);
      // Bea is an outside CC by her address and said Me too.
      await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, email, name) VALUES ($1, $2, 'Bea')", [b.id, P.bystander.email]);
      const d = await declare(P.lead, { numbers: [a.number, b.number, c.number], notify_on_link: false });
      await incidents.setAffected({ id: P.bystander.id, role: "viewer" }, d.body.id, true);
      mail.length = 0;
      const r = await postLib(P.lead, d.body.number, { body: `${STAMP} dedupe` });
      assert.equal(r.status, 200);
      assert.equal(r.body.update.sent_count, 3);
      await waitMail((m) => m.to === P.req2.email);
      await new Promise((res) => setTimeout(res, 800));
      const copies = (addr: string) => mail.filter((m) => m.to.toLowerCase() === addr.toLowerCase() || (m.cc ?? "").toLowerCase().split(/,\s*/).includes(addr.toLowerCase())).length;
      assert.equal(copies(P.req1.email), 1, "Tom: account on one ticket, address on another");
      assert.equal(copies(olga), 1, "an outside CC on two tickets");
      assert.equal(copies(P.bystander.email), 1, "an outside CC who also said Me too");
    } finally {
      ccs.setOutsideSendersForTests(null);
    }
  });

  test("#6: posting an update doesn't make the poster follow the linked tickets", async () => {
    const a = await ticket({ requester: P.req2 });
    const d = await declare(P.lead, { numbers: [a.number], notify_on_link: false });
    assert.equal((await postLib(P.lead, d.body.number, { body: "x" })).status, 200);
    await new Promise((res) => setTimeout(res, 300));
    const f = await pool().query("SELECT 1 FROM hd_ticket_followers WHERE ticket_id = $1 AND user_id = $2", [a.id, P.lead.id]);
    assert.equal(f.rowCount, 0);
  });

  test("#4: Solve all checks the incident's own ticket first; refused there, nothing is posted or solved", async () => {
    const a = await ticket({ requester: P.req2 });
    const d = await declare(P.lead, { numbers: [a.number], notify_on_link: false });
    matrixWithout("team_lead", ["tickets.change_status"]);
    try {
      const r = await postLib(P.lead, d.body.number, { body: "All fixed.", solve: true });
      assert.equal(r.status, 409);
      assert.match(r.body.error, /can't be solved: You can't change the status/);
    } finally {
      roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
    }
    assert.notEqual((await row(a.id)).status, "solved");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_incident_updates WHERE incident_id = $1", [d.body.id])).rows[0].n, 0);
  });

  test("#7: a ticket linked while Solve all runs is solved too", async () => {
    const a = await ticket({ requester: P.req2 });
    const late = await ticket({ requester: P.req3 });
    const d = await declare(P.lead, { numbers: [a.number], notify_on_link: false });
    let once = false;
    incidents.setIncidentSolvePassHookForTests(async () => {
      if (once) return;
      once = true;
      await incidents.linkTickets({ id: P.agent.id, role: "viewer", name: P.agent.name, username: P.agent.name }, d.body.number, [late.number]);
    });
    try {
      const r = await postLib(P.lead, d.body.number, { body: "", solve: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.solve.results.some((x: { number: number; ok: boolean }) => x.number === late.number && x.ok));
      assert.equal((await row(late.id)).status, "solved");
    } finally {
      incidents.setIncidentSolvePassHookForTests(null);
    }
  });

  test("#11: the link picker and linking reach only incidents the agent works or Get help shows to everyone", async () => {
    const hrT = await ticket({ team: T2, requester: P.req3 });
    const d = await declare(P.lead, { banner: "team", notify_on_link: false });
    const pick = await call(listRoute.GET, req("/incidents?scope=link", P.other.session));
    assert.ok(!pick.body.incidents.some((i: { number: number }) => i.number === d.body.number), "a team-only incident isn't listed to HR");
    assert.equal((await link(P.other, d.body.number, [hrT.number])).status, 404);
    await call(settingsRoute.PATCH, req(`/incidents/${d.body.number}`, P.lead.session, { banner: "workspace" }, "PATCH"), { number: String(d.body.number) });
    assert.ok((await call(listRoute.GET, req("/incidents?scope=link", P.other.session))).body.incidents.some((i: { number: number }) => i.number === d.body.number));
    assert.deepEqual((await link(P.other, d.body.number, [hrT.number])).body.linked, [hrT.number]);
  });

  test("#12: Me too people hear only while the banner shows; taking it back always works", async () => {
    const d = await declare(P.lead, { title: `${STAMP} Wifi down` });
    assert.equal((await call(meTooRoute.POST, req(`/incidents/banners/${d.body.id}`, P.bystander.session, { affected: true }), { id: String(d.body.id) })).status, 200);
    await call(settingsRoute.PATCH, req(`/incidents/${d.body.number}`, P.lead.session, { banner: "off" }, "PATCH"), { number: String(d.body.number) });
    mail.length = 0;
    told.length = 0;
    await postLib(P.lead, d.body.number, { body: "Still on it." });
    await new Promise((res) => setTimeout(res, 800));
    assert.ok(!mail.some((m) => m.to === P.bystander.email), "banner off: no Me too notices");
    assert.ok(!told.some((x) => x.userId === P.bystander.id));
    const back = await call(meTooRoute.POST, req(`/incidents/banners/${d.body.id}`, P.bystander.session, { affected: false }), { id: String(d.body.id) });
    assert.equal(back.status, 200);
    assert.equal(back.body.banner.me_too, false);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_incident_affected WHERE incident_id = $1", [d.body.id])).rows[0].n, 0);
  });

  test("#1/#16: the Status page incident is resolved however the incident ends, reopened with it, and when mirroring stops", async () => {
    // Solved from the status menu (not Solve all).
    const d = await declare(P.lead, { title: `${STAMP} Mirror 1` });
    assert.equal((await mirror(P.lead, d.body.number, serviceId)).status, 200);
    const first = (await boardId(d.body.id))!;
    assert.equal(await status(first), "open");
    const pid = (await rowByNumber(d.body.number)).id;
    await tickets.updateTicket(pid, { status: "solved" }, { id: P.lead.id, name: P.lead.name });
    assert.equal(await status(first), "resolved");
    assert.equal(await serviceStatus(), "operational");
    assert.ok((await pool().query("SELECT solved_at FROM hd_incidents WHERE id = $1", [d.body.id])).rows[0].solved_at);
    // Reopened: a new board incident, the service down again.
    await tickets.updateTicket(pid, { status: "open" }, { id: P.lead.id, name: P.lead.name });
    const second = (await boardId(d.body.id))!;
    assert.ok(second && second !== first);
    assert.equal(await status(second), "open");
    assert.equal(await serviceStatus(), "outage");
    assert.equal((await pool().query("SELECT solved_at FROM hd_incidents WHERE id = $1", [d.body.id])).rows[0].solved_at, null);
    // Mirroring switched off: resolved there.
    assert.equal((await mirror(P.lead, d.body.number, null)).status, 200);
    assert.equal(await status(second), "resolved");
    assert.equal(await serviceStatus(), "operational");

    // Merged into another ticket.
    const keep = await ticket({ requester: P.req2 });
    const d2 = await declare(P.lead, { title: `${STAMP} Mirror 2` });
    await mirror(P.lead, d2.body.number, serviceId);
    const b2 = (await boardId(d2.body.id))!;
    await mergeLib.mergeTickets({ id: P.lead.id, role: "viewer", name: P.lead.name }, { keep: keep.number, merge: [d2.body.number], notify: false });
    assert.equal(await status(b2), "resolved");

    // Deleted.
    const d3 = await declare(P.lead, { title: `${STAMP} Mirror 3` });
    await mirror(P.lead, d3.body.number, serviceId);
    const b3 = (await boardId(d3.body.id))!;
    matrixWithout("manager", [], ["tickets.delete"]);
    const del = await call(deskTicketRoute.DELETE, req(`/tickets/${d3.body.number}`, P.mgr.session, undefined, "DELETE"), { number: String(d3.body.number) });
    roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(await status(b3), "resolved");
    assert.equal(await serviceStatus(), "operational");
  });

  test("#14/#8/#15: anonymising the incident's ticket clears its updates, title and audit copies; Me too is in the data export", async () => {
    const d = await declareRoute(P.lead, { title: `${STAMP} Payroll for Tom Becker` });
    assert.equal(d.status, 201);
    // Through the route (its audit row), as Mia, who also runs IT's incidents.
    assert.equal((await post(P.mgr, d.body.number, { body: "Tom Becker's payslip is the cause." })).status, 200);
    await call(settingsRoute.PATCH, req(`/incidents/${d.body.number}`, P.lead.session, { title: `${STAMP} Payroll is late` }, "PATCH"), { number: String(d.body.number) });
    await incidents.setAffected({ id: P.bystander.id, role: "viewer" }, d.body.id, true);
    const exp = await retention.personalHelpdeskExport(P.bystander.id);
    if (exp.included) assert.ok(exp.incidents_affected?.some((x) => x.incident === `${STAMP} Payroll is late`), "Me too rows are exported");
    const pid = (await rowByNumber(d.body.number)).id;
    await dbCore.withTx((c) => retention.anonymiseTicketTx(c, pid));
    const inc = (await pool().query("SELECT title, match_text FROM hd_incidents WHERE id = $1", [d.body.id])).rows[0];
    assert.equal(inc.title, "Anonymised request");
    const ups = (await pool().query("SELECT body, author_name FROM hd_incident_updates WHERE incident_id = $1", [d.body.id])).rows;
    assert.ok(ups.length && ups.every((u) => u.body === "" && u.author_name === ""));
    const auds = (await pool().query("SELECT action, details FROM audit_log WHERE target_id = $1 AND action LIKE 'helpdesk.incident.%'", [String(pid)])).rows;
    assert.ok(auds.some((a) => a.action === "helpdesk.incident.update_posted"), "audit rows target the incident's ticket");
    assert.ok(auds.some((a) => a.action === "helpdesk.incident.settings_changed"));
    assert.ok(!JSON.stringify(auds.map((a) => a.details)).includes("Payroll"), "no title left in the audit copies");
    assert.ok(!JSON.stringify(auds.map((a) => a.details)).includes("payslip"));
  });
});
