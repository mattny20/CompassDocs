// Helpdesk 1.19.4 (area C7): the recycle bin for deleted tickets.
//
//   - the capability split: tickets.delete moves to the bin and restores,
//     tickets.purge ("Delete for good") is Admin only; a role customised
//     before 1.19.4 keeps Delete tickets as stored and never gains purge
//   - Delete (the ticket route) bins instead of deleting; bulk is checked
//     per ticket (legal hold and an open major incident stay, with reasons)
//   - a binned ticket is hidden from the queues, views, counts and search,
//     the requester's My requests and CC views, the customer portal, the
//     Claude connector's tools, reports and the analytics engine,
//     approvals, merge, the SLA, auto-close and assignment sweeps, and
//     nothing is sent about it (bells, email); an inbound reply opens a
//     new ticket; the agent who works it gets 410 and a read-only view
//   - restore round trip (SLA clocks shifted by the time binned) and Undo
//   - the purge sweep after 30 days (the database's clock), skipping a
//     legal hold; "Delete for good" needs tickets.purge; the audit keeps
//     "#N subject" after the purge
//
// Route handlers are called directly with real sessions (next/headers and
// lib/ee stubbed, as test/helpdesk-merge-bulk does). Parallel-safe: teams,
// people and tickets are this file's own (STAMP); the role matrix is read
// through the process-local test seam, never the shared setting.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-recycle-bin.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession, getUserById } from "../src/lib/db";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-bin.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-bin.virtual.js");
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
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const bin = require("../src/lib/helpdesk/recycle-bin") as typeof import("../src/lib/helpdesk/recycle-bin");
const binShared = require("../src/lib/helpdesk/recycle-bin-shared") as typeof import("../src/lib/helpdesk/recycle-bin-shared");
const portal = require("../src/lib/helpdesk/portal") as typeof import("../src/lib/helpdesk/portal");
const dbSla = require("../src/lib/helpdesk/db-sla") as typeof import("../src/lib/helpdesk/db-sla");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const retentionShared = require("../src/lib/helpdesk/retention-shared") as typeof import("../src/lib/helpdesk/retention-shared");
const notifyPrefs = require("../src/lib/helpdesk/notify-prefs") as typeof import("../src/lib/helpdesk/notify-prefs");
const analytics = require("../src/lib/helpdesk/analytics/engine") as typeof import("../src/lib/helpdesk/analytics/engine");
const reportHours = require("../src/lib/helpdesk/analytics/hours") as typeof import("../src/lib/helpdesk/analytics/hours");
const reports = require("../src/lib/helpdesk/reports") as typeof import("../src/lib/helpdesk/reports");
const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const periodic = require("../src/lib/periodic") as typeof import("../src/lib/periodic");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const requestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
const requestsRoute = require("../src/app/api/helpdesk/requests/route") as typeof import("../src/app/api/helpdesk/requests/route");
const binRoute = require("../src/app/api/helpdesk/recycle-bin/route") as typeof import("../src/app/api/helpdesk/recycle-bin/route");
const binTicketRoute = require("../src/app/api/helpdesk/recycle-bin/[number]/route") as typeof import("../src/app/api/helpdesk/recycle-bin/[number]/route");
const holdRoute = require("../src/app/api/helpdesk/tickets/[number]/legal-hold/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/legal-hold/route");
const timeRoute = require("../src/app/api/helpdesk/time/[id]/route") as typeof import("../src/app/api/helpdesk/time/[id]/route");
const engine = require("../src/lib/helpdesk/engine") as typeof import("../src/lib/helpdesk/engine");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const detail = require("../src/lib/helpdesk/detail") as typeof import("../src/lib/helpdesk/detail");
const timeLib = require("../src/lib/helpdesk/time") as typeof import("../src/lib/helpdesk/time");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole, HdRoleMatrix } from "../src/lib/helpdesk/roles-shared";

// Secrets are sealed at rest: give secretbox a key so it never needs the
// uploads key file (CI has no writable /uploads), as the push tests do.
process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";


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

const STAMP = `hdbin-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
  email: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
const contactIds: number[] = [];
const typeIds: number[] = [];
const workflowIds: number[] = [];
let T1 = 0;
let T2 = 0;
const mail: { to: string; subject: string }[] = [];

async function person(key: string, name: string): Promise<Person> {
  const addr = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${key}`, name, addr]);
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
async function ticket(opts: { team?: number; requester?: Person; assignee?: number | null; parent?: number; source?: "workflow" } = {}) {
  const who = opts.requester ?? P.req;
  return dbCore.withTx((c) =>
    tickets.insertTicketTx(c, {
      subject: `${STAMP} printer jams ${++seq}`,
      body: `It jams on page two (${seq}).`,
      requester: { id: who.id, name: who.name, email: who.email },
      team_id: opts.team ?? T1,
      assignee_id: opts.assignee ?? null,
      parent_ticket_id: opts.parent ?? null,
      source: opts.source,
    })
  );
}

const row = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const del = (by: Person, n: number) => call(ticketRoute.DELETE, req(`/tickets/${n}`, by.session, undefined, "DELETE"), { number: String(n) });
const getTicket = (by: Person, n: number) => call(ticketRoute.GET, req(`/tickets/${n}`, by.session), { number: String(n) });
const binPost = (by: Person, action: string, numbers: number[]) => call(binRoute.POST, req("/recycle-bin", by.session, { action, numbers }));

/** The default matrix with Manager given Delete tickets (mock-up v4). */
function managerDeletes(): HdRoleMatrix {
  return { ...shared.HD_DEFAULT_MATRIX, manager: [...shared.HD_DEFAULT_MATRIX.manager, "tickets.delete"] };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(managerDeletes());
  for (const [k, n] of [
    ["admin", "Ana Kowalski"],
    ["manager", "Marco Rossi"],
    ["agent", "Sam Lee"],
    ["other", "Oda Otherteam"],
    ["req", "Daniel Okafor"],
    ["cc", "Priya Natarajan"],
  ] as const) {
    await person(k, n);
  }
  T1 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9201) RETURNING id", [`${STAMP} IT`])).rows[0].id;
  T2 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9202) RETURNING id", [`${STAMP} HR`])).rows[0].id;
  await grant(P.admin.id, ["helpdesk.admin", "helpdesk.agent", "helpdesk.request"], "admin");
  await deskRole(P.admin.id, "admin");
  await deskRole(P.manager.id, "manager");
  await deskRole(P.agent.id, "agent");
  await deskRole(P.other.id, "agent");
  for (const k of ["agent", "manager", "admin"]) await member(T1, P[k].id);
  await member(T2, P.other.id);
  for (const k of ["req", "cc"]) await grant(P[k].id, ["helpdesk.request"], k);
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push({ to: m.to, subject: m.subject });
  });
  inbound.resetInboundRateLimitsForTests();
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  email.setHelpdeskTransportForTests(null);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR subject LIKE $3", [[T1, T2], userIds, `%${STAMP}%`])).rows.map((r) => r.id);
  await pool().query("UPDATE hd_tickets SET merged_into = NULL, parent_ticket_id = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_portal_contacts WHERE id = ANY($1)", [contactIds]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1)", [workflowIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[T1, T2]]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- The capability split -----------------------------------------------------------

describe("capabilities", () => {
  test("Delete tickets now means the bin; Delete for good is new and Admin only by default", () => {
    const caps = shared.HD_CAPABILITIES;
    assert.equal(caps["tickets.delete"].label, "Delete tickets");
    assert.match(caps["tickets.delete"].hint, /recycle bin/);
    assert.match(caps["tickets.delete"].hint, /30 days/);
    assert.equal(caps["tickets.purge"].label, "Delete for good");
    const d = shared.HD_DEFAULT_MATRIX;
    assert.ok(d.admin.includes("tickets.delete") && d.admin.includes("tickets.purge"));
    for (const r of ["newbie", "agent", "team_lead", "manager"] as const) {
      assert.ok(!d[r].includes("tickets.purge"), `${r}: no purge`);
      assert.ok(!d[r].includes("tickets.delete"), `${r}: no delete by default`);
    }
    assert.equal(binShared.HD_CAP_BADGES["tickets.delete"], "Changed");
    assert.equal(binShared.HD_CAP_BADGES["tickets.purge"], "New");
  });

  test("a role customised before 1.19.4 keeps Delete tickets as stored and never gains Delete for good", () => {
    // A 1.19.3 matrix (v 3) where an admin had given Manager "Delete tickets" (then a hard delete).
    const stored = { v: 3, manager: [...shared.HD_DEFAULT_MATRIX.manager, "tickets.delete"], agent: shared.HD_DEFAULT_MATRIX.agent };
    const m = shared.resolveMatrix(stored);
    assert.ok(m.manager.includes("tickets.delete"), "kept: now moves to the bin");
    assert.ok(!m.manager.includes("tickets.purge"), "never lifted to Delete for good");
    assert.ok(!m.agent.includes("tickets.purge"));
    assert.ok(m.admin.includes("tickets.purge"), "Admin always has it");
    // Granting it is an ordinary matrix change, and only by someone who holds it.
    const ok = shared.checkMatrix({ manager: [...m.manager, "tickets.purge"] }, m, { role: "admin", caps: m.admin });
    assert.equal(ok.ok, true);
    const no = shared.checkMatrix({ team_lead: [...m.team_lead, "tickets.purge"] }, m, { role: "manager", caps: m.manager });
    assert.equal(no.ok, false);
  });

  test("an agent without tickets.delete gets 403; tickets.purge is needed for Delete for good", async () => {
    const t = await ticket();
    assert.equal((await del(P.agent, t.number)).status, 403);
    assert.equal((await binPost(P.agent, "bin", [t.number])).status, 403);
    assert.equal((await del(P.manager, t.number)).status, 200, "Manager was given Delete tickets");
    assert.equal((await binPost(P.manager, "purge", [t.number])).status, 403, "Manager has no Delete for good");
    const r = await binPost(P.admin, "purge", [t.number]);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, 1);
    assert.equal(await row(t.id), undefined, "deleted for good");
  });
});

// --- Delete moves to the bin ------------------------------------------------------------

describe("delete moves to the bin", () => {
  test("the ticket route bins (columns, a timeline line, an audit row); the agent who works it gets 410 and the read-only view", async () => {
    const t = await ticket();
    const r = await del(P.admin, t.number);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.binned, true);
    const b = await row(t.id);
    assert.ok(b, "still there");
    assert.ok(b.deleted_at);
    assert.equal(b.deleted_by, P.admin.id);
    assert.equal(b.deleted_by_name, "Ana Kowalski");
    assert.equal(b.status, "new", "nothing else changed");
    const line = (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 AND via = 'system' ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
    assert.deepEqual(line, { kind: "internal", body: "Ana Kowalski moved this ticket to the recycle bin." }, "agents only");
    const audit = (await pool().query("SELECT action, target_label FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = $1 ORDER BY id DESC LIMIT 1", [String(t.id)])).rows[0];
    assert.equal(audit.action, "helpdesk.ticket.binned");
    assert.equal(audit.target_label, `#${t.number} ${t.subject}`);

    assert.equal((await getTicket(P.agent, t.number)).status, 410, "an agent of the team: in the bin");
    assert.equal((await getTicket(P.other, t.number)).status, 404, "another team's agent: nothing");
    const view = await call(binTicketRoute.GET, req(`/recycle-bin/${t.number}`, P.agent.session), { number: String(t.number) });
    assert.equal(view.status, 200);
    assert.equal(view.body.detail.can_work, false, "read-only");
    assert.equal(view.body.bin.can_restore, false, "an agent without tickets.delete can't restore");
    assert.equal(view.body.bin.days_left, 30);
    const adminView = await call(binTicketRoute.GET, req(`/recycle-bin/${t.number}`, P.admin.session), { number: String(t.number) });
    assert.equal(adminView.body.bin.can_restore, true);
    assert.equal(adminView.body.bin.can_purge, true);
    // Read-only: a reply, a note and a status change find nothing.
    const reply = await call(messagesRoute.POST, req(`/tickets/${t.number}/messages`, P.admin.session, { kind: "internal", body: "Still here?" }), { number: String(t.number) });
    assert.equal(reply.status, 404);
    const patch = await call(ticketRoute.PATCH, req(`/tickets/${t.number}`, P.admin.session, { status: "solved" }, "PATCH"), { number: String(t.number) });
    assert.equal(patch.status, 404);
    assert.equal((await del(P.admin, t.number)).status, 404, "already in the bin");
  });

  test("bulk: each ticket on its own; legal hold stays with its reason; an open major incident's ticket ends the incident first", async () => {
    const a = await ticket();
    const b = await ticket();
    const held = await ticket();
    const incident = await ticket();
    const elsewhere = await ticket({ team: T2 }); // Manager works every team
    await pool().query("UPDATE hd_tickets SET legal_hold = 1, legal_hold_at = now() WHERE id = $1", [held.id]);
    await pool().query("INSERT INTO hd_incidents (ticket_id, title) VALUES ($1, $2)", [incident.id, `${STAMP} outage`]);
    const numbers = [a.number, b.number, held.number, incident.number, elsewhere.number, 999_999_999];

    const preview = await binPost(P.manager, "preview", numbers);
    assert.equal(preview.status, 200);
    const chips = Object.fromEntries(preview.body.results.map((r: { number: number; ok: boolean; chip?: string }) => [r.number, r.ok ? "ok" : r.chip ?? "no"]));
    assert.deepEqual(chips, { [a.number]: "ok", [b.number]: "ok", [held.number]: "Legal hold, stays", [incident.number]: "ok", [elsewhere.number]: "ok", [999_999_999]: "no" });
    assert.ok(!(await row(a.id)).deleted_at, "a preview changes nothing");

    const r = await binPost(P.manager, "bin", numbers);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, 4);
    assert.equal(r.body.skipped, 2);
    const res = new Map(r.body.results.map((x: { number: number }) => [x.number, x]));
    assert.match((res.get(held.number) as { error: string }).error, /legal hold/i);
    assert.match((res.get(999_999_999) as { error: string }).error, /Not found/);
    assert.ok((await row(a.id)).deleted_at && (await row(b.id)).deleted_at && (await row(elsewhere.id)).deleted_at && (await row(incident.id)).deleted_at);
    assert.ok(!(await row(held.id)).deleted_at);
    assert.ok((await pool().query("SELECT solved_at FROM hd_incidents WHERE ticket_id = $1", [incident.id])).rows[0].solved_at, "the incident ended");
    const bulkAudit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.bulk_binned' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [P.manager.id])).rows[0];
    assert.deepEqual(bulkAudit.details.numbers, [a.number, b.number, incident.number, elsewhere.number]);
    assert.equal(bulkAudit.details.skipped, 2);
    await pool().query("DELETE FROM hd_incidents WHERE ticket_id = $1", [incident.id]);
  });

  test("more than 200 at once is refused", async () => {
    const r = await binPost(P.admin, "bin", Array.from({ length: 201 }, (_, i) => i + 1));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /200/);
  });

  test("a workflow request's open task tickets go with it and come back with it; a running timer stops and logs", async () => {
    const parent = await ticket();
    const task = await ticket({ parent: parent.id, source: "workflow" });
    await pool().query("INSERT INTO hd_timers (user_id, ticket_id, started_at) VALUES ($1, $2, now() - interval '10 minutes')", [P.agent.id, task.id]);
    const r = await binPost(P.admin, "bin", [parent.number]);
    assert.equal(r.body.ok, 1);
    const [p, c] = [await row(parent.id), await row(task.id)];
    assert.ok(c.deleted_at, "the task went too");
    assert.equal(String(c.deleted_at), String(p.deleted_at), "at the same instant");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_timers WHERE ticket_id = $1", [task.id])).rows[0].n, 0, "timer stopped");
    const logged = (await pool().query("SELECT minutes, source FROM hd_time_entries WHERE ticket_id = $1 AND user_id = $2", [task.id, P.agent.id])).rows[0];
    assert.equal(logged.source, "timer");
    assert.ok(logged.minutes >= 9 && logged.minutes <= 11, String(logged.minutes));
    assert.equal((await binPost(P.admin, "restore", [parent.number])).body.ok, 1);
    assert.equal((await row(task.id)).deleted_at, null, "restored with it");
  });
});

// --- Hidden everywhere ---------------------------------------------------------------------

describe("a binned ticket is hidden", () => {
  test("queues, views, counts and search", async () => {
    const t = await ticket({ assignee: P.agent.id });
    const me = { id: P.agent.id, role: "viewer" as const };
    const before = await tickets.countViews(me);
    const inQueue = async (f: Parameters<typeof tickets.listTickets>[1]) => (await tickets.listTickets(me, f)).rows.some((r) => r.number === t.number);
    assert.ok(await inQueue({ view: "mine" }));
    await bin.binTickets(await getUserById(P.admin.id).then((u) => u!), [t.number]);
    for (const f of [{ view: "mine" }, { view: "open" }, { view: "all" }, { view: { team_id: T1 } }, { view: "unassigned" }, { q: t.subject }, { q: String(t.number) }] as const) {
      assert.ok(!(await inQueue(f as never)), `hidden from ${JSON.stringify(f)}`);
    }
    const counted = (await tickets.listTickets(me, { view: "all", team_id: T1, countOnly: true })).total;
    assert.equal(counted, (await tickets.listTickets(me, { view: "all", team_id: T1 })).rows.length, "the saved views' counts agree");
    const after = await tickets.countViews(me);
    assert.equal(after.views.mine, before.views.mine - 1, "My open count");
    assert.equal(after.views.open, before.views.open - 1, "All open count");
    assert.equal(after.teams.find((x) => x.team_id === T1)!.open, before.teams.find((x) => x.team_id === T1)!.open - 1, "team count");
    assert.equal(await tickets.getTicketByNumber(t.number), undefined);
    assert.equal(await tickets.getTicketById(t.id), undefined);
    assert.ok(await tickets.getTicketIncludingBinned(t.number));
  });

  test("the requester's My requests, Get help request page and counts; a CC's view", async () => {
    const t = await ticket();
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, $2, $3, $4)", [t.id, P.cc.id, P.cc.email, P.cc.name]);
    await pool().query("UPDATE hd_tickets SET status = 'pending' WHERE id = $1", [t.id]);
    const waiting = await tickets.countWaitingOnRequester(P.req.id);
    assert.ok((await tickets.listMyRequests(P.req.id)).some((r) => r.number === t.number));
    assert.ok((await tickets.listMyRequests(P.cc.id, { includeCopied: true })).some((r) => r.number === t.number));
    assert.equal((await del(P.admin, t.number)).status, 200);
    assert.ok(!(await tickets.listMyRequests(P.req.id)).some((r) => r.number === t.number), "My requests");
    assert.ok(!(await tickets.listMyRequests(P.cc.id, { includeCopied: true })).some((r) => r.number === t.number), "CC view");
    assert.equal(await tickets.countWaitingOnRequester(P.req.id), waiting - 1, "Waiting on you");
    for (const who of [P.req, P.cc]) {
      const r = await call(requestRoute.GET, req(`/requests/${t.number}`, who.session), { number: String(t.number) });
      assert.equal(r.status, 404, `${who.name}: 404`);
    }
    const list = await call(requestsRoute.GET, req("/requests", P.req.session));
    assert.ok(!list.body.requests.some((r: { number: number }) => r.number === t.number));
  });

  test("the customer portal", async () => {
    const c = (await pool().query("INSERT INTO hd_portal_contacts (email, name) VALUES ($1, 'Out Side') RETURNING id", [`${STAMP}-portal@outside.test`])).rows[0].id as number;
    contactIds.push(c);
    const t = await ticket();
    await pool().query("UPDATE hd_tickets SET requester_id = NULL, requester_email = $2, source = 'portal_external', portal_contact_id = $3 WHERE id = $1", [t.id, `${STAMP}-portal@outside.test`, c]);
    assert.ok(await portal.contactTicket(c, t.number));
    assert.ok((await portal.listContactRequests(c)).some((r) => r.number === t.number));
    await bin.binTickets((await getUserById(P.admin.id))!, [t.number]);
    assert.equal(await portal.contactTicket(c, t.number), undefined, "every portal read and write goes through contactTicket");
    assert.ok(!(await portal.listContactRequests(c)).some((r) => r.number === t.number));
    assert.equal(await portal.contactReaches(c, t.id), false);
  });

  test("the Claude connector: queue, read, my requests and read request", async () => {
    const t = await ticket({ assignee: P.agent.id });
    const ctx = { origin: "http://localhost", ip: null };
    const agent = (await getUserById(P.agent.id))!;
    const requester = (await getUserById(P.req.id))!;
    const text = (r: unknown) => JSON.stringify(r);
    assert.ok(text(await hdTools.callHelpdeskTool(agent, "hd_queue", { view: "all" }, ctx)).includes(t.subject));
    assert.ok(text(await hdTools.callHelpdeskTool(requester, "hd_my_requests", {}, ctx)).includes(t.subject));
    await bin.binTickets((await getUserById(P.admin.id))!, [t.number]);
    assert.ok(!text(await hdTools.callHelpdeskTool(agent, "hd_queue", { view: "all" }, ctx)).includes(t.subject), "hd_queue");
    assert.ok(!text(await hdTools.callHelpdeskTool(agent, "hd_queue", { query: t.subject }, ctx)).includes(String(t.number)), "hd_queue search");
    const read = await hdTools.callHelpdeskTool(agent, "hd_read_ticket", { number: t.number }, ctx);
    assert.ok((read as { isError?: boolean }).isError, "hd_read_ticket refuses");
    assert.ok(!text(read).includes(t.subject));
    assert.ok(!text(await hdTools.callHelpdeskTool(requester, "hd_my_requests", {}, ctx)).includes(t.subject), "hd_my_requests");
    assert.ok((await hdTools.callHelpdeskTool(requester, "hd_read_request", { number: t.number }, ctx) as { isError?: boolean }).isError, "hd_read_request");
  });

  test("reports: the analytics engine, the report summary and its drill-down", async () => {
    const T3 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9203) RETURNING id", [`${STAMP} Reports`])).rows[0].id as number;
    try {
      await member(T3, P.manager.id);
      const keep = await ticket({ team: T3 });
      const gone = await ticket({ team: T3 });
      await bin.binTickets((await getUserById(P.admin.id))!, [gone.number]);
      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      const range = { from: day(-1), to: day(1) };
      const HOURS = { timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", holidays: [] };
      reportHours.setReportHoursForTests(HOURS);
      try {
        const scope = { kind: "all" as const, userId: P.manager.id };
        const run = (measure: string) =>
          analytics.runQuery({ measure, range, filters: { team: [T3] } } as never, { id: P.manager.id, role: "viewer" }, { scope: scope as never, tz: "UTC" });
        assert.equal((await run("created")).total.value, 1, "analytics: only the live ticket");
      } finally {
        reportHours.setReportHoursForTests(null);
      }
      const summary = await reports.reportSummary({ ...range, team_id: T3 }, { hours: HOURS as never });
      assert.equal(summary.created, 1, "report summary");
      const drill = await tickets.listTickets({ id: P.manager.id, role: "viewer" }, { view: "all", team_id: T3, created_from: range.from, created_to: range.to });
      assert.deepEqual(drill.rows.map((r) => r.number), [keep.number], "drill-down");
    } finally {
      const ids = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = $1", [T3])).rows.map((r) => r.id);
      await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ids]);
      await pool().query("DELETE FROM hd_teams WHERE id = $1", [T3]);
    }
  });

  test("merge: a binned ticket is neither a target nor merged", async () => {
    const keep = await ticket();
    const gone = await ticket();
    await bin.binTickets((await getUserById(P.admin.id))!, [gone.number]);
    const admin = (await getUserById(P.admin.id))!;
    await assert.rejects(merge.mergeTickets(admin, { keep: keep.number, merge: [gone.number], notify: false }), (e: unknown) => e instanceof merge.HdMergeError);
    await assert.rejects(merge.mergeTickets(admin, { keep: gone.number, merge: [keep.number], notify: false }), (e: unknown) => e instanceof merge.HdMergeError);
  });

  test("sweeps: SLA breaches and warnings, auto-close; nothing is sent about it", async () => {
    const overdue = await ticket();
    await pool().query("UPDATE hd_tickets SET status = 'open', first_reply_due = now() - interval '1 hour', resolve_due = now() - interval '1 hour' WHERE id = $1", [overdue.id]);
    const solved = await ticket();
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() - interval '30 days' WHERE id = $1", [solved.id]);
    await bin.binTickets((await getUserById(P.admin.id))!, [overdue.number, solved.number]);
    const sla = await dbSla.claimSlaEvents(new Date(), [overdue.id]);
    if (sla.ran) assert.deepEqual(sla.events, [], "no breach while binned");
    assert.equal((await row(overdue.id)).first_reply_breached_at, null);
    const plan = await retention.planRetention({ settings: { ...retentionShared.normalizeRetention(null), auto_close_enabled: true, auto_close_days: 3 }, only: [solved.id], withIds: true });
    assert.equal(plan.counts.close, 0, "auto-close leaves it alone");
    // Notifications: no bell, no email.
    mail.length = 0;
    const out = await notifyPrefs.deliverAgentNotification(P.agent.id, "assigned_to_me", { ticketNumber: overdue.number, title: "Assigned to you", url: `/desk/tickets/${overdue.number}` });
    assert.equal(out.bell, false);
    const sent = await email.sendHelpdeskTemplate(P.req.email, "hd_request_received", { subject: "x" }, { ticketId: overdue.id, number: overdue.number, teamId: T1 });
    assert.equal(sent, false);
    assert.equal(mail.length, 0);
  });

  test("an inbound reply to a binned ticket opens a new ticket and never restores it", async () => {
    const t = await ticket();
    const token = (await email.ensureReplyToken(t.id))!;
    await bin.binTickets((await getUserById(P.admin.id))!, [t.number]);
    const res = await inbound.processInboundEmail(
      {
        provider: "generic",
        from: { email: P.req.email, name: P.req.name },
        to: [{ email: "help@example.test", name: "" }],
        cc: [],
        recipients: [],
        subject: `Re: ${t.subject} [#${t.number} ref:${token}]`,
        text: `${STAMP} still jamming after the restart.`,
        html: "",
        stripped: "",
        messageId: `${newToken()}@mail.example.test`,
        inReplyTo: "",
        references: [],
        headers: {},
        auth: { dmarc: "pass" },
        files: [],
      } as never,
      { outsideSenders: false }
    );
    assert.equal(res.body.outcome, "created", JSON.stringify(res.body));
    assert.notEqual(res.body.ticket, t.number);
    assert.ok((await row(t.id)).deleted_at, "still in the bin");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND body LIKE '%still jamming%'", [t.id])).rows[0].n, 0);
  });
});

// --- Restore and purge -------------------------------------------------------------------

describe("restore and purge", () => {
  test("restore round trip: back in the queue as it was, its running SLA clock shifted by the time binned", async () => {
    const t = await ticket({ assignee: P.agent.id });
    await pool().query("UPDATE hd_tickets SET status = 'open', resolve_due = now() + interval '4 hours', first_reply_due = NULL WHERE id = $1", [t.id]);
    const before = await row(t.id);
    await bin.binTickets((await getUserById(P.admin.id))!, [t.number]);
    // Two hours in the bin (the database's clock).
    await pool().query("UPDATE hd_tickets SET deleted_at = deleted_at - interval '2 hours' WHERE id = $1", [t.id]);
    const list = await call(binRoute.GET, req(`/recycle-bin?q=${encodeURIComponent(t.subject)}`, P.admin.session));
    assert.equal(list.status, 200);
    // Without ?limit the whole page comes back (an absent limit once read as 0, so 1 row).
    const two = await ticket();
    await bin.binTickets((await getUserById(P.admin.id))!, [two.number]);
    const both = await call(binRoute.GET, req(`/recycle-bin?q=${encodeURIComponent(STAMP)}`, P.admin.session));
    assert.equal(both.body.rows.length, both.body.total, "every row up to the page size");
    assert.ok(both.body.total >= 2);
    await binPost(P.admin, "restore", [two.number]);
    assert.equal(list.body.rows[0]?.number, t.number);
    assert.equal(list.body.rows[0].deleted_by_name, "Ana Kowalski");
    assert.equal(list.body.rows[0].days_left, 30);
    assert.equal((await call(binRoute.GET, req("/recycle-bin", P.agent.session))).status, 403, "the bin needs tickets.delete");
    const mgr = await call(binRoute.GET, req(`/recycle-bin?q=${encodeURIComponent(t.subject)}`, P.manager.session));
    assert.ok(mgr.body.rows.some((x: { number: number }) => x.number === t.number), "Manager (tickets.delete) sees it");
    assert.equal(mgr.body.can_purge, false);
    const otherBin = await bin.listBin((await getUserById(P.other.id))!, { q: t.subject });
    assert.equal(otherBin.total, 0, "another team's agent: no bin (and no tickets.delete)");

    const r = await binPost(P.manager, "restore", [t.number]);
    assert.equal(r.body.ok, 1, JSON.stringify(r.body));
    const back = await row(t.id);
    assert.equal(back.deleted_at, null);
    assert.equal(back.deleted_by_name, "");
    assert.equal(back.status, "open");
    assert.equal(back.assignee_id, P.agent.id);
    assert.equal(String(back.updated_at), String(before.updated_at), "sorts where it did");
    const shift = (Date.parse(back.resolve_due) - Date.parse(before.resolve_due)) / 60_000;
    // By the time in the bin, counted in the team's SLA hours (a business-hours target can move further in wall time).
    assert.ok(shift >= 119, `the resolve due moved by at least the 2 hours in the bin (${shift} min)`);
    assert.ok(Number(back.sla_paused_ms) >= 119 * 60_000, "counted as paused");
    assert.ok((await tickets.listTickets({ id: P.agent.id, role: "viewer" }, { view: "mine" })).rows.some((x) => x.number === t.number), "in the queue again");
    const audit = (await pool().query("SELECT action FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = $1 ORDER BY id DESC LIMIT 1", [String(t.id)])).rows[0];
    assert.equal(audit.action, "helpdesk.ticket.restored");
    assert.equal((await binPost(P.manager, "restore", [t.number])).body.ok, 0, "not in the bin any more");
  });

  test("the purge sweep deletes for good after 30 days (the database's clock), skipping a legal hold; the audit keeps #N and subject", async () => {
    const old = await ticket();
    const young = await ticket();
    const held = await ticket();
    await bin.binTickets((await getUserById(P.admin.id))!, [old.number, young.number, held.number]);
    await pool().query("UPDATE hd_tickets SET deleted_at = now() - interval '30 days 1 minute' WHERE id = ANY($1)", [[old.id, held.id]]);
    await pool().query("UPDATE hd_tickets SET deleted_at = now() - interval '29 days 23 hours' WHERE id = $1", [young.id]);
    // A hold placed while it was in the bin.
    await pool().query("UPDATE hd_tickets SET legal_hold = 1 WHERE id = $1", [held.id]);
    const r = await bin.purgeExpired({ only: [old.id, young.id, held.id] });
    assert.deepEqual(r.purged, [old.id]);
    assert.equal(await row(old.id), undefined);
    assert.ok(await row(young.id), "29 days: still there");
    assert.ok(await row(held.id), "on hold: skipped");
    const audit = (await pool().query("SELECT actor_id, target_label, details FROM audit_log WHERE action = 'helpdesk.ticket.purged' AND target_id = $1", [String(old.id)])).rows[0];
    assert.equal(audit.target_label, `#${old.number} ${old.subject}`);
    assert.equal(audit.actor_id, null, "the system");
    assert.equal(audit.details.reason, "recycle_bin_expired");
    // Delete for good refuses the held one too.
    const p = await binPost(P.admin, "purge", [held.number]);
    assert.equal(p.body.ok, 0);
    assert.match(p.body.results[0].error, /legal hold/i);
  });

  test("webhooks: ticket.deleted on a bin and ticket.restored on a restore, one per ticket; nothing else while binned", async () => {
    const hooks = await import("../src/lib/helpdesk/webhooks");
    hooks.setWebhookAutoSendForTests(false);
    const { hook } = await hooks.createWebhook(
      { name: `${STAMP} bin`, url: "https://hooks.example.test/bin", events: ["ticket.deleted", "ticket.restored", "ticket.updated"], team_ids: [T1], include_notes: false },
      { id: P.admin.id, name: P.admin.name }
    );
    try {
      const t = await ticket();
      const events = async () => (await pool().query("SELECT event FROM hd_webhook_deliveries WHERE hook_id = $1 AND ticket_id = $2 ORDER BY id", [hook.id, t.id])).rows.map((r) => r.event);
      assert.equal((await binPost(P.admin, "bin", [t.number])).body.ok, 1);
      assert.deepEqual(await events(), ["ticket.deleted"]);
      assert.equal(await hooks.emitHelpdeskWebhookEvent("ticket.updated", { ticketId: t.id, changed: ["priority"] }), 0, "nothing else while binned");
      assert.equal((await binPost(P.admin, "restore", [t.number])).body.ok, 1);
      assert.deepEqual(await events(), ["ticket.deleted", "ticket.restored"]);
    } finally {
      await pool().query("DELETE FROM hd_webhooks WHERE id = $1", [hook.id]);
      hooks.setWebhookAutoSendForTests(true);
    }
  });

  test("the purge sweep is registered, daily, with a lock key of its own", () => {
    assert.ok(periodic.HELPDESK_SWEEPS.some((s) => s.name === "hd_recycle_bin"));
    /* eslint-disable @typescript-eslint/no-require-imports */
    const keys = [
      (require("../src/lib/helpdesk/db-sla") as typeof import("../src/lib/helpdesk/db-sla")).SLA_SWEEP_LOCK,
      (require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars")).CALENDAR_RECOMPUTE_LOCK,
      (require("../src/lib/helpdesk/assignment/engine") as typeof import("../src/lib/helpdesk/assignment/engine")).ASSIGNMENT_SWEEP_LOCK,
      retention.RETENTION_LOCK,
      (require("../src/lib/helpdesk/recurring") as typeof import("../src/lib/helpdesk/recurring")).RECURRING_SWEEP_LOCK,
      (require("../src/lib/helpdesk/status-teams") as typeof import("../src/lib/helpdesk/status-teams")).STATUS_TEAMS_LOCK,
      (require("../src/lib/helpdesk/assets") as typeof import("../src/lib/helpdesk/assets")).ASSETS_SYNC_LOCK,
      7_281_962,
      728341,
      728342,
      728343,
      bin.BIN_PURGE_LOCK,
    ];
    /* eslint-enable @typescript-eslint/no-require-imports */
    assert.equal(new Set(keys).size, keys.length);
  });

  test("days left and the banner sentence", () => {
    const now = new Date(2026, 10, 6, 15, 0);
    const at = new Date(2026, 10, 6, 14, 2).toISOString();
    assert.equal(binShared.binDaysLeft(at, now.getTime()), 30);
    assert.equal(binShared.binDaysLeft(new Date(2026, 9, 9, 12).toISOString(), now.getTime()), 2, "binned 9 Oct: deleted for good on 8 Nov");
    assert.equal(binShared.binDaysLeftLabel(1), "1 day");
    assert.equal(
      binShared.binBannerText({ deleted_at: at, deleted_by_name: "Ana Kowalski", purge_at: binShared.binPurgeAt(at).toISOString(), legal_hold: false }, now),
      "Ana Kowalski deleted it today at 14:02. It's deleted for good on 6 Dec unless it's restored."
    );
  });
});


// --- 1.19.4 review fixes ----------------------------------------------------------------------

describe("review fixes", () => {
  const admin = async () => (await getUserById(P.admin.id))!;
  /** Team lead of T1 only, given Delete tickets: tickets.delete is per team (lifted by tickets.view_all). */
  async function lead(): Promise<Person> {
    if (P.lead) return P.lead;
    const p = await person("lead", "Lee Lead");
    await deskRole(p.id, "team_lead");
    await member(T1, p.id, "lead");
    return p;
  }
  const leadMatrix = (): HdRoleMatrix => ({ ...managerDeletes(), team_lead: [...shared.HD_DEFAULT_MATRIX.team_lead, "tickets.delete"] });

  test("tickets.delete and tickets.purge are per team: another team's ticket assigned to you can't be deleted; the bin shows your teams only", async () => {
    roles.setRoleMatrixForTests(leadMatrix());
    try {
      const l = await lead();
      assert.equal(shared.HD_CAP_SCOPE["tickets.delete"], "tickets.view_all");
      assert.equal(shared.HD_CAP_SCOPE["tickets.purge"], "tickets.view_all");
      const hr = await ticket({ team: T2, assignee: l.id });
      const r = await binPost(l, "bin", [hr.number]);
      assert.equal(r.body.ok, 0);
      assert.match(r.body.results[0].error, /can't delete tickets in .*HR/);
      // Binned by someone else, it isn't in the lead's bin.
      await bin.binTickets(await admin(), [hr.number]);
      assert.equal((await bin.listBin((await getUserById(l.id))!, { q: hr.subject })).total, 0);
      assert.equal((await binPost(l, "restore", [hr.number])).body.ok, 0);
    } finally {
      roles.setRoleMatrixForTests(managerDeletes());
    }
  });

  test("a request's task tickets go with it only when the agent may delete them; the rest stay, and restore follows the same rule", async () => {
    roles.setRoleMatrixForTests(leadMatrix());
    try {
      const l = await lead();
      const parent = await ticket();
      const mine = await ticket({ parent: parent.id, source: "workflow" });
      const theirs = await ticket({ team: T2, parent: parent.id, source: "workflow" });
      const preview = await binPost(l, "preview", [parent.number]);
      assert.match(preview.body.results[0].note, new RegExp(`Its task #${mine.number} goes with it\\.`));
      assert.match(preview.body.results[0].note, new RegExp(`Task #${theirs.number} stays open: you can't delete tickets in .*HR`));
      const r = await binPost(l, "bin", [parent.number]);
      assert.equal(r.body.ok, 1);
      assert.ok((await row(mine.id)).deleted_at, "the task in the lead's team went");
      assert.equal((await row(theirs.id)).deleted_at, null, "HR's task stays");
      // Bin both as admin, then restore as the lead: HR's task stays in the bin.
      await binPost(l, "restore", [parent.number]);
      await bin.binTickets(await admin(), [parent.number]);
      assert.ok((await row(theirs.id)).deleted_at, "admin may delete HR's task: it went");
      // A task can't come back alone while its request is in the bin.
      const alone = await binPost(P.admin, "restore", [mine.number]);
      assert.equal(alone.body.ok, 0);
      assert.match(alone.body.results[0].error, new RegExp(`request #${parent.number} is in the recycle bin`));
      const back = await binPost(l, "restore", [parent.number]);
      assert.equal(back.body.ok, 1);
      assert.match(back.body.results[0].note, new RegExp(`Task #${theirs.number} stays in the bin`));
      assert.equal((await row(mine.id)).deleted_at, null);
      assert.ok((await row(theirs.id)).deleted_at);
    } finally {
      roles.setRoleMatrixForTests(managerDeletes());
    }
  });

  test("bulk: a task that went with its request is reported as binned with it, not as not found", async () => {
    const parent = await ticket();
    const task = await ticket({ parent: parent.id, source: "workflow" });
    const r = await binPost(P.admin, "bin", [parent.number, task.number]);
    assert.equal(r.body.ok, 2, JSON.stringify(r.body));
    assert.equal(r.body.results[1].note, `Binned with #${parent.number}.`);
    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.bulk_binned' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [P.admin.id])).rows[0];
    assert.deepEqual(audit.details.skipped_numbers, []);
  });

  test("legal hold: placed on a binned ticket through its route (settings.manage), it stops the purge", async () => {
    const t = await ticket();
    await bin.binTickets(await admin(), [t.number]);
    const hold = (by: Person, on?: boolean) =>
      call(on === undefined ? holdRoute.GET : holdRoute.PUT, req(`/tickets/${t.number}/legal-hold`, by.session, on === undefined ? undefined : { on }, on === undefined ? "GET" : "PUT"), { number: String(t.number) });
    assert.equal((await hold(P.agent)).status, 200, "an agent who works it reads the hold");
    assert.equal((await hold(P.other)).status, 404, "another team's agent: nothing");
    assert.equal((await hold(P.agent, true)).status, 403, "setting it needs settings.manage");
    const put = await hold(P.admin, true);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.legal_hold, true);
    await pool().query("UPDATE hd_tickets SET deleted_at = now() - interval '31 days' WHERE id = $1", [t.id]);
    assert.deepEqual((await bin.purgeExpired({ only: [t.id] })).purged, [], "held: the purge skips it");
    assert.ok(await row(t.id));
    const view = await call(binTicketRoute.GET, req(`/recycle-bin/${t.number}`, P.admin.session), { number: String(t.number) });
    assert.equal(view.body.bin.legal_hold, true, "the banner says so");
  });

  test("an open major incident ends with the bin, in its transaction: a bin refused under the lock leaves it open", async () => {
    const t = await ticket();
    await pool().query("INSERT INTO hd_incidents (ticket_id, title) VALUES ($1, $2)", [t.id, `${STAMP} outage`]);
    // A hold placed after the checks: the bin is refused under the lock, and the incident stays open.
    await pool().query("UPDATE hd_tickets SET legal_hold = 1 WHERE id = $1", [t.id]);
    assert.equal(await dbCore.withTx((c) => bin.binTicketTx(c, t.id, { id: P.admin.id, name: "Ana" })), undefined);
    assert.equal((await pool().query("SELECT solved_at FROM hd_incidents WHERE ticket_id = $1", [t.id])).rows[0].solved_at, null);
    await pool().query("UPDATE hd_tickets SET legal_hold = 0 WHERE id = $1", [t.id]);
    const done = await dbCore.withTx((c) => bin.binTicketTx(c, t.id, { id: P.admin.id, name: "Ana" }));
    assert.equal(done?.incident_ended, true);
    assert.ok((await pool().query("SELECT solved_at FROM hd_incidents WHERE ticket_id = $1", [t.id])).rows[0].solved_at);
    await pool().query("DELETE FROM hd_incidents WHERE ticket_id = $1", [t.id]);
  });

  test("a binned ticket's time entries are read-only", async () => {
    const t = await ticket();
    const e = (await pool().query("INSERT INTO hd_time_entries (ticket_id, user_id, minutes, note, logged_at, source) VALUES ($1, $2, 30, '', now(), 'manual') RETURNING id", [t.id, P.agent.id])).rows[0].id as number;
    await bin.binTickets(await admin(), [t.number]);
    assert.equal(await timeLib.getTimeEntry(e), undefined);
    const patch = await call(timeRoute.PATCH, req(`/time/${e}`, P.agent.session, { minutes: 5 }, "PATCH"), { id: String(e) });
    assert.equal(patch.status, 404);
    const gone = await call(timeRoute.DELETE, req(`/time/${e}`, P.agent.session, undefined, "DELETE"), { id: String(e) });
    assert.equal(gone.status, 404);
    assert.equal((await pool().query("SELECT minutes FROM hd_time_entries WHERE id = $1", [e])).rows[0].minutes, 30);
  });

  test("live tickets that point to a binned one say 'a deleted ticket': the task's parent, the merged ticket", async () => {
    const parent = await ticket();
    const task = await ticket({ parent: parent.id, source: "workflow" });
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE id = $1", [task.id]);
    const keep = await ticket();
    const dup = await ticket();
    await pool().query("UPDATE hd_tickets SET status = 'closed', merged_into = $1 WHERE id = $2", [keep.id, dup.id]);
    await bin.binTickets(await admin(), [parent.number, keep.number]);
    assert.equal((await row(task.id)).deleted_at, null, "a solved task stays");
    const d = await detail.ticketDetail({ id: P.admin.id, role: "viewer" }, (await tickets.getTicketById(task.id))!, true);
    assert.deepEqual(d.parent, { number: 0, subject: "", deleted: true });
    assert.ok(!JSON.stringify(d).includes(parent.subject));
    const m = await merge.mergeInfo(dup.id);
    assert.deepEqual(m.into, { number: 0, subject: "", deleted: true });
    assert.equal(await merge.mergedLock((await row(dup.id))), `#${dup.number} was merged into a ticket that has since been deleted.`);
    assert.deepEqual((await merge.mergeInfo(keep.id)).merged_in.length, 1, "the kept ticket's own view still lists its sources");
  });

  test("an email reply to a binned ticket leaves the quoted thread out of the new ticket", async () => {
    const t = await ticket();
    const token = (await email.ensureReplyToken(t.id))!;
    await bin.binTickets(await admin(), [t.number]);
    const res = await inbound.processInboundEmail(
      {
        provider: "generic",
        from: { email: P.req.email, name: P.req.name },
        to: [{ email: "help@example.test", name: "" }],
        cc: [],
        recipients: [],
        subject: `Re: ${t.subject} [#${t.number} ref:${token}]`,
        text: `${STAMP} new detail only.\n\nOn Mon, Support wrote:\n> The misdirected salary list is attached.`,
        html: "",
        stripped: "",
        messageId: `${newToken()}@mail.example.test`,
        inReplyTo: "",
        references: [],
        headers: {},
        auth: { dmarc: "pass" },
        files: [],
      } as never,
      { outsideSenders: false }
    );
    assert.equal(res.body.outcome, "created", JSON.stringify(res.body));
    const body = (await pool().query("SELECT m.body FROM hd_messages m JOIN hd_tickets x ON x.id = m.ticket_id WHERE x.number = $1 AND m.kind <> 'system' ORDER BY m.id LIMIT 1", [res.body.ticket])).rows[0].body as string;
    assert.match(body, /new detail only/);
    assert.ok(!body.includes("misdirected salary list"), body);
    assert.ok(!body.includes(`#${t.number}`), "never names the binned ticket");
  });

  test("workflows: a binned request's run is held, a restore moves it on, a purge ends it", async () => {
    const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} Flow` });
    assert.ok(meta.ok);
    const def = workflows.parseWorkflowDefinition({ trigger: {}, steps: [{ key: "it", kind: "task", title: "Set it up", team_id: T1 }, { key: "done", kind: "finish", title: "Done", csat: false }] });
    assert.ok(def.ok, !def.ok ? def.error : "");
    const wf = await workflows.createWorkflow(meta.ok ? meta.value : (null as never), def.ok ? def.value : (null as never));
    workflowIds.push(wf.id);
    const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Type`, team_id: T1, form: [], workflow_id: wf.id });
    assert.ok(input.ok);
    const rt = await requestTypes.createRequestType(input.ok ? input.value : (null as never));
    typeIds.push(rt.id);
    assert.ok((await workflows.publishWorkflow(wf.id)).ok);
    const raise = () =>
      tickets.createTicket(
        { subject: `${STAMP} new laptop`, body: "Please.", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, request_type_id: rt.id, answers: {} } as never,
        { silent: true, actorId: P.req.id, actorName: P.req.name }
      );
    const runOf = async (id: number) => (await pool().query("SELECT * FROM hd_workflow_runs WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0];
    const kids = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE parent_ticket_id = $1 ORDER BY id", [id])).rows;

    const t = await raise();
    const [task] = await kids(t.id);
    assert.ok(task, "the task ticket was opened");
    assert.equal((await binPost(P.admin, "bin", [t.number])).body.ok, 1);
    assert.ok((await row(task.id)).deleted_at, "its task went with it");
    // The task deleted for good on its own: the held run doesn't move (no finish, no solve, no new ticket).
    assert.equal((await binPost(P.admin, "purge", [task.number])).body.ok, 1);
    assert.equal((await runOf(t.id)).state, "running");
    assert.equal((await engine.sweepWorkflows({ claim: false, runIds: [(await runOf(t.id)).id] })).advanced, 0);
    assert.equal((await row(t.id)).status, "new");
    // Restored: the run moves on at once.
    assert.equal((await binPost(P.admin, "restore", [t.number])).body.ok, 1);
    assert.equal((await runOf(t.id)).state, "done");

    // A purged request takes its run with it.
    const t2 = await raise();
    const run2 = (await runOf(t2.id)).id;
    await binPost(P.admin, "bin", [t2.number]);
    assert.equal((await binPost(P.admin, "purge", [t2.number])).body.ok, 1);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_workflow_runs WHERE id = $1", [run2])).rows[0].n, 0);
  });

  test("analytics: a binned request's workflow steps count in no measure", async () => {
    const T3 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9204) RETURNING id", [`${STAMP} Steps`])).rows[0].id as number;
    try {
      const req1 = await ticket({ team: T3 });
      const run = (await pool().query("INSERT INTO hd_workflow_runs (ticket_id, state) VALUES ($1, 'done') RETURNING id", [req1.id])).rows[0].id;
      await pool().query(
        "INSERT INTO hd_workflow_steps (run_id, step_key, kind, state, started_at, finished_at, result) VALUES ($1, 'w', 'wait', 'skipped', now(), now(), $2)",
        [run, JSON.stringify({ team_id: T3, outcome: "skipped" })]
      );
      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      const HOURS = { timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", holidays: [] };
      reportHours.setReportHoursForTests(HOURS);
      try {
        const q = () =>
          analytics.runQuery({ measure: "steps_skipped", range: { from: day(-1), to: day(1) }, filters: { team: [T3] } } as never, { id: P.manager.id, role: "viewer" }, {
            scope: { kind: "all", userId: P.manager.id } as never,
            tz: "UTC",
            fresh: true,
          });
        assert.equal((await q()).total.value, 1, "counted while the request is live");
        await bin.binTickets(await admin(), [req1.number]);
        assert.equal((await q()).total.value ?? 0, 0, "not once it is binned");
      } finally {
        reportHours.setReportHoursForTests(null);
      }
    } finally {
      const ids = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = $1", [T3])).rows.map((r) => r.id);
      await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ids]);
      await pool().query("DELETE FROM hd_teams WHERE id = $1", [T3]);
    }
  });

  test("digest items queued about a ticket are dropped when it is binned", async () => {
    const t = await ticket();
    const other = await ticket();
    await pool().query(
      `INSERT INTO notify_digest_queue (user_id, event, mode, title, body, link) VALUES
         ($1, 'requester_replied', 'digest_daily', $2, 'excerpt', $3), ($1, 'requester_replied', 'digest_daily', $4, 'excerpt', $5)`,
      [P.agent.id, `${STAMP} reply`, `/desk/tickets/${t.number}`, `${STAMP} other`, `/desk/tickets/${other.number}`]
    );
    await bin.binTickets(await admin(), [t.number]);
    const left = (await pool().query("SELECT link FROM notify_digest_queue WHERE user_id = $1 AND title LIKE $2", [P.agent.id, `${STAMP}%`])).rows.map((r) => r.link);
    assert.deepEqual(left, [`/desk/tickets/${other.number}`]);
    await pool().query("DELETE FROM notify_digest_queue WHERE user_id = $1", [P.agent.id]);
  });
});
