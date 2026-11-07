// Helpdesk 1.19.2 checklists (agent W3): templates (checks, CRUD and who
// may), a template copied onto a ticket by hand, by its request type and by
// a workflow task, due dates counted in business days, ticking on the
// timeline and audited, required items blocking every solve path (PATCH,
// Send and set Solved, macros, bulk, the Claude connector, automations, a
// workflow's Finish step, a task's Mark done) and the paths that are not
// blocked (can't be done, merge, retention's auto-close), privacy
// (requesters never read checklists), merge moving them, anonymising
// removing them, and the connector's hd_read_ticket listing them.
//
// Same harness as test/helpdesk-time: next/headers and lib/ee stubbed,
// routes called with real sessions. Parallel-safe: teams, accounts, request
// types, workflows, templates and tickets are this file's own (STAMP); the
// role matrix and the connector level are overridden in-process only.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-checklists.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession, getUserById } from "../src/lib/db";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-checklists.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-checklists.virtual.js");
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

/* eslint-disable @typescript-eslint/no-require-imports */
const checklists = require("../src/lib/helpdesk/checklists") as typeof import("../src/lib/helpdesk/checklists");
const shared = require("../src/lib/helpdesk/checklists-shared") as typeof import("../src/lib/helpdesk/checklists-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const engine = require("../src/lib/helpdesk/engine") as typeof import("../src/lib/helpdesk/engine");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const claude = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const withTx = (require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core")).withTx;
const adminRoute = require("../src/app/api/helpdesk/admin/checklists/route") as typeof import("../src/app/api/helpdesk/admin/checklists/route");
const adminOneRoute = require("../src/app/api/helpdesk/admin/checklists/[id]/route") as typeof import("../src/app/api/helpdesk/admin/checklists/[id]/route");
const libraryRoute = require("../src/app/api/helpdesk/checklists/route") as typeof import("../src/app/api/helpdesk/checklists/route");
const ticketListsRoute = require("../src/app/api/helpdesk/tickets/[number]/checklists/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/checklists/route");
const ticketListRoute = require("../src/app/api/helpdesk/tickets/[number]/checklists/[id]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/checklists/[id]/route");
const ticketItemsRoute = require("../src/app/api/helpdesk/tickets/[number]/checklists/[id]/items/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/checklists/[id]/items/route");
const itemRoute = require("../src/app/api/helpdesk/tickets/[number]/checklists/items/[itemId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/checklists/items/[itemId]/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const bulkRoute = require("../src/app/api/helpdesk/tickets/bulk/route") as typeof import("../src/app/api/helpdesk/tickets/bulk/route");
const outcomeRoute = require("../src/app/api/helpdesk/tickets/[number]/task-outcome/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/task-outcome/route");
const macroRoute = require("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route");
const macros = require("../src/lib/helpdesk/macros") as typeof import("../src/lib/helpdesk/macros");
const requestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdWorkflowStepB } from "../src/lib/helpdesk/types";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any }> {
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
    return { status: res.status, body };
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

const STAMP = `hdck-${Date.now()}-${process.pid}`;
const P: Record<string, { id: number; session: string; name: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const tplIds: number[] = [];
const typeIds: number[] = [];
const workflowIds: number[] = [];
const ticketIds: number[] = [];

async function person(key: string, deskRole: string | null) {
  const name = `${key} ${STAMP}`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    `${STAMP}-${key}@example.test`,
  ]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[key] = { id, session, name };
}

async function ticket(subject: string, team = "A", status = "open"): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source) VALUES ($1, $2, 'Req', $3, $4, $5, 'portal') RETURNING id, number",
    [`${subject} ${STAMP}`, P.req.id, `${STAMP}-req@example.test`, T[team], status]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

const ITEMS = [
  { title: "Disable sign-in on the leaving date", required: true },
  { title: "Transfer OneDrive files to the manager" },
  { title: "Collect the laptop and badge", team_id: 0, due_days: 2 },
];

async function template(name: string, items: Record<string, unknown>[] = ITEMS, extra: Record<string, unknown> = {}): Promise<number> {
  const t = await checklists.createTemplate({ name: `${name} ${STAMP}`, items, ...extra }, { id: P.admin.id, name: P.admin.name });
  tplIds.push(t.id);
  return t.id;
}

const lines = async (ticketId: number) =>
  (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows as { kind: string; body: string }[];
const auditRows = async (action: string, actor: number) =>
  (await pool().query("SELECT details FROM audit_log WHERE action = $1 AND actor_id = $2 ORDER BY id", [action, actor])).rows.map((r) => r.details);
const statusOf = async (id: number) => (await pool().query("SELECT status FROM hd_tickets WHERE id = $1", [id])).rows[0].status as string;
const view = async (who: string, n: number) => call(ticketListsRoute.GET, req(`/tickets/${n}/checklists`, P[who].session), { number: String(n) });
const tick = (who: string, n: number, itemId: number, done: boolean) =>
  call(itemRoute.PATCH, req(`/tickets/${n}/checklists/items/${itemId}`, P[who].session, { done }, "PATCH"), { number: String(n), itemId: String(itemId) });
const solve = (who: string, n: number) => call(ticketRoute.PATCH, req(`/tickets/${n}`, P[who].session, { status: "solved" }, "PATCH"), { number: String(n) });

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  email.setHelpdeskTransportForTests(async () => {});
  for (const k of ["A", "B", "Fac"]) {
    const r = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9400) RETURNING id", [`${STAMP} ${k}`]);
    T[k] = r.rows[0].id;
  }
  ITEMS[2].team_id = T.Fac;
  await person("agent", "agent");
  await person("agent2", "agent");
  await person("newbie", "newbie");
  await person("other", "agent");
  await person("admin", "manager");
  await person("req", null);
  await pool().query(
    "INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($1, $4, 'agent'), ($5, $6, 'agent'), ($7, $2, 'agent')",
    [T.A, P.agent.id, P.agent2.id, P.newbie.id, T.B, P.other.id, T.Fac]
  );
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  claude.setClaudeLevelForTests(null);
  email.setHelpdeskTransportForTests(null);
  const children = await pool().query("SELECT id FROM hd_tickets WHERE parent_ticket_id = ANY($1) OR team_id = ANY($2)", [ticketIds, Object.values(T)]);
  const all = [...new Set([...ticketIds, ...children.rows.map((r) => r.id as number)])];
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL, merged_into = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1)", [workflowIds]);
  await pool().query("DELETE FROM hd_checklist_templates WHERE id = ANY($1) OR name LIKE $2", [tplIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

describe("checks (pure)", () => {
  test("a template needs a name and items; items need titles; Required, owner team and due days are checked", () => {
    const ok = shared.checkTemplateInput({ name: " Leaver ", items: [{ title: " Wipe  the laptop ", required: true, due_days: 2, team_id: 7 }, { key: "x", title: "B" }] });
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.equal(ok.value.name, "Leaver");
      assert.deepEqual(ok.value.items[0], { key: "i1", title: "Wipe the laptop", required: true, team_id: 7, due_days: 2 });
      assert.deepEqual(ok.value.items[1], { key: "x", title: "B" });
      assert.deepEqual(ok.value.request_type_ids, []);
    }
    const bad = (raw: unknown) => {
      const r = shared.checkTemplateInput(raw);
      return r.ok ? "" : r.error;
    };
    assert.match(bad({ name: "", items: [{ title: "a" }] }), /name/);
    assert.match(bad({ name: "x", items: [] }), /at least one item/);
    assert.match(bad({ name: "x", items: [{ title: "" }] }), /Item 1 needs a title/);
    assert.match(bad({ name: "x", items: [{ title: "a", due_days: 61 }] }), /0 to 60/);
    assert.match(bad({ name: "x", items: [{ title: "a", due_days: 1.5 }] }), /0 to 60/);
    assert.match(bad({ name: "x", items: [{ title: "a", required: "yes" }] }), /Required/);
    assert.match(bad({ name: "x", items: [{ title: "a", team_id: -1 }] }), /team/);
    assert.match(bad({ name: "x", items: Array.from({ length: 51 }, () => ({ title: "a" })) }), /50 items/);
    assert.match(bad({ name: "x", items: [{ title: "a" }], request_type_ids: ["a"] }), /Request types/);
    const dup = shared.checkTemplateInput({ name: "x", items: [{ key: "a", title: "1" }, { key: "a", title: "2" }] });
    assert.ok(dup.ok && dup.value.items[0].key !== dup.value.items[1].key, "duplicate keys are renamed");
  });

  test("a task's checklist_ids: a short list of ids; the refusal names up to three items", () => {
    assert.deepEqual(shared.checkTaskChecklistIds(undefined, "T"), { ok: true, value: undefined });
    assert.deepEqual(shared.checkTaskChecklistIds([3, 3, 4], "T"), { ok: true, value: [3, 4] });
    assert.deepEqual(shared.checkTaskChecklistIds([], "T"), { ok: true, value: undefined });
    assert.equal(shared.checkTaskChecklistIds("3", "T").ok, false);
    assert.equal(shared.checkTaskChecklistIds([1, 2, 3, 4, 5, 6], "T").ok, false);
    const m = shared.checklistBlockMessage([{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }]);
    assert.equal(m, 'Finish the required checklist items first: "a", "b", "c" and 1 more.');
    assert.ok(shared.isChecklistBlock(m));
    assert.ok(!shared.isChecklistBlock("Record the hand-off before solving: x."));
  });
});

describe("templates (Desk settings → Checklists)", () => {
  test("a Manager creates, edits and deletes; an agent may not; audited; the list says what adds it and how often", async () => {
    const make = (who: string, body: unknown) => call(adminRoute.POST, req("/admin/checklists", P[who].session, body));
    assert.equal((await make("agent", { name: `x ${STAMP}`, items: [{ title: "a" }] })).status, 403);
    assert.equal((await make("admin", { name: `x ${STAMP}`, items: [] })).status, 400);
    assert.equal((await make("admin", { name: `x ${STAMP}`, items: [{ title: "a", team_id: 99999999 }] })).status, 400, "a team that doesn't exist");
    const created = await make("admin", { name: `Office move ${STAMP}`, items: [{ title: "Book the movers", required: true }, { title: "Label the boxes" }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.template.id as number;
    tplIds.push(id);
    const put = await call(adminOneRoute.PUT, req(`/admin/checklists/${id}`, P.admin.session, { name: `Office move v2 ${STAMP}` }, "PUT"), { id: String(id) });
    assert.equal(put.status, 200);
    assert.equal(put.body.template.items.length, 2, "items kept when not sent");
    assert.equal((await call(adminOneRoute.PUT, req(`/admin/checklists/${id}`, P.agent.session, { name: "n" }, "PUT"), { id: String(id) })).status, 403);
    const list = await call(adminRoute.GET, req("/admin/checklists", P.admin.session));
    assert.equal(list.status, 200);
    const row = list.body.templates.find((t: { id: number }) => t.id === id);
    assert.equal(row.used, 0);
    assert.deepEqual(row.added_to, []);
    assert.ok(list.body.teams.some((t: { id: number }) => t.id === T.A));
    const lib = await call(libraryRoute.GET, req("/checklists", P.agent.session));
    assert.equal(lib.status, 200);
    assert.deepEqual(
      lib.body.templates.find((t: { id: number }) => t.id === id),
      { id, name: `Office move v2 ${STAMP}`, items: 2, required: 1 }
    );
    assert.equal((await call(libraryRoute.GET, req("/checklists", P.req.session))).status, 403, "requesters can't list the library");
    const del = await call(adminOneRoute.DELETE, req(`/admin/checklists/${id}`, P.admin.session, undefined, "DELETE"), { id: String(id) });
    assert.equal(del.status, 200);
    assert.deepEqual((await auditRows("helpdesk.checklist_template.created", P.admin.id)).length, 1);
    assert.deepEqual((await auditRows("helpdesk.checklist_template.updated", P.admin.id))[0].changed, ["name"]);
    assert.equal((await auditRows("helpdesk.checklist_template.deleted", P.admin.id)).length, 1);
  });
});

describe("on a ticket", () => {
  let tpl = 0;
  let t: { id: number; number: number };

  test("added by hand: a copy with its due dates counted in the owner team's calendar; twice is refused; the timeline and audit say so", async () => {
    tpl = await template("Leaver: IT");
    t = await ticket("Leaver Sam");
    const r = await call(ticketListsRoute.POST, req(`/tickets/${t.number}/checklists`, P.agent.session, { template_id: tpl }), { number: String(t.number) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.checklists.length, 1);
    const c = r.body.checklists[0];
    assert.equal(c.name, `Leaver: IT ${STAMP}`);
    assert.equal(c.source, "manual");
    assert.deepEqual([c.done, c.total, c.required_open], [0, 3, 1]);
    assert.equal(c.items[0].required, true);
    const due = c.items[2];
    assert.equal(due.team_name, `${STAMP} Fac`);
    const expected = await checklists.itemDue(2, T.Fac, new Date(c.created_at));
    assert.equal(due.due_date, expected?.date);
    assert.ok(due.due_date > new Date(c.created_at).toISOString().slice(0, 10), "2 business days later");
    assert.equal(r.body.can_edit, true);
    assert.equal(r.body.can_remove, true);
    const again = await call(ticketListsRoute.POST, req(`/tickets/${t.number}/checklists`, P.agent.session, { template_id: tpl }), { number: String(t.number) });
    assert.equal(again.status, 409);
    const l = await lines(t.id);
    // The name Markdown-escaped (lib/helpdesk/md-inline escapes every ":"); the desk shows "Leaver: IT".
    assert.deepEqual(l.at(-1), { kind: "internal", body: `${P.agent.name} added the checklist "Leaver\\: IT ${STAMP}"` });
    assert.equal((await auditRows("helpdesk.checklist.added", P.agent.id))[0].template_id, tpl);
  });

  test("the template edit never changes the ticket's copy", async () => {
    await checklists.updateTemplate(tpl, { items: [{ title: "Only one" }] });
    const v = await view("agent", t.number);
    assert.equal(v.body.checklists[0].total, 3);
    await checklists.updateTemplate(tpl, { items: ITEMS });
  });

  test("required items block solving: the desk's Solve, Send and set Solved (nothing posted), bulk, and pending → closed", async () => {
    const s = await solve("agent", t.number);
    assert.equal(s.status, 409);
    assert.equal(s.body.error, `Finish the required checklist items first: "Disable sign-in on the leaving date".`);
    assert.equal(await statusOf(t.id), "open");
    const before = (await lines(t.id)).length;
    const send = await call(messagesRoute.POST, req(`/tickets/${t.number}/messages`, P.agent.session, { kind: "public", body: "All done", then_status: "solved" }), { number: String(t.number) });
    assert.equal(send.status, 409);
    assert.equal(send.body.code, "checklist_required");
    assert.equal((await lines(t.id)).length, before, "the reply was not posted");
    const bulk = await call(bulkRoute.POST, req("/tickets/bulk", P.agent.session, { numbers: [t.number], patch: { status: "solved", priority: "high" } }));
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.results[0].ok, false);
    assert.match(bulk.body.results[0].error, /^Finish the required checklist items first/);
    const macro = await macros.createMacro({ title: `${STAMP} solve`, body: "Sorted, thanks.", actions: { status: "solved" }, team_id: null, owner_id: P.agent.id }, P.agent.id);
    try {
      const m = await call(macroRoute.POST, req(`/tickets/${t.number}/macro/${macro.id}`, P.agent.session, {}), { number: String(t.number), macroId: String(macro.id) });
      assert.equal(m.status, 409, JSON.stringify(m.body));
      assert.match(m.body.error, /^Finish the required checklist items first/);
      assert.equal((await lines(t.id)).length, before, "the macro's reply was not posted");
    } finally {
      await pool().query("DELETE FROM hd_macros WHERE id = $1", [macro.id]);
    }
    await tickets.updateTicket(t.id, { status: "pending" }, { id: P.agent.id, name: P.agent.name });
    await assert.rejects(tickets.updateTicket(t.id, { status: "closed" }, { id: P.agent.id, name: P.agent.name }), /required checklist items/);
    await tickets.updateTicket(t.id, { status: "open" }, { id: P.agent.id, name: P.agent.name });
  });

  test("ticking: anyone who works it, newbies too; idempotent; an internal timeline line; audited; another team's agent and the requester get 404", async () => {
    const v = await view("agent", t.number);
    const required = v.body.checklists[0].items[0];
    assert.equal((await tick("other", t.number, required.id, true)).status, 404);
    assert.equal((await tick("req", t.number, required.id, true)).status, 403);
    assert.equal((await view("req", t.number)).status, 403, "requesters never read checklists");
    const r = await tick("newbie", t.number, required.id, true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const it = r.body.checklists[0].items[0];
    assert.equal(it.done, true);
    assert.equal(it.done_by_name, P.newbie.name);
    assert.equal(r.body.can_remove, false, "a newbie can't change status, so can't remove");
    const again = await tick("newbie", t.number, required.id, true);
    assert.equal(again.status, 200);
    const l = (await lines(t.id)).filter((x) => /ticked/.test(x.body));
    assert.deepEqual(l, [{ kind: "internal", body: `${P.newbie.name} ticked "Disable sign-in on the leaving date" (Leaver\\: IT ${STAMP})` }]);
    assert.equal((await auditRows("helpdesk.checklist.item_ticked", P.newbie.id)).length, 1, "once: the repeat changed nothing");
    const un = await tick("agent", t.number, required.id, false);
    assert.equal(un.body.checklists[0].items[0].done, false);
    assert.equal((await auditRows("helpdesk.checklist.item_unticked", P.agent.id)).length, 1);
    assert.equal((await solve("agent", t.number)).status, 409, "unticked again: still blocked");
    await tick("agent", t.number, required.id, true);
  });

  test("a one-off item (never required); the requester's view of the request has no checklist lines", async () => {
    const v = await view("agent", t.number);
    const cid = v.body.checklists[0].id;
    const add = await call(ticketItemsRoute.POST, req(`/tickets/${t.number}/checklists/${cid}/items`, P.agent.session, { title: "Return the parking pass" }), {
      number: String(t.number),
      id: String(cid),
    });
    assert.equal(add.status, 201);
    assert.equal(add.body.checklists[0].total, 4);
    assert.equal(add.body.checklists[0].items[3].required, false);
    assert.equal((await auditRows("helpdesk.checklist.item_added", P.agent.id)).length, 1);
    const mine = await call(requestRoute.GET, req(`/requests/${t.number}`, P.req.session), { number: String(t.number) });
    assert.equal(mine.status, 200);
    const text = JSON.stringify(mine.body);
    assert.ok(!/checklist|ticked|Disable sign-in/i.test(text), "no checklist in the requester's read");
  });

  test("with the required items ticked, optional ones open, it solves; solved → closed is never blocked", async () => {
    const s = await solve("agent", t.number);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(await statusOf(t.id), "solved");
    const v = await view("agent", t.number);
    await tick("agent", t.number, v.body.checklists[0].items[0].id, false);
    await tickets.updateTicket(t.id, { status: "closed" }, { id: null, name: "Retention" });
    assert.equal(await statusOf(t.id), "closed");
    const closed = await view("agent", t.number);
    assert.equal(closed.body.can_edit, false, "a closed ticket's checklists are read-only");
    assert.equal((await tick("agent", t.number, v.body.checklists[0].items[0].id, true)).status, 409);
  });

  test("removing: needs Change status; timeline and audit; then nothing blocks", async () => {
    const t2 = await ticket("Remove me");
    await checklists.addChecklistToTicket(t2.id, tpl, { id: P.agent.id, name: P.agent.name });
    const v = await view("agent", t2.number);
    const cid = v.body.checklists[0].id;
    const del = (who: string) => call(ticketListRoute.DELETE, req(`/tickets/${t2.number}/checklists/${cid}`, P[who].session, undefined, "DELETE"), { number: String(t2.number), id: String(cid) });
    assert.equal((await del("newbie")).status, 403);
    const ok = await del("agent");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.checklists.length, 0);
    assert.equal((await auditRows("helpdesk.checklist.removed", P.agent.id)).at(-1).required_open, 1);
    assert.match((await lines(t2.id)).at(-1)!.body, /removed the checklist/);
    assert.equal((await solve("agent", t2.number)).status, 200);
  });

  test("the Claude connector: hd_read_ticket lists checklists; hd_update_ticket is refused while required items are open", async () => {
    claude.setClaudeLevelForTests("update");
    const t3 = await ticket("Connector");
    await checklists.addChecklistToTicket(t3.id, tpl, { id: P.agent.id, name: P.agent.name });
    const user = (await getUserById(P.agent.id))!;
    const ctx = { origin: "http://localhost", ip: null };
    const read = await hdTools.callHelpdeskTool(user, "hd_read_ticket", { number: t3.number }, ctx);
    assert.equal(read.isError, false, read.content[0].text);
    const out = JSON.parse(read.content[0].text);
    assert.equal(out.checklists.length, 1);
    assert.equal(out.checklists[0].progress, "0 of 3 done");
    assert.equal(out.checklists[0].required_open, 1);
    assert.deepEqual(out.checklists[0].items[0], { title: "Disable sign-in on the leaving date", done: false, required: true });
    const upd = await hdTools.callHelpdeskTool(user, "hd_update_ticket", { number: t3.number, status: "solved" }, ctx);
    assert.equal(upd.isError, true);
    assert.match(upd.content[0].text, /^Finish the required checklist items first/);
    assert.equal(await statusOf(t3.id), "open");
    const reqUser = (await getUserById(P.req.id))!;
    const asRequester = await hdTools.callHelpdeskTool(reqUser, "hd_read_request", { number: t3.number }, ctx);
    assert.ok(!/checklist/i.test(asRequester.content[0].text), "the requester's read has none");
  });

  test("merge: not blocked; the merged ticket's checklists move to the kept one, except a template the kept one has", async () => {
    const other = await template("Printer fault", [{ title: "Check the toner", required: true }]);
    const keep = await ticket("Keep");
    const dup = await ticket("Dup");
    await checklists.addChecklistToTicket(keep.id, tpl, { id: P.agent.id, name: P.agent.name });
    await checklists.addChecklistToTicket(dup.id, tpl, { id: P.agent.id, name: P.agent.name });
    await checklists.addChecklistToTicket(dup.id, other, { id: P.agent.id, name: P.agent.name });
    const r = await merge.mergeTickets({ id: P.agent.id, role: "viewer", name: P.agent.name }, { keep: keep.number, merge: [dup.number], notify: false });
    assert.equal(r.merged.length, 1);
    assert.equal(await statusOf(dup.id), "closed");
    const kept = await checklists.ticketChecklists(keep.id);
    assert.deepEqual(kept.map((c) => c.name), [`Leaver: IT ${STAMP}`, `Printer fault ${STAMP}`]);
    const items = await pool().query("SELECT DISTINCT ticket_id FROM hd_ticket_checklist_items WHERE checklist_id = $1", [kept[1].id]);
    assert.deepEqual(items.rows.map((x) => x.ticket_id), [keep.id], "the items moved with it");
    assert.equal((await checklists.ticketChecklists(dup.id)).length, 1, "the duplicate template stayed");
    assert.deepEqual((await checklists.requiredOpenItems(keep.id)).map((x) => x.title), ["Disable sign-in on the leaving date", "Check the toner"]);
  });

  test("anonymising a ticket removes its checklists", async () => {
    const t4 = await ticket("Anon", "A", "closed");
    await withTx((c) => checklists.addChecklistTx(c, t4.id, tpl, null, { source: "manual" }));
    assert.equal((await checklists.ticketChecklists(t4.id)).length, 1);
    await withTx((c) => retention.anonymiseTicketTx(c, t4.id));
    assert.equal((await checklists.ticketChecklists(t4.id)).length, 0);
  });
});

describe("review fixes", () => {
  let tpl = 0;
  const rowOf = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];

  before(async () => {
    tpl = await template("Review", [{ title: "Check the backup", required: true }]);
  });

  test("a macro checks the checklist itself: a person's macro is refused before its reply; an automation's sends the reply, keeps the rest and drops only the status", async () => {
    const t = await ticket("Macro");
    await checklists.addChecklistToTicket(t.id, tpl, { id: P.agent.id, name: P.agent.name });
    const macro = await macros.createMacro({ title: `${STAMP} close`, body: "Glad that fixed it, we've closed this request.", actions: { status: "solved", priority: "high" }, team_id: null, owner_id: P.agent.id }, P.agent.id);
    try {
      const before = (await lines(t.id)).length;
      const person = await macros.applyMacroToTicket(t.id, macro.id, { id: P.agent.id, name: P.agent.name, email: "" });
      assert.equal(person.ok, false);
      assert.equal(!person.ok && person.status, 409);
      assert.equal((await lines(t.id)).length, before, "nothing posted");
      const auto = await macros.applyMacroToTicket(t.id, macro.id, { id: null, name: "Automation: thanks" }, { fromAutomation: true });
      assert.ok(auto.ok, JSON.stringify(auto));
      assert.match(auto.ok ? auto.status_unchanged ?? "" : "", /^Finish the required checklist items first/);
      const r = await rowOf(t.id);
      assert.deepEqual([r.status, r.priority], ["open", "high"], "the priority applied, the status did not");
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' AND body LIKE 'Glad that fixed it%'", [t.id])).rows[0].n, 1);
    } finally {
      await pool().query("DELETE FROM hd_macros WHERE id = $1", [macro.id]);
    }
  });

  test("an automation's blocked solve keeps its team move; a bad assignee and a blocked solve together still apply the rest", async () => {
    const automations = require("../src/lib/helpdesk/automations") as typeof import("../src/lib/helpdesk/automations");
    const t = await ticket("Rule");
    await checklists.addChecklistToTicket(t.id, tpl, { id: P.agent.id, name: P.agent.name });
    const rule = (actions: Record<string, unknown>) => ({ id: 0, name: `${STAMP} rule`, actions }) as never;
    assert.equal(await automations.applyRule(rule({ status: "solved", team_id: T.B }), await rowOf(t.id)), true);
    let r = await rowOf(t.id);
    assert.deepEqual([r.status, r.team_id], ["open", T.B], "moved to the team, not solved");
    await pool().query("UPDATE hd_tickets SET team_id = $2 WHERE id = $1", [t.id, T.A]);
    assert.equal(await automations.applyRule(rule({ status: "solved", assignee_id: P.other.id, priority: "urgent" }), await rowOf(t.id)), true);
    r = await rowOf(t.id);
    assert.deepEqual([r.status, r.assignee_id, r.priority], ["open", null, "urgent"]);
  });

  test("Send and set Solved is checked inside addMessage: refused before anything is stored", async () => {
    const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
    const t = await ticket("Send");
    await checklists.addChecklistToTicket(t.id, tpl, { id: P.agent.id, name: P.agent.name });
    const before = (await lines(t.id)).length;
    await assert.rejects(
      messages.addMessage(t.id, { kind: "public", body: "Done", author: { id: P.agent.id, name: P.agent.name, email: "" }, via: "desk", then_status: "solved" }),
      (e: Error & { status?: number; messageUnsent?: boolean }) => e.status === 409 && e.messageUnsent === true && /^Finish the required/.test(e.message)
    );
    assert.equal((await lines(t.id)).length, before);
  });

  test("solved → closed is never asked, on every path; a solve-blocked ticket's view says so", async () => {
    const t = await ticket("Closed later", "A", "solved");
    await checklists.addChecklistToTicket(t.id, tpl, { id: P.agent.id, name: P.agent.name });
    const v = await view("agent", t.number);
    assert.equal(v.body.solve_block, null, "already solved: nothing to block");
    const send = await call(messagesRoute.POST, req(`/tickets/${t.number}/messages`, P.agent.session, { kind: "public", body: "Closing", then_status: "closed" }), { number: String(t.number) });
    assert.equal(send.status, 201, JSON.stringify(send.body));
    assert.equal(await statusOf(t.id), "closed");
    const open = await ticket("Open one");
    await checklists.addChecklistToTicket(open.id, tpl, { id: P.agent.id, name: P.agent.name });
    assert.match((await view("agent", open.number)).body.solve_block, /^Finish the required checklist items first/);
  });

  test("a task whose template is gone gets a line saying so", async () => {
    const t = await ticket("Task gone");
    await withTx((c) => checklists.addTaskChecklistsTx(c, t.id, [99999999], "laptop", new Date()));
    assert.match((await lines(t.id)).at(-1)!.body, /checklist for this task no longer exists/);
  });

  test("due dates: never overdue the moment they are added, at any hour of any day; after the close they count from the next business day", async () => {
    const start = Date.UTC(2026, 10, 2, 0, 0); // Mon Nov 2 2026, 00:00 UTC
    for (let h = 0; h < 7 * 24; h += 3) {
      const now = new Date(start + h * 3_600_000);
      const d0 = await checklists.itemDue(0, T.A, now);
      assert.ok(d0 && d0.at.getTime() > now.getTime(), `due the day it's added, at ${now.toISOString()}: ${d0?.at.toISOString()}`);
      const d1 = await checklists.itemDue(1, T.A, now);
      assert.ok(d1 && d1.date > d0!.date, `one business day later than "the day it's added" at ${now.toISOString()}`);
    }
  });
});

describe("added automatically", () => {
  let seq = 0;
  async function publishedType(steps: HdWorkflowStepB[] | null, team = "A") {
    const n = ++seq;
    let wfId: number | null = null;
    if (steps) {
      const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} Flow ${n}` });
      const def = workflows.parseWorkflowDefinition({ steps });
      assert.ok(def.ok, !def.ok ? def.error : "");
      if (!meta.ok || !def.ok) throw new Error("bad fixture");
      const wf = await workflows.createWorkflow(meta.value, def.value);
      workflowIds.push(wf.id);
      wfId = wf.id;
    }
    const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Type ${n}`, team_id: T[team], workflow_id: wfId });
    assert.ok(input.ok, !input.ok ? input.error : "");
    if (!input.ok) throw new Error("bad fixture");
    const rt = await requestTypes.createRequestType(input.value);
    typeIds.push(rt.id);
    if (wfId) {
      const pub = await workflows.publishWorkflow(wfId);
      assert.ok(pub.ok, !pub.ok ? pub.error : "");
    }
    return { workflowId: wfId, typeId: rt.id };
  }
  async function raise(typeId: number) {
    const t = await tickets.createTicket(
      { subject: `${STAMP} request`, body: "Hello", requester: { id: P.req.id, name: P.req.name, email: `${STAMP}-req@example.test` }, request_type_id: typeId },
      { silent: true, actorId: P.req.id, actorName: P.req.name }
    );
    ticketIds.push(t.id);
    return t;
  }

  test("by a request type: every new request of the type gets it, once; the list names the type", async () => {
    const { typeId } = await publishedType(null);
    const id = await template("Office move", [{ title: "Book the movers", required: true }], { request_type_ids: [typeId] });
    const t = await raise(typeId);
    const lists = await checklists.ticketChecklists(t.id);
    assert.deepEqual(lists.map((c) => [c.name, c.source]), [[`Office move ${STAMP}`, "request_type"]]);
    assert.match((await lines(t.id)).find((l) => /added the checklist/.test(l.body))!.body, /^The request type .* added the checklist/);
    assert.equal(await checklists.addRequestTypeChecklists(t.id), 0, "a second run adds nothing");
    const row = (await checklists.listTemplateRows()).find((r) => r.id === id)!;
    assert.deepEqual(row.added_to, [`Request type ${STAMP} Type ${seq}`]);
    assert.equal(row.used, 1);
  });

  test("by a workflow task: the task's ticket gets it; Mark done waits for required items, can't be done doesn't; Finish leaves the request open", async () => {
    const tplId = await template("New starter: IT", [{ title: "Create the account", required: true }, { title: "Image the laptop" }]);
    const reqTpl = await template("Request wrap-up", [{ title: "Confirm with the manager", required: true }]);
    const bad = workflows.parseWorkflowDefinition({ steps: [{ key: "t", kind: "task", title: "Laptop", team_id: T.A, checklist_ids: "x" }] });
    assert.equal(bad.ok, false);
    const missing = await workflows.checkWorkflowRefs({ trigger: {}, steps: [{ key: "t", kind: "task", title: "Laptop", team_id: T.A, checklist_ids: [99999999] } as never] });
    assert.equal(missing.ok, false);
    assert.match(!missing.ok ? missing.error : "", /no longer exists/);
    const { typeId, workflowId } = await publishedType([
      { key: "laptop", kind: "task", title: "Laptop and accounts", team_id: T.A, checklist_ids: [tplId] } as HdWorkflowStepB,
      { key: "done", kind: "finish", title: "Done", csat: false },
    ]);
    await checklists.updateTemplate(reqTpl, { request_type_ids: [typeId] });
    const t = await raise(typeId);
    const child = (await pool().query("SELECT id, number FROM hd_tickets WHERE parent_ticket_id = $1", [t.id])).rows[0];
    assert.ok(child, "the task started");
    const onTask = await checklists.ticketChecklists(child.id);
    assert.deepEqual(onTask.map((c) => [c.name, c.source]), [[`New starter: IT ${STAMP}`, "workflow"]]);
    const row = (await checklists.listTemplateRows()).find((r) => r.id === tplId)!;
    assert.deepEqual(row.added_to, [`${STAMP} Flow ${seq} workflow · task Laptop and accounts`]);
    const del = await checklists.deleteTemplate(tplId).catch((e: Error) => e);
    assert.match(String((del as Error).message), /workflow adds it in "Laptop and accounts"/, "a template a workflow adds can't be deleted");

    const out = (body: unknown) => call(outcomeRoute.POST, req(`/tickets/${child.number}/task-outcome`, P.agent.session, body), { number: String(child.number) });
    const refused = await out({ outcome: "done" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /^Finish the required checklist items first: "Create the account"/);
    assert.equal((await solve("agent", child.number)).status, 409, "solving the task ticket is refused too");
    await checklists.setItemDone(child.id, onTask[0].items[0].id, true, { id: P.agent.id, name: P.agent.name });
    const done = await out({ outcome: "done" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(await statusOf(child.id), "solved");
    // The run reached Finish, but the request's own required item is open: it stays open with a note.
    const run = (await pool().query("SELECT state FROM hd_workflow_runs WHERE ticket_id = $1", [t.id])).rows[0];
    assert.equal(run.state, "done");
    assert.notEqual(await statusOf(t.id), "solved");
    assert.ok((await lines(t.id)).some((l) => l.kind === "internal" && /^The workflow has finished, but the request stays open: Finish the required checklist items first/.test(l.body)));
    // Review fix: the request's owner (else its team) hears of it, and the Finish step's survey choice is kept for the later solve.
    const owner = (await pool().query("SELECT assignee_id FROM hd_tickets WHERE id = $1", [t.id])).rows[0].assignee_id as number | null;
    const told = await pool().query("SELECT user_id FROM notifications WHERE title = $1", [`Checklist to finish on #${t.number}`]);
    const expected = owner ? [owner] : [P.agent.id, P.agent2.id, P.newbie.id];
    assert.ok(told.rows.length > 0 && told.rows.every((r) => expected.includes(r.user_id)), JSON.stringify(told.rows));
    assert.equal(await checklists.heldFinishCsat(t.id), false);
    const reqItem = (await checklists.ticketChecklists(t.id))[0].items[0];
    await checklists.setItemDone(t.id, reqItem.id, true, { id: P.agent.id, name: P.agent.name });
    assert.equal((await solve("agent", t.number)).status, 200);

    // Can't be done is never held up by the checklist.
    const t2 = await raise(typeId);
    const child2 = (await pool().query("SELECT id, number FROM hd_tickets WHERE parent_ticket_id = $1", [t2.id])).rows[0];
    const cant = await call(outcomeRoute.POST, req(`/tickets/${child2.number}/task-outcome`, P.agent.session, { outcome: "cant_do", note: "No laptops in stock" }), {
      number: String(child2.number),
    });
    assert.equal(cant.status, 200, JSON.stringify(cant.body));
    assert.equal(await statusOf(child2.id), "solved");

    // Review fix: the run of t2 is on hold (live) and its pinned definition adds the template, so it
    // can't be deleted even once the published workflow no longer names it.
    assert.equal((await pool().query("SELECT state FROM hd_workflow_runs WHERE ticket_id = $1", [t2.id])).rows[0].state, "blocked");
    await pool().query(
      `UPDATE hd_workflows SET definition = jsonb_set(definition, '{steps,0}', (definition->'steps'->0) - 'checklist_ids'), draft = NULL WHERE id = $1`,
      [workflowId]
    );
    const delLive = await checklists.deleteTemplate(tplId).catch((e: Error) => e);
    assert.match(String((delLive as Error).message), /on its way still adds it/);
    void engine;
    void workflowId;
  });
});

// 1.19.4 follow-up: the ten-a-ticket limit is for adding, as with assets.
describe("more than ten checklists after a merge (1.19.4)", () => {
  test("a merge moves all of them (6 + 7 = 13); the card lists 13, the solve gate counts every one, adding is refused at ten or more", async () => {
    const tpls: number[] = [];
    for (let i = 0; i < 13; i++) tpls.push(await template(`Many ${i}`, [{ title: `Step ${i}`, required: true }]));
    const keep = await ticket("Many keep");
    const dup = await ticket("Many dup");
    const who = { id: P.agent.id, name: P.agent.name };
    for (const id of tpls.slice(0, 6)) await checklists.addChecklistToTicket(keep.id, id, who);
    for (const id of tpls.slice(6)) await checklists.addChecklistToTicket(dup.id, id, who);
    await merge.mergeTickets({ id: P.agent.id, role: "viewer", name: P.agent.name }, { keep: keep.number, merge: [dup.number], notify: false });
    const kept = await checklists.ticketChecklists(keep.id);
    assert.equal(kept.length, 13, "every checklist moved, past the limit");
    assert.equal((await checklists.ticketChecklists(dup.id)).length, 0);

    // The card: all 13, still editable (a closed ticket would not be).
    const v = await view("agent", keep.number);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.checklists.length, 13);
    assert.equal(v.body.can_edit, true);
    assert.match(v.body.solve_block, /"Step 0", "Step 1", "Step 2" and 10 more\.$/);

    // Adding by hand: refused at ten or more, with the sentence the card's tooltip uses.
    const extra = await template("Many extra", [{ title: "Extra" }]);
    await assert.rejects(checklists.addChecklistToTicket(keep.id, extra, who), /A ticket holds up to 10 checklists\./);

    // The solve gate counts the 13th checklist's item too.
    for (const c of kept.slice(0, 12)) for (const i of c.items) assert.equal((await tick("agent", keep.number, i.id, true)).status, 200);
    let refused = await solve("agent", keep.number);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /"Step 12"\.$/);
    await tick("agent", keep.number, kept[12].items[0].id, true);
    refused = await solve("agent", keep.number);
    assert.equal(refused.status, 200, JSON.stringify(refused.body));

    // The route answers the same 409 (the card disables Add with this sentence).
    const viaRoute = await call(ticketListsRoute.POST, req(`/tickets/${keep.number}/checklists`, P.agent.session, { template_id: extra }), { number: String(keep.number) });
    assert.equal(viaRoute.status, 409);
    assert.equal(viaRoute.body.error, "A ticket holds up to 10 checklists.");
  });

  test("an automatic addition on a full ticket says which checklist wasn't added and why (not that it no longer exists)", async () => {
    const t = await ticket("Full task");
    const who = { id: P.agent.id, name: P.agent.name };
    for (let i = 0; i < 10; i++) await checklists.addChecklistToTicket(t.id, await template(`Full ${i}`, [{ title: `F${i}` }]), who);
    const late = await template("Late task list", [{ title: "Late" }]);
    await withTx((c) => checklists.addTaskChecklistsTx(c, t.id, [late], "laptop", new Date()));
    assert.equal((await checklists.ticketChecklists(t.id)).length, 10);
    const last = (await lines(t.id)).at(-1)!;
    assert.equal(last.body, `The workflow didn't add the checklist "Late task list ${STAMP}": a ticket holds up to 10 checklists. An agent can remove one and add it by hand.`);
    assert.ok(!(await lines(t.id)).some((l) => /no longer exists/.test(l.body)));
    const r = await withTx((c) => checklists.addChecklistTx(c, t.id, late, null, { source: "request_type", byLine: "The request type Laptop" }));
    assert.deepEqual(r && { full: r.full, id: r.checklist_id }, { full: true, id: 0 });
  });
});

// 1.19.4 review: names and titles in system-written notes are Markdown-escaped.
describe("checklist notes show names as text (1.19.4 review: Markdown)", () => {
  test("a checklist and an item named like a link make no link in the timeline", async () => {
    const { fromMarkdown } = await import("mdast-util-from-markdown");
    const { gfm } = await import("micromark-extension-gfm");
    const { gfmFromMarkdown } = await import("mdast-util-gfm");
    const { directive } = await import("micromark-extension-directive");
    const { directiveFromMarkdown } = await import("mdast-util-directive");
    const types = (md: string) => {
      const out = new Set<string>();
      const walk = (n: { type: string; children?: { type: string }[] }) => {
        out.add(n.type);
        for (const c of n.children ?? []) walk(c);
      };
      walk(fromMarkdown(md, { extensions: [gfm(), directive()], mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown()] }) as never);
      return out;
    };
    const tpl = await template("[Reset here](https://evil.example/x) **now**", [{ title: "Step" }]);
    const t = await ticket("Evil checklist");
    await checklists.addChecklistToTicket(t.id, tpl, { id: P.agent.id, name: P.agent.name });
    const c = (await checklists.ticketChecklists(t.id))[0];
    await checklists.addItem(t.id, c.id, "see www.evil.example or <b>ops@evil.example</b>", { id: P.agent.id, name: P.agent.name });
    for (const l of (await lines(t.id)).slice(-2)) {
      const ty = types(l.body);
      for (const k of ["link", "strong", "emphasis", "html"]) assert.ok(!ty.has(k), `${k}: ${l.body}`);
    }
  });
});
