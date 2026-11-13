// Helpdesk 1.20.5 "Before you solve" requirement sets (lib/helpdesk/
// solve-requirements): the checks (scope, the refusal sentence), the settings
// routes (who may, validation, limits, audit), each requirement kind, the
// answers stored atomically with the solve, every solver (the desk's PATCH,
// Send and set Solved, a macro, an automation, bulk edit, the REST API, the
// Claude connector, a workflow's Finish step), what is never asked (solved →
// closed, a merge, a workflow task, a newbie's held reply), reopening and
// solving again, a set edited or deleted after tickets were solved, the
// ticket.solved webhook payload, and anonymising.
//
// Same harness as test/helpdesk-checklists: next/headers and lib/ee stubbed,
// routes called with real sessions. Parallel-safe on a shared database: every
// set this file switches on is scoped to this file's own teams (STAMP), so no
// other run's tickets are ever asked for anything; "all tickets" is tested
// through the pure check and a hand-made snapshot. Sets are deleted at the end.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-solve-requirements.test.ts

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-solve-requirements.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-solve-requirements.virtual.js");
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
const sr = require("../src/lib/helpdesk/solve-requirements") as typeof import("../src/lib/helpdesk/solve-requirements");
const shared = require("../src/lib/helpdesk/solve-requirements-shared") as typeof import("../src/lib/helpdesk/solve-requirements-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const macros = require("../src/lib/helpdesk/macros") as typeof import("../src/lib/helpdesk/macros");
const automations = require("../src/lib/helpdesk/automations") as typeof import("../src/lib/helpdesk/automations");
const checklists = require("../src/lib/helpdesk/checklists") as typeof import("../src/lib/helpdesk/checklists");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const time = require("../src/lib/helpdesk/time") as typeof import("../src/lib/helpdesk/time");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const hooks = require("../src/lib/helpdesk/webhooks") as typeof import("../src/lib/helpdesk/webhooks");
const claude = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const withTx = (require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core")).withTx;
const adminRoute = require("../src/app/api/helpdesk/admin/solve-requirements/route") as typeof import("../src/app/api/helpdesk/admin/solve-requirements/route");
const adminOneRoute = require("../src/app/api/helpdesk/admin/solve-requirements/[id]/route") as typeof import("../src/app/api/helpdesk/admin/solve-requirements/[id]/route");
const checkRoute = require("../src/app/api/helpdesk/tickets/[number]/solve-requirements/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/solve-requirements/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const bulkRoute = require("../src/app/api/helpdesk/tickets/bulk/route") as typeof import("../src/app/api/helpdesk/tickets/bulk/route");
const macroRoute = require("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route");
const requestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
const tokensRoute = require("../src/app/api/helpdesk/admin/api/tokens/route") as typeof import("../src/app/api/helpdesk/admin/api/tokens/route");
const v1TicketRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/route");
const v1RepliesRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/replies/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/replies/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdFormField, HdWorkflowStepB } from "../src/lib/helpdesk/types";

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

const STAMP = `hdsr-${Date.now()}-${process.pid}`;
const P: Record<string, { id: number; session: string; name: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const setIds: number[] = [];
const typeIds: number[] = [];
const workflowIds: number[] = [];
const ticketIds: number[] = [];
const tokenIds: number[] = [];
const hookIds: number[] = [];
let RT = 0;

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

async function ticket(subject: string, team: string | null = "A", status = "open", extra: { source?: string; request_type_id?: number | null } = {}): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source, request_type_id) VALUES ($1, $2, 'Req', $3, $4, $5, $6, $7) RETURNING id, number",
    [`${subject} ${STAMP}`, P.req.id, `${STAMP}-req@example.test`, team ? T[team] : null, status, extra.source ?? "portal", extra.request_type_id ?? null]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

const CLOSING: HdFormField[] = [
  {
    key: "resolution_code",
    label: "Resolution code",
    type: "choice",
    required: true,
    options: [
      { value: "fixed", label: "Fixed" },
      { value: "workaround", label: "Workaround given" },
      { value: "no_fault", label: "No fault found" },
    ],
  },
  { key: "root_cause", label: "Root cause", type: "textarea", required: true },
  { key: "follow_up", label: "Follow up on", type: "date" },
  { key: "checked_by", label: "Checked by", type: "user" },
  { key: "billable", label: "Billable", type: "checkbox" },
];

/** A switched-on set, scoped to this file's team A unless the input says otherwise. */
async function makeSet(input: Record<string, unknown>): Promise<number> {
  const s = await sr.createSolveSet({ name: `${STAMP} set ${setIds.length + 1}`, enabled: true, team_ids: [T.A], ...input }, { id: P.admin.id });
  setIds.push(s.id);
  return s.id;
}
/** Run `fn` with a set on, then delete it, so one test's set never asks another test's tickets. */
async function withSet<R>(input: Record<string, unknown>, fn: (setId: number) => Promise<R>): Promise<R> {
  const id = await makeSet(input);
  try {
    return await fn(id);
  } finally {
    await sr.deleteSolveSet(id);
  }
}

const lines = async (ticketId: number) =>
  (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows as { kind: string; body: string }[];
const auditRows = async (action: string, actor: number) =>
  (await pool().query("SELECT details FROM audit_log WHERE action = $1 AND actor_id = $2 ORDER BY id", [action, actor])).rows.map((r) => r.details);
const rowOf = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const statusOf = async (id: number) => (await rowOf(id)).status as string;
const answersOf = async (id: number) =>
  (await pool().query("SELECT set_id, field_key, label, type, value, display, answered_by_name FROM hd_ticket_solve_answers WHERE ticket_id = $1 ORDER BY set_id, position", [id])).rows as {
    set_id: number;
    field_key: string;
    label: string;
    type: string;
    value: unknown;
    display: string;
    answered_by_name: string;
  }[];
const patch = (who: string, n: number, body: Record<string, unknown>) => call(ticketRoute.PATCH, req(`/tickets/${n}`, P[who].session, body, "PATCH"), { number: String(n) });
const send = (who: string, n: number, body: Record<string, unknown>) => call(messagesRoute.POST, req(`/tickets/${n}/messages`, P[who].session, body), { number: String(n) });
const actor = () => ({ id: P.agent.id, name: P.agent.name });
const GOOD = { resolution_code: "fixed", root_cause: "The VPN profile had expired." };

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  email.setHelpdeskTransportForTests(async () => {});
  hooks.setWebhookAutoSendForTests(false);
  for (const k of ["A", "B"]) {
    const r = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9410) RETURNING id", [`${STAMP} ${k}`]);
    T[k] = r.rows[0].id;
  }
  await person("agent", "agent");
  await person("agent2", "agent");
  await person("newbie", "newbie");
  await person("other", "agent");
  await person("admin", "manager");
  await person("dadmin", "admin");
  await person("req", null);
  await pool().query(
    "INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($1, $4, 'agent'), ($5, $6, 'agent'), ($5, $2, 'agent')",
    [T.A, P.agent.id, P.agent2.id, P.newbie.id, T.B, P.other.id]
  );
  RT = (await fixtureQuery("INSERT INTO hd_request_types (slug, title, team_id, form, position) VALUES ($1, $2, $3, '[]', 999) RETURNING id", [`${STAMP}-vpn`, `${STAMP} VPN access`, T.A])).rows[0].id;
  typeIds.push(RT);
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  claude.setClaudeLevelForTests(null);
  email.setHelpdeskTransportForTests(null);
  hooks.setWebhookAutoSendForTests(true);
  await pool().query("DELETE FROM hd_solve_requirement_sets WHERE id = ANY($1) OR name LIKE $2", [setIds, `%${STAMP}%`]);
  sr.invalidateSolveSets();
  const children = await pool().query("SELECT id FROM hd_tickets WHERE parent_ticket_id = ANY($1) OR team_id = ANY($2)", [ticketIds, Object.values(T)]);
  const all = [...new Set([...ticketIds, ...children.rows.map((r) => r.id as number)])];
  await pool().query("DELETE FROM hd_webhooks WHERE id = ANY($1) OR name LIKE $2", [hookIds, `${STAMP}%`]);
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL, merged_into = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1)", [workflowIds]);
  await pool().query("DELETE FROM hd_checklist_templates WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_macros WHERE title LIKE $1", [`${STAMP}%`]);
  await pool().query("DELETE FROM hd_assets WHERE provider = $1", [`${STAMP}`]);
  await pool().query("DELETE FROM hd_api_tokens WHERE id = ANY($1) OR name LIKE $2", [tokenIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

describe("checks (pure)", () => {
  test("a set needs a name; ids are lists of ids; ticket fields are the known ones, kept in the listed order", () => {
    assert.equal(shared.checkSolveSetInput(null).ok, false);
    assert.equal(shared.checkSolveSetInput({ name: "  " }).ok, false);
    assert.equal(shared.checkSolveSetInput({ name: "x".repeat(81) }).ok, false);
    assert.equal(shared.checkSolveSetInput({ name: "IT", team_ids: ["1"] }).ok, false);
    assert.equal(shared.checkSolveSetInput({ name: "IT", request_type_ids: Array.from({ length: 51 }, (_, i) => i + 1) }).ok, false);
    assert.equal(shared.checkSolveSetInput({ name: "IT", ticket_fields: ["priority"] }).ok, false);
    assert.equal(shared.checkSolveSetInput({ name: "IT", enabled: "yes" }).ok, false);
    const ok = shared.checkSolveSetInput({ name: " IT  closing ", ticket_fields: ["time", "assignee", "time", "tag"], team_ids: [3, 3, 4] });
    assert.ok(ok.ok);
    assert.deepEqual(ok.ok && ok.value, { name: "IT closing", enabled: false, team_ids: [3, 4], request_type_ids: [], ticket_fields: ["assignee", "tag", "time"] });
  });

  test("scope: nothing chosen is every ticket; teams, request types, or both (then both must match)", () => {
    const m = shared.solveSetMatches;
    assert.equal(m({ team_ids: [], request_type_ids: [] }, { team_id: null, request_type_id: null }), true);
    assert.equal(m({ team_ids: [], request_type_ids: [] }, { team_id: 7, request_type_id: 9 }), true);
    assert.equal(m({ team_ids: [7], request_type_ids: [] }, { team_id: 7, request_type_id: null }), true);
    assert.equal(m({ team_ids: [7], request_type_ids: [] }, { team_id: 8, request_type_id: null }), false);
    assert.equal(m({ team_ids: [7], request_type_ids: [] }, { team_id: null, request_type_id: null }), false);
    assert.equal(m({ team_ids: [], request_type_ids: [9] }, { team_id: 1, request_type_id: 9 }), true);
    assert.equal(m({ team_ids: [], request_type_ids: [9] }, { team_id: 1, request_type_id: null }), false);
    assert.equal(m({ team_ids: [7], request_type_ids: [9] }, { team_id: 7, request_type_id: 9 }), true);
    assert.equal(m({ team_ids: [7], request_type_ids: [9] }, { team_id: 7, request_type_id: 4 }), false);
    assert.equal(m({ team_ids: [7], request_type_ids: [9] }, { team_id: 2, request_type_id: 9 }), false);
    assert.equal(shared.solveScopeLabel({ team_ids: [], request_type_ids: [] }, [], []), "All tickets");
    assert.equal(shared.solveScopeLabel({ team_ids: [7], request_type_ids: [9] }, [{ id: 7, name: "IT" }], [{ id: 9, title: "VPN access" }]), "IT · VPN access");
  });

  test("the refusal sentence names up to four things; solving is leaving the open statuses", () => {
    const tf = (field: "assignee" | "asset" | "time" | "reply") => ({ kind: "ticket_field" as const, field, label: shared.SOLVE_TICKET_FIELD_LABEL[field] });
    const cf = (label: string) => ({ kind: "closing_field" as const, set_id: 1, set_name: "IT", key: label.toLowerCase(), label });
    assert.equal(shared.solveBlockMessage([tf("assignee")]), "Before you solve, this ticket needs: an owner.");
    assert.equal(shared.solveBlockMessage([tf("assignee"), tf("asset"), cf("Resolution code"), cf("Root cause")]), "Before you solve, this ticket needs: an owner, a linked asset, Resolution code and Root cause.");
    const five = shared.solveBlockMessage([tf("assignee"), tf("asset"), tf("time"), cf("Resolution code"), cf("Root cause"), cf("Notes")]);
    assert.equal(five, "Before you solve, this ticket needs: an owner, a linked asset, time logged, Resolution code and 2 more.");
    assert.ok(shared.isSolveRequirementBlock(five));
    assert.ok(!shared.isSolveRequirementBlock('Finish the required checklist items first: "x".'));
    assert.equal(shared.solvesForRequirements("open", "solved"), true);
    assert.equal(shared.solvesForRequirements("pending", "closed"), true);
    assert.equal(shared.solvesForRequirements("solved", "closed"), false);
    assert.equal(shared.solvesForRequirements("open", "pending"), false);
  });

  test("a set for every ticket (a hand-made snapshot): any ticket is asked, a workflow task never is; an asset only while a source is connected", async () => {
    const all = { id: 999_999_001, name: "Everything", enabled: true, team_ids: [], request_type_ids: [], ticket_fields: ["assignee", "asset"] as const, fields: [], created_at: "", updated_at: "" };
    const facts = { id: 0, team_id: null, request_type_id: null, assignee_id: null, category: "", tags: [], first_replied_at: null, source: "email" };
    const on = await sr.evaluateSolve({ sets: [{ ...all, ticket_fields: [...all.ticket_fields] }], assetsOn: true }, facts);
    assert.deepEqual(on.missing.map((m) => (m.kind === "ticket_field" ? m.field : m.key)), ["assignee", "asset"]);
    const off = await sr.evaluateSolve({ sets: [{ ...all, ticket_fields: [...all.ticket_fields] }], assetsOn: false }, facts);
    assert.deepEqual(off.missing.map((m) => (m.kind === "ticket_field" ? m.field : m.key)), ["assignee"], "no source connected: the asset isn't asked for");
    const task = await sr.evaluateSolve({ sets: [{ ...all, ticket_fields: [...all.ticket_fields] }], assetsOn: true }, { ...facts, source: "workflow" });
    assert.equal(task.applies, false);
    const none = await sr.evaluateSolve({ sets: [], assetsOn: false }, facts);
    assert.equal(none.applies, false);
  });
});

describe("settings (Desk settings → Before you solve)", () => {
  test("a desk admin creates, edits, switches on and deletes; an agent may not; validation and limits; audited", async () => {
    const forbidden = await call(adminRoute.POST, req("/admin/solve-requirements", P.agent.session, { name: "Nope" }));
    assert.equal(forbidden.status, 403);
    assert.equal((await call(adminRoute.POST, req("/admin/solve-requirements", P.admin.session, { name: "Nope" }))).status, 403, "a Manager without settings.manage may not either");
    assert.equal((await call(adminRoute.GET, req("/admin/solve-requirements", P.agent.session))).status, 403);

    const made = await call(adminRoute.POST, req("/admin/solve-requirements", P.dadmin.session, { name: `${STAMP} IT closing details` }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.set.id as number;
    setIds.push(id);
    assert.equal(made.body.set.enabled, false, "a new set starts switched off");

    const put = (body: unknown) => call(adminOneRoute.PUT, req(`/admin/solve-requirements/${id}`, P.dadmin.session, body, "PUT"), { id: String(id) });
    const empty = await put({ enabled: true });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "Add at least one requirement before you switch the set on.");
    assert.equal((await put({ team_ids: [999_999_999] })).status, 400, "an unknown team");
    assert.equal((await put({ request_type_ids: [999_999_999] })).status, 400, "an unknown request type");
    assert.equal((await put({ ticket_fields: ["priority"] })).status, 400);
    const badField = await put({ fields: [{ key: "x", label: "X", type: "colour" }] });
    assert.equal(badField.status, 400);
    assert.match(badField.body.error, /unknown type/);
    const noOptions = await put({ fields: [{ key: "code", label: "Code", type: "choice" }] });
    assert.match(noOptions.body.error, /needs at least one option/);
    const many = await put({ fields: Array.from({ length: 21 }, (_, i) => ({ key: `f${i}`, label: `F ${i}`, type: "text" })) });
    assert.equal(many.status, 400);
    assert.equal(many.body.error, "A requirement set has up to 20 closing fields.");

    const ok = await put({ enabled: true, team_ids: [T.A], request_type_ids: [RT], ticket_fields: ["reply", "assignee"], fields: [{ ...CLOSING[0], default_from: "directory:office" }, CLOSING[1]] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.set.ticket_fields, ["assignee", "reply"]);
    assert.equal(ok.body.set.fields[0].default_from, undefined, "a closing field has no directory prefill");
    assert.equal(ok.body.set.enabled, true);

    const list = await call(adminRoute.GET, req("/admin/solve-requirements", P.dadmin.session));
    assert.equal(list.status, 200);
    const mine = list.body.sets.find((s: { id: number }) => s.id === id);
    assert.equal(mine.name, `${STAMP} IT closing details`);
    assert.equal(mine.answered, 0);
    assert.ok(list.body.teams.some((t: { id: number }) => t.id === T.A));
    assert.ok(list.body.ticket_fields.includes("assignee") && list.body.ticket_fields.includes("time"));

    assert.equal((await call(adminOneRoute.DELETE, req(`/admin/solve-requirements/${id}`, P.agent.session, undefined, "DELETE"), { id: String(id) })).status, 403);
    const del = await call(adminOneRoute.DELETE, req(`/admin/solve-requirements/${id}`, P.dadmin.session, undefined, "DELETE"), { id: String(id) });
    assert.equal(del.status, 200);
    assert.equal((await put({ name: "gone" })).status, 404);

    assert.equal((await auditRows("helpdesk.solve_requirements.created", P.dadmin.id)).length, 1);
    const updated = await auditRows("helpdesk.solve_requirements.updated", P.dadmin.id);
    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0].changed, ["enabled", "team_ids", "request_type_ids", "ticket_fields", "fields"]);
    assert.deepEqual(updated[0].closing_fields, ["Resolution code", "Root cause"]);
    assert.equal((await auditRows("helpdesk.solve_requirements.deleted", P.dadmin.id)).length, 1);
  });

  test("with no set that asks for anything, a solve costs one cached lookup: the snapshot is reused, and a save clears it", async () => {
    const a = await sr.solveSetsSnapshot();
    const b = await sr.solveSetsSnapshot();
    assert.equal(a, b, "the same object: nothing was read again");
    const id = await makeSet({ ticket_fields: ["assignee"] });
    const c = await sr.solveSetsSnapshot();
    assert.notEqual(c, a);
    assert.ok(c.sets.some((s) => s.id === id));
    await sr.updateSolveSet(id, { enabled: false });
    assert.ok(!(await sr.solveSetsSnapshot()).sets.some((s) => s.id === id), "a set switched off is not in the snapshot");
    await sr.deleteSolveSet(id);
  });
});

describe("ticket fields that must be set", () => {
  test("an owner, a category, a tag, time logged and a reply: the sentence names what is missing, and each drops out as it is set", async () => {
    await withSet({ ticket_fields: ["assignee", "category", "tag", "time", "reply"] }, async () => {
      const t = await ticket("Fields");
      const s = await patch("agent", t.number, { status: "solved" });
      assert.equal(s.status, 409);
      assert.equal(s.body.code, "solve_requirements");
      assert.equal(s.body.error, "Before you solve, this ticket needs: an owner, a category, at least one tag, time logged and 1 more.");
      assert.deepEqual(s.body.missing.map((m: { field: string }) => m.field), ["assignee", "category", "tag", "time", "reply"]);
      assert.equal(await statusOf(t.id), "open");

      const needs = async () => ((await sr.solveRequirementRefusal(t.id))?.missing ?? []).map((m) => (m.kind === "ticket_field" ? m.field : m.key));
      await tickets.updateTicket(t.id, { assignee_id: P.agent.id }, actor());
      assert.deepEqual(await needs(), ["category", "tag", "time", "reply"]);
      await tickets.updateTicket(t.id, { category: "Network" }, actor());
      assert.deepEqual(await needs(), ["tag", "time", "reply"]);
      await tickets.updateTicket(t.id, { tags: ["vpn"] }, actor());
      assert.deepEqual(await needs(), ["time", "reply"]);
      await time.logTime(P.agent.id, t.id, 20, "");
      assert.deepEqual(await needs(), ["reply"]);
      // A newbie's reply is held for review: not sent, so it doesn't count yet.
      const held = await messages.addMessage(t.id, { kind: "public", body: "Try it now?", author: { id: P.newbie.id, name: P.newbie.name, email: "" }, via: "desk" });
      assert.equal(held?.held, true);
      assert.deepEqual(await needs(), ["reply"]);
      await messages.addMessage(t.id, { kind: "public", body: "Fixed, try it now.", author: { id: P.agent.id, name: P.agent.name, email: "" }, via: "desk" });
      assert.deepEqual(await needs(), []);
      const ok = await patch("agent", t.number, { status: "solved" });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(await statusOf(t.id), "solved");
    });
  });

  test("the fields can be set in the same change as the solve; a ticket of another team, or another request type, is not asked", async () => {
    await withSet({ ticket_fields: ["assignee", "tag"] }, async () => {
      const t = await ticket("Same step");
      const s = await patch("agent", t.number, { status: "solved", assignee_id: P.agent.id, tags: ["vpn"] });
      assert.equal(s.status, 200, JSON.stringify(s.body));
      assert.deepEqual(s.body.changed.sort(), ["assignee_id", "status", "tags"]);
      const b = await ticket("Other team", "B");
      assert.equal((await patch("agent", b.number, { status: "solved" })).status, 200, "team B has no set");
    });
    await withSet({ team_ids: [], request_type_ids: [RT], ticket_fields: ["team", "assignee"] }, async () => {
      const plain = await ticket("No type");
      assert.equal(await sr.solveRequirementRefusal(plain.id), null, "not of the request type");
      const typed = await ticket("Typed", null, "open", { request_type_id: RT });
      const r = await sr.solveRequirementRefusal(typed.id);
      assert.equal(r?.error, "Before you solve, this ticket needs: an owner and a team.");
      assert.equal(await sr.solveRequirementRefusal(typed.id, { patch: { team_id: T.A, assignee_id: P.agent.id } }), null);
    });
    await withSet({ team_ids: [T.A], request_type_ids: [RT], ticket_fields: ["assignee"] }, async () => {
      const typedB = await ticket("Typed in B", "B", "open", { request_type_id: RT });
      assert.equal(await sr.solveRequirementRefusal(typedB.id), null, "both chosen: the team doesn't match");
      const typedA = await ticket("Typed in A", "A", "open", { request_type_id: RT });
      assert.ok(await sr.solveRequirementRefusal(typedA.id));
    });
  });

  test("a linked asset: asked while an asset source is connected, met once one is linked", async () => {
    const t = await ticket("Asset");
    const snap = { sets: [{ id: 999_999_002, name: "Assets", enabled: true, team_ids: [T.A], request_type_ids: [], ticket_fields: ["asset" as const], fields: [], created_at: "", updated_at: "" }], assetsOn: true };
    assert.equal((await sr.solveRequirementRefusal(t.id, { snapshot: snap }))?.error, "Before you solve, this ticket needs: a linked asset.");
    const a = await pool().query("INSERT INTO hd_assets (provider, external_id, tag, name) VALUES ($1, '1', 'MBP-014', 'MacBook Pro 14') RETURNING id", [STAMP]);
    await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id) VALUES ($1, $2)", [t.id, a.rows[0].id]);
    assert.equal(await sr.solveRequirementRefusal(t.id, { snapshot: snap }), null);
  });
});

describe("closing fields the agent fills in", () => {
  test("refused without them (nothing saved); a bad answer is 400; with them it solves and they are stored with the words they were asked in", async () => {
    await withSet({ fields: CLOSING }, async (setId) => {
      const t = await ticket("Closing");
      const none = await patch("agent", t.number, { status: "solved" });
      assert.equal(none.status, 409);
      assert.equal(none.body.error, "Before you solve, this ticket needs: Resolution code and Root cause.");
      assert.deepEqual(none.body.missing, [
        { kind: "closing_field", set_id: setId, set_name: `${STAMP} set ${setIds.length}`, key: "resolution_code", label: "Resolution code" },
        { kind: "closing_field", set_id: setId, set_name: `${STAMP} set ${setIds.length}`, key: "root_cause", label: "Root cause" },
      ]);
      const half = await patch("agent", t.number, { status: "solved", solve_answers: { resolution_code: "fixed" } });
      assert.equal(half.status, 409);
      assert.equal(half.body.error, "Before you solve, this ticket needs: Root cause.");
      assert.deepEqual(await answersOf(t.id), [], "a refused solve saves nothing");

      const bad = await patch("agent", t.number, { status: "solved", solve_answers: { ...GOOD, resolution_code: "magic" } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, '"Resolution code" must be one of its options.');
      assert.equal(bad.body.code, "solve_requirements");
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: { ...GOOD, follow_up: "2026-02-31" } })).body.error, '"Follow up on" must be a date.');
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: { ...GOOD, checked_by: 999_999_999 } })).body.error, '"Checked by" must be a person in this workspace.');
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: "fixed" })).status, 400);
      assert.equal(await statusOf(t.id), "open");
      assert.deepEqual(await answersOf(t.id), []);

      // The dialog's check before it submits: the same read, nothing stored.
      const check = await call(checkRoute.POST, req(`/tickets/${t.number}/solve-requirements`, P.agent.session, { solve_answers: GOOD }), { number: String(t.number) });
      assert.equal(check.status, 200, JSON.stringify(check.body));
      assert.deepEqual(check.body.missing, []);
      assert.equal(check.body.optional_open, 3);
      assert.deepEqual(await answersOf(t.id), []);
      const view = await call(checkRoute.GET, req(`/tickets/${t.number}/solve-requirements`, P.agent.session), { number: String(t.number) });
      assert.equal(view.body.applies, true);
      assert.equal(view.body.sets[0].fields.length, 5);
      assert.equal(view.body.error, "Before you solve, this ticket needs: Resolution code and Root cause.");
      assert.equal((await call(checkRoute.GET, req(`/tickets/${t.number}/solve-requirements`, P.other.session), { number: String(t.number) })).status, 404, "another team's agent");

      const before = (await lines(t.id)).length;
      const ok = await patch("agent", t.number, {
        status: "solved",
        solve_answers: { ...GOOD, follow_up: "2026-12-01", checked_by: P.agent2.id, billable: true, not_a_field: "ignored" },
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(await statusOf(t.id), "solved");
      assert.deepEqual(
        (await answersOf(t.id)).map((a) => [a.field_key, a.label, a.type, a.value, a.display]),
        [
          ["resolution_code", "Resolution code", "choice", "fixed", "Fixed"],
          ["root_cause", "Root cause", "textarea", "The VPN profile had expired.", "The VPN profile had expired."],
          ["follow_up", "Follow up on", "date", "2026-12-01", "2026-12-01"],
          ["checked_by", "Checked by", "user", P.agent2.id, P.agent2.name],
          ["billable", "Billable", "checkbox", true, "Yes"],
        ]
      );
      assert.ok((await answersOf(t.id)).every((a) => a.answered_by_name === P.agent.name));
      const added = (await lines(t.id)).slice(before);
      assert.ok(added.some((l) => l.kind === "internal" && l.body.endsWith("filled in the solve details: Resolution code, Root cause, Follow up on, Checked by, Billable")), JSON.stringify(added));

      // The ticket detail carries them for the side panel; the requester's view of the request has none of it.
      const detail = await call(ticketRoute.GET, req(`/tickets/${t.number}`, P.agent.session), { number: String(t.number) });
      assert.deepEqual(detail.body.solve_details.map((d: { label: string; text: string }) => [d.label, d.text]).slice(0, 2), [
        ["Resolution code", "Fixed"],
        ["Root cause", "The VPN profile had expired."],
      ]);
      assert.equal(detail.body.before_solve, true);
      const asRequester = await call(requestRoute.GET, req(`/requests/${t.number}`, P.req.session), { number: String(t.number) });
      assert.equal(asRequester.status, 200);
      assert.ok(!/Resolution code|solve details|VPN profile had expired/i.test(JSON.stringify(asRequester.body)), "requesters never read the answers or their timeline line");
      assert.equal((await sr.solveSetUse()).get(setId), 1);
    });
  });

  test("atomic: answers are not saved when the same change is refused for another reason, and a required checklist item still blocks", async () => {
    await withSet({ fields: CLOSING.slice(0, 2) }, async () => {
      const t = await ticket("Atomic");
      const badOwner = await patch("admin", t.number, { status: "solved", assignee_id: P.other.id, solve_answers: GOOD });
      assert.equal(badOwner.status, 400);
      assert.equal(badOwner.body.error, "That person is not an agent of this ticket's team.");
      assert.deepEqual(await answersOf(t.id), []);
      assert.equal(await statusOf(t.id), "open");

      const tpl = await checklists.createTemplate({ name: `Wrap-up ${STAMP}`, items: [{ title: "Tell the manager", required: true }] }, { id: P.admin.id, name: P.admin.name });
      await checklists.addChecklistToTicket(t.id, tpl.id, actor());
      const blocked = await patch("agent", t.number, { status: "solved", solve_answers: GOOD });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error, 'Finish the required checklist items first: "Tell the manager".');
      assert.deepEqual(await answersOf(t.id), [], "the checklist refused the solve, so nothing was saved");
      const item = (await checklists.ticketChecklists(t.id))[0].items[0];
      await checklists.setItemDone(t.id, item.id, true, actor());
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: GOOD })).status, 200);
      assert.equal((await answersOf(t.id)).length, 2);
    });
  });

  test("two sets that match: both apply; a bare key answers both, \"<set id>:<key>\" answers one", async () => {
    // Sets apply in name order.
    const a = await makeSet({ name: `${STAMP} A general`, fields: [CLOSING[0]] });
    const b = await makeSet({ name: `${STAMP} B team`, fields: [{ ...CLOSING[0], label: "Outcome", options: [{ value: "fixed", label: "Sorted" }, { value: "escalated", label: "Escalated" }] }, CLOSING[1]] });
    try {
      const t = await ticket("Two sets");
      const none = await patch("agent", t.number, { status: "solved" });
      assert.equal(none.body.error, "Before you solve, this ticket needs: Resolution code, Outcome and Root cause.");
      const one = await patch("agent", t.number, { status: "solved", solve_answers: { [`${a}:resolution_code`]: "no_fault", root_cause: "User error" } });
      assert.equal(one.body.error, "Before you solve, this ticket needs: Outcome.");
      const both = await patch("agent", t.number, { status: "solved", solve_answers: { resolution_code: "fixed", [`${b}:resolution_code`]: "escalated", root_cause: "User error" } });
      assert.equal(both.status, 200, JSON.stringify(both.body));
      assert.deepEqual((await answersOf(t.id)).map((x) => [x.set_id, x.field_key, x.display]).sort(), [
        [a, "resolution_code", "Fixed"],
        [b, "resolution_code", "Escalated"],
        [b, "root_cause", "User error"],
      ].sort());
    } finally {
      await sr.deleteSolveSet(a);
      await sr.deleteSolveSet(b);
    }
  });
});

describe("reopening, and sets that change", () => {
  test("answers are kept when a ticket is reopened and it solves again without asking; a new required field is asked alone; a removed option is asked again", async () => {
    const setId = await makeSet({ fields: CLOSING.slice(0, 2) });
    try {
      const t = await ticket("Reopen");
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: GOOD })).status, 200);
      assert.equal((await patch("agent", t.number, { status: "open" })).status, 200);
      assert.equal((await answersOf(t.id)).length, 2, "kept through the reopen");
      const view = await call(checkRoute.GET, req(`/tickets/${t.number}/solve-requirements`, P.agent.session), { number: String(t.number) });
      assert.deepEqual(view.body.answers, { [`${setId}:resolution_code`]: "fixed", [`${setId}:root_cause`]: "The VPN profile had expired." }, "prefilled for the dialog");
      assert.deepEqual(view.body.missing, []);
      assert.equal((await patch("agent2", t.number, { status: "solved" })).status, 200, "nothing missing: no answers needed");
      assert.ok((await answersOf(t.id)).every((a) => a.answered_by_name === P.agent.name), "answers left as they were keep who gave them");

      // The admin adds a required field: only that one is asked on the next solve.
      await sr.updateSolveSet(setId, { fields: [...CLOSING.slice(0, 2), { key: "minutes_lost", label: "Minutes lost", type: "number", required: true }] });
      await patch("agent", t.number, { status: "open" });
      const again = await patch("agent", t.number, { status: "solved" });
      assert.equal(again.body.error, "Before you solve, this ticket needs: Minutes lost.");
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: { minutes_lost: "45" } })).status, 200);
      assert.deepEqual((await answersOf(t.id)).map((a) => [a.field_key, a.value]), [["resolution_code", "fixed"], ["root_cause", "The VPN profile had expired."], ["minutes_lost", 45]]);

      // An option is removed: the stored answer no longer fits, so it is asked again. The old answer still shows meanwhile.
      await sr.updateSolveSet(setId, { fields: [{ ...CLOSING[0], options: CLOSING[0].options!.slice(1) }, CLOSING[1]] });
      await patch("agent", t.number, { status: "open" });
      assert.equal((await patch("agent", t.number, { status: "solved" })).body.error, "Before you solve, this ticket needs: Resolution code.");
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: { resolution_code: "workaround" } })).status, 200);
      const kept = await sr.ticketSolveDetails(t.id);
      assert.deepEqual(kept.map((d) => [d.label, d.text]), [["Resolution code", "Workaround given"], ["Root cause", "The VPN profile had expired."], ["Minutes lost", "45"]], "the answer to the removed field is still on the ticket");

      // An optional answer sent empty clears it; one left out stays.
      await patch("agent", t.number, { status: "open" });
      await sr.updateSolveSet(setId, { fields: [CLOSING[0], { ...CLOSING[1], required: false }] });
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: { root_cause: "" } })).status, 200);
      assert.deepEqual((await answersOf(t.id)).map((a) => a.field_key), ["resolution_code", "minutes_lost"]);
    } finally {
      await sr.deleteSolveSet(setId);
    }
    // The set is deleted: the solved ticket keeps what it says.
    const t = (await pool().query("SELECT id FROM hd_tickets WHERE subject = $1", [`Reopen ${STAMP}`])).rows[0];
    assert.deepEqual((await sr.ticketSolveDetails(t.id)).map((d) => d.label), ["Resolution code", "Minutes lost"]);
  });

  test("tickets solved before a set existed are not touched; solved → closed never asks; pending → closed does", async () => {
    const old = await ticket("Solved earlier", "A", "solved");
    const waiting = await ticket("Waiting", "A", "pending");
    await withSet({ fields: CLOSING.slice(0, 2), ticket_fields: ["assignee"] }, async () => {
      assert.equal((await patch("agent", old.number, { status: "closed" })).status, 200, "it was already solved");
      assert.equal(await statusOf(old.id), "closed");
      const viaLib = await ticket("Solved earlier 2", "A", "solved");
      await tickets.updateTicket(viaLib.id, { status: "closed" }, { id: null, name: "Retention" });
      assert.equal(await statusOf(viaLib.id), "closed");
      const c = await patch("agent", waiting.number, { status: "closed" });
      assert.equal(c.status, 409);
      assert.match(c.body.error, /^Before you solve, this ticket needs: an owner, Resolution code and Root cause\.$/);
      // Reopening an old solved ticket and solving it again asks, as for any ticket.
      const reopened = await ticket("Solved earlier 3", "A", "solved");
      await patch("agent", reopened.number, { status: "open" });
      assert.equal((await patch("agent", reopened.number, { status: "solved" })).status, 409);
    });
  });
});

describe("every solver", () => {
  test("Send and set Solved: refused before anything is posted; the reply it sends counts; answers and ticket fields go in the same step", async () => {
    await withSet({ ticket_fields: ["reply", "assignee"], fields: CLOSING.slice(0, 2) }, async () => {
      const t = await ticket("Send");
      const before = (await lines(t.id)).length;
      const refused = await send("agent", t.number, { kind: "public", body: "All sorted.", then_status: "solved" });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, "solve_requirements");
      assert.equal(refused.body.error, "Before you solve, this ticket needs: an owner, Resolution code and Root cause.", "the reply being sent counts as the reply");
      assert.equal((await lines(t.id)).length, before, "the reply was not posted");
      const note = await send("agent", t.number, { kind: "internal", body: "Closing this.", then_status: "solved", solve_answers: GOOD, solve_fields: { assignee_id: P.agent.id } });
      assert.equal(note.status, 409);
      assert.equal(note.body.error, "Before you solve, this ticket needs: a reply sent to the requester.", "a note is not a reply");
      assert.equal((await lines(t.id)).length, before);
      await assert.rejects(
        messages.addMessage(t.id, { kind: "public", body: "Done", author: { id: P.agent.id, name: P.agent.name, email: "" }, via: "desk", then_status: "solved" }),
        (e: Error & { status?: number; messageUnsent?: boolean; extra?: { code?: string } }) => e.status === 409 && e.messageUnsent === true && e.extra?.code === "solve_requirements"
      );
      assert.equal((await lines(t.id)).length, before, "addMessage checks inside its own transaction too");
      const other = await send("agent", t.number, { kind: "public", body: "x", then_status: "solved", solve_answers: GOOD, solve_fields: { assignee_id: P.other.id } });
      assert.equal(other.status, 403, "an agent can't assign someone outside their teams from the dialog either");

      const ok = await send("agent", t.number, { kind: "public", body: "All sorted.", then_status: "solved", solve_answers: GOOD, solve_fields: { assignee_id: P.agent.id } });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.status, "solved");
      const row = await rowOf(t.id);
      assert.deepEqual([row.status, row.assignee_id], ["solved", P.agent.id]);
      assert.equal((await answersOf(t.id)).length, 2);
      // Setting another status with a reply never asks.
      const t2 = await ticket("Send pending");
      assert.equal((await send("agent", t2.number, { kind: "public", body: "Can you try again?", then_status: "pending" })).status, 201);
    });
  });

  test("a newbie's reply is held for review: nothing is asked, no status changes, no answers are saved", async () => {
    await withSet({ fields: CLOSING.slice(0, 2) }, async () => {
      const t = await ticket("Newbie");
      // By default a newbie may not change the status at all (403, as before); give the role that capability to reach the held path.
      assert.equal((await send("newbie", t.number, { kind: "public", body: "I think it's fixed.", then_status: "solved" })).status, 403);
      roles.setRoleMatrixForTests({ ...roles.HD_DEFAULT_MATRIX, newbie: [...roles.HD_DEFAULT_MATRIX.newbie, "tickets.change_status"] });
      try {
        const r = await send("newbie", t.number, { kind: "public", body: "I think it's fixed.", then_status: "solved", solve_answers: GOOD });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.held, true);
        assert.equal(await statusOf(t.id), "open");
        assert.deepEqual(await answersOf(t.id), []);
        // Solving it themselves, they are asked like anyone.
        assert.equal((await patch("newbie", t.number, { status: "solved" })).status, 409);
      } finally {
        roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
      }
    });
  });

  test("a macro that solves: a person's is refused whole before its reply; with the answers it goes through; an automation's sends the reply and drops only the status", async () => {
    await withSet({ fields: CLOSING.slice(0, 2), ticket_fields: ["reply"] }, async () => {
      const t = await ticket("Macro");
      const macro = await macros.createMacro({ title: `${STAMP} close`, body: "Glad that fixed it.", actions: { status: "solved", priority: "high" }, team_id: null, owner_id: P.agent.id }, P.agent.id);
      const before = (await lines(t.id)).length;
      const viaRoute = await call(macroRoute.POST, req(`/tickets/${t.number}/macro/${macro.id}`, P.agent.session, {}), { number: String(t.number), macroId: String(macro.id) });
      assert.equal(viaRoute.status, 409, JSON.stringify(viaRoute.body));
      assert.equal(viaRoute.body.error, "Before you solve, this ticket needs: Resolution code and Root cause.", "the macro's own reply counts as the reply");
      assert.equal((await lines(t.id)).length, before, "nothing posted");
      const auto = await macros.applyMacroToTicket(t.id, macro.id, { id: null, name: "Automation: thanks" }, { fromAutomation: true });
      assert.ok(auto.ok, JSON.stringify(auto));
      assert.match(auto.ok ? auto.status_unchanged ?? "" : "", /^Before you solve, this ticket needs/);
      let r = await rowOf(t.id);
      assert.deepEqual([r.status, r.priority], ["open", "high"], "the priority applied, the status did not");
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' AND body LIKE 'Glad that fixed it%'", [t.id])).rows[0].n, 1);
      const withAnswers = await call(macroRoute.POST, req(`/tickets/${t.number}/macro/${macro.id}`, P.agent.session, { solve_answers: GOOD, force: true }), { number: String(t.number), macroId: String(macro.id) });
      assert.equal(withAnswers.status, 200, JSON.stringify(withAnswers.body));
      r = await rowOf(t.id);
      assert.equal(r.status, "solved");
      assert.equal((await answersOf(t.id)).length, 2);
    });
  });

  test("an automation: the solve is dropped, the rest of its change applies; bulk edit: the ticket is skipped with the sentence, the others change", async () => {
    await withSet({ ticket_fields: ["assignee"], fields: CLOSING.slice(0, 1) }, async () => {
      const t = await ticket("Rule");
      const rule = (actions: Record<string, unknown>) => ({ id: 0, name: `${STAMP} rule`, actions }) as never;
      assert.equal(await automations.applyRule(rule({ status: "solved", priority: "urgent" }), await rowOf(t.id)), true);
      const r = await rowOf(t.id);
      assert.deepEqual([r.status, r.priority], ["open", "urgent"]);
      await assert.rejects(tickets.updateTicket(t.id, { status: "solved" }, { id: null, name: "Automation: close" }, { fromAutomation: true }), /^Error: Before you solve, this ticket needs: an owner and Resolution code\.$/);

      const free = await ticket("Bulk free", "B");
      const bulk = await call(bulkRoute.POST, req("/tickets/bulk", P.agent.session, { numbers: [t.number, free.number], patch: { status: "solved" } }));
      assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
      assert.deepEqual(bulk.body.results.map((x: { ok: boolean }) => x.ok), [false, true]);
      assert.equal(bulk.body.results[0].error, "Before you solve, this ticket needs: an owner and Resolution code.");
      assert.equal(await statusOf(t.id), "open");
      assert.equal(await statusOf(free.id), "solved");
    });
  });

  test("the REST API: 409 with the code and what is missing; solve_answers with the status solves; replies too; solve_details on the ticket", async () => {
    const made = await call(tokensRoute.POST, new Request("http://localhost/api/helpdesk/admin/api/tokens", {
      method: "POST",
      headers: { cookie: `compass_session=${P.dadmin.session}`, "content-type": "application/json" },
      body: JSON.stringify({ name: `${STAMP} sync`, role: "agent", team_ids: [T.A], expires_at: null }),
    }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    tokenIds.push(made.body.view.id);
    userIds.push((await pool().query("SELECT principal_id FROM hd_api_tokens WHERE id = $1", [made.body.view.id])).rows[0].principal_id);
    const api = (handler: unknown, url: string, method: string, body?: unknown, params: Record<string, string> = {}) =>
      call(handler, new Request(`http://localhost/api/helpdesk/v1${url}`, {
        method,
        headers: { authorization: `Bearer ${made.body.token}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.77" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), params);

    await withSet({ ticket_fields: ["tag"], fields: CLOSING.slice(0, 2) }, async (setId) => {
      const t = await ticket("API");
      const refused = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { status: "solved" }, { number: String(t.number) });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.code, "solve_requirements");
      assert.equal(refused.body.error, "Before you solve, this ticket needs: at least one tag, Resolution code and Root cause.");
      assert.deepEqual(refused.body.missing[0], { kind: "ticket_field", field: "tag", label: "At least one tag" });
      assert.equal(refused.body.missing[1].set_id, setId);
      const bad = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { status: "solved", tags: ["vpn"], solve_answers: { ...GOOD, resolution_code: 7 } }, { number: String(t.number) });
      assert.equal(bad.status, 400);
      assert.equal(await statusOf(t.id), "open");
      // An existing payload (no solve_answers) on a ticket no set matches is as before.
      const free = await ticket("API free", "A", "open");
      await pool().query("UPDATE hd_tickets SET tags = '{vpn}' WHERE id = $1", [free.id]);
      const ok = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { status: "solved", tags: ["vpn"], solve_answers: GOOD }, { number: String(t.number) });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.ticket.status, "solved");
      assert.deepEqual(ok.body.ticket.solve_details.map((d: { key: string; value: unknown; text: string }) => [d.key, d.value, d.text]), [
        ["resolution_code", "fixed", "Fixed"],
        ["root_cause", "The VPN profile had expired.", "The VPN profile had expired."],
      ]);
      assert.ok((await lines(t.id)).some((l) => /filled in the solve details: Resolution code, Root cause via API$/.test(l.body)));
      const got = await api(v1TicketRoute.GET, `/tickets/${t.number}`, "GET", undefined, { number: String(t.number) });
      assert.equal(got.body.solve_details.length, 2);
      assert.equal(got.body.solve_details[0].set, `${STAMP} set ${setIds.length}`);

      const reply = await api(v1RepliesRoute.POST, `/tickets/${free.number}/replies`, "POST", { body: "Done.", status: "solved" }, { number: String(free.number) });
      assert.equal(reply.status, 409, JSON.stringify(reply.body));
      assert.equal(reply.body.code, "solve_requirements");
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND kind = 'public'", [free.id])).rows[0].n, 0, "the reply was not sent");
      const reply2 = await api(v1RepliesRoute.POST, `/tickets/${free.number}/replies`, "POST", { body: "Done.", status: "solved", solve_answers: GOOD }, { number: String(free.number) });
      assert.equal(reply2.status, 201, JSON.stringify(reply2.body));
      assert.equal(reply2.body.status, "solved");
    });
    // With no set, an API solve and its body are as before, with an empty solve_details.
    const plain = await ticket("API plain");
    const r = await api(v1TicketRoute.PATCH, `/tickets/${plain.number}`, "PATCH", { status: "solved" }, { number: String(plain.number) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ticket.solve_details, []);
    assert.equal((await api(v1TicketRoute.PATCH, `/tickets/${plain.number}`, "PATCH", { solve_answers: {} }, { number: String(plain.number) })).status, 400, "solve_answers alone changes nothing");
  });

  test("the Claude connector: hd_read_ticket says what a solve needs; hd_update_ticket is refused with the sentence, and solves with solve_answers", async () => {
    claude.setClaudeLevelForTests("update");
    await withSet({ ticket_fields: ["assignee"], fields: CLOSING.slice(0, 2) }, async () => {
      const t = await ticket("Connector");
      const user = (await getUserById(P.agent.id))!;
      const ctx = { origin: "http://localhost", ip: null };
      const read = await hdTools.callHelpdeskTool(user, "hd_read_ticket", { number: t.number }, ctx);
      assert.equal(read.isError, false, read.content[0].text);
      const out = JSON.parse(read.content[0].text);
      assert.equal(out.before_you_solve.needed_now, "Before you solve, this ticket needs: an owner, Resolution code and Root cause.");
      assert.deepEqual(out.before_you_solve.ticket_fields, [{ field: "assignee", label: "An owner", met: false }]);
      assert.deepEqual(out.before_you_solve.closing_fields[0].options, [
        { value: "fixed", label: "Fixed" },
        { value: "workaround", label: "Workaround given" },
        { value: "no_fault", label: "No fault found" },
      ]);
      assert.deepEqual(out.solve_details, []);
      const upd = await hdTools.callHelpdeskTool(user, "hd_update_ticket", { number: t.number, status: "solved" }, ctx);
      assert.equal(upd.isError, true);
      assert.match(upd.content[0].text, /^Before you solve, this ticket needs: an owner, Resolution code and Root cause\. \(409\)/);
      assert.equal(await statusOf(t.id), "open");
      const ok = await hdTools.callHelpdeskTool(user, "hd_update_ticket", { number: t.number, status: "solved", assignee_id: "me", solve_answers: GOOD }, ctx);
      assert.equal(ok.isError, false, ok.content[0].text);
      assert.equal(await statusOf(t.id), "solved");
      assert.ok((await lines(t.id)).some((l) => /filled in the solve details: Resolution code, Root cause via Claude$/.test(l.body)));
      const after = JSON.parse((await hdTools.callHelpdeskTool(user, "hd_read_ticket", { number: t.number }, ctx)).content[0].text);
      assert.equal(after.solve_details.length, 2);
      assert.equal(after.before_you_solve, undefined, "a solved ticket needs nothing");
      const reqUser = (await getUserById(P.req.id))!;
      const asRequester = await hdTools.callHelpdeskTool(reqUser, "hd_read_request", { number: t.number }, ctx);
      assert.ok(!/solve_details|Resolution code/i.test(asRequester.content[0].text), "the requester's read has none");
    });
  });

  test("a workflow's Finish step: the request stays open with a note and its team hears; a workflow task ticket is never asked", async () => {
    const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} Flow` });
    const def = workflows.parseWorkflowDefinition({ steps: [{ key: "tell", kind: "notify", title: "Tell the requester", to: "requester", message: "On it." }, { key: "done", kind: "finish", title: "Done", csat: false }] as HdWorkflowStepB[] });
    assert.ok(meta.ok && def.ok, JSON.stringify([meta, def]));
    if (!meta.ok || !def.ok) return;
    const wf = await workflows.createWorkflow(meta.value, def.value);
    workflowIds.push(wf.id);
    const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Flow type`, team_id: T.A, workflow_id: wf.id });
    assert.ok(input.ok, !input.ok ? input.error : "");
    if (!input.ok) return;
    const rt = await requestTypes.createRequestType(input.value);
    typeIds.push(rt.id);
    const pub = await workflows.publishWorkflow(wf.id);
    assert.ok(pub.ok, !pub.ok ? pub.error : "");
    const raise = async () => {
      const t = await tickets.createTicket(
        { subject: `${STAMP} request`, body: "Hello", requester: { id: P.req.id, name: P.req.name, email: `${STAMP}-req@example.test` }, request_type_id: rt.id },
        { silent: true, actorId: P.req.id, actorName: P.req.name }
      );
      ticketIds.push(t.id);
      return t;
    };
    const free = await raise();
    assert.equal(await statusOf(free.id), "solved", "with no set the Finish step solves the request, as before");
    await withSet({ fields: CLOSING.slice(0, 1) }, async () => {
      const t = await raise();
      assert.equal((await pool().query("SELECT state FROM hd_workflow_runs WHERE ticket_id = $1", [t.id])).rows[0].state, "done");
      assert.notEqual(await statusOf(t.id), "solved");
      assert.ok(
        (await lines(t.id)).some((l) => l.kind === "internal" && /^The workflow has finished, but the request stays open: Before you solve, this ticket needs\\?: Resolution code/.test(l.body)),
        JSON.stringify(await lines(t.id))
      );
      const told = await pool().query("SELECT user_id FROM notifications WHERE title = $1", [`Details to fill in on #${t.number}`]);
      assert.ok(told.rows.length > 0, "the request's owner or team was told");
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: { resolution_code: "fixed" } })).status, 200);

      const task = await ticket("Task", "A", "open", { source: "workflow" });
      assert.equal(await sr.solveRequirementRefusal(task.id), null, "a workflow task's hand-off is its closing step");
      await tickets.updateTicket(task.id, { status: "solved" }, actor());
      assert.equal(await statusOf(task.id), "solved");
    });
  });

  test("a merge is never asked: the merged ticket is closed, and its answers stay on it", async () => {
    await withSet({ ticket_fields: ["assignee"], fields: CLOSING.slice(0, 2) }, async () => {
      const keep = await ticket("Keep");
      const dup = await ticket("Dup");
      const solvedDup = await ticket("Dup solved");
      assert.equal((await patch("agent", solvedDup.number, { status: "solved", assignee_id: P.agent.id, solve_answers: GOOD })).status, 200);
      await patch("agent", solvedDup.number, { status: "open" });
      const r = await merge.mergeTickets({ id: P.agent.id, role: "viewer", name: P.agent.name }, { keep: keep.number, merge: [dup.number, solvedDup.number], notify: false });
      assert.equal(r.merged.length, 2);
      assert.equal(await statusOf(dup.id), "closed");
      assert.equal(await statusOf(solvedDup.id), "closed");
      assert.equal((await answersOf(solvedDup.id)).length, 2, "they describe the merged ticket and stay on it");
      assert.deepEqual(await answersOf(keep.id), []);
      assert.equal((await patch("agent", keep.number, { status: "solved" })).status, 409, "the kept ticket is asked when it is solved");
    });
  });
});

describe("after the solve", () => {
  test("the ticket.solved webhook carries solve_details; other events don't", async () => {
    const hook = await pool().query(
      "INSERT INTO hd_webhooks (name, url, events, team_ids, secret_sealed) VALUES ($1, 'https://hooks.example.test/x', '{ticket.solved,ticket.updated}', $2, 'sealed') RETURNING id",
      [`${STAMP} hook`, [T.A]]
    );
    hookIds.push(hook.rows[0].id);
    await withSet({ fields: CLOSING.slice(0, 2) }, async () => {
      const t = await ticket("Webhook");
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: GOOD })).status, 200);
      const rows = (await pool().query("SELECT event, payload FROM hd_webhook_deliveries WHERE hook_id = $1 AND ticket_id = $2 ORDER BY id", [hook.rows[0].id, t.id])).rows;
      const solved = rows.find((r) => r.event === "ticket.solved");
      assert.ok(solved, JSON.stringify(rows.map((r) => r.event)));
      assert.deepEqual(solved.payload.solve_details, [
        { set: `${STAMP} set ${setIds.length}`, key: "resolution_code", label: "Resolution code", value: "fixed", text: "Fixed" },
        { set: `${STAMP} set ${setIds.length}`, key: "root_cause", label: "Root cause", value: "The VPN profile had expired.", text: "The VPN profile had expired." },
      ]);
      assert.equal(solved.payload.ticket.status, "solved");
      const updated = rows.find((r) => r.event === "ticket.updated");
      assert.equal(updated.payload.solve_details, undefined);
    });
    const plain = await ticket("Webhook plain");
    await patch("agent", plain.number, { status: "solved" });
    const row = (await pool().query("SELECT payload FROM hd_webhook_deliveries WHERE hook_id = $1 AND ticket_id = $2 AND event = 'ticket.solved'", [hook.rows[0].id, plain.id])).rows[0];
    assert.deepEqual(row.payload.solve_details, [], "no answers: an empty list");
  });

  test("anonymising a ticket removes free text and people's names from the answers; choices, dates and ticks stay", async () => {
    await withSet({ fields: CLOSING }, async () => {
      const t = await ticket("Anon");
      assert.equal((await patch("agent", t.number, { status: "solved", solve_answers: { ...GOOD, follow_up: "2026-12-01", checked_by: P.agent2.id, billable: true } })).status, 200);
      await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now() WHERE id = $1", [t.id]);
      assert.equal((await answersOf(t.id)).length, 5);
      await withTx((c) => retention.anonymiseTicketTx(c, t.id));
      assert.deepEqual((await answersOf(t.id)).map((a) => [a.field_key, a.display]), [
        ["resolution_code", "Fixed"],
        ["follow_up", "2026-12-01"],
        ["billable", "Yes"],
      ]);
    });
  });
});
