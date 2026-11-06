// Helpdesk 1.19.0 workflows (agent B): the engine, approvals, the "Request
// access" grant, versioning, the dry test run and the licence gate.
//
// Requests are raised through the core's own createTicket (its
// after-commit hook starts the workflow) and task tickets are solved
// through its updateTicket (whose hook moves the run on), so the wiring is
// what production runs. Approvals are decided through the route handlers
// with real sessions: next/headers resolves to a stub serving the request
// under test, and lib/ee to a stub that grants "helpdesk" (the last test
// takes it away).
//
// Parallel-safe: every team, request type, workflow, space and account is
// this file's own (STAMP); nobody is an administrator (the one admin-ish
// account holds the delegated "Helpdesk manager" role only); the sweep is
// called with claim:false and this file's run ids.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-workflow.test.ts

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-workflow.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-workflow.virtual.js");
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

// Loaded after the stubs are in place.
/* eslint-disable @typescript-eslint/no-require-imports */
const engine = require("../src/lib/helpdesk/engine") as typeof import("../src/lib/helpdesk/engine");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const approvals = require("../src/lib/helpdesk/approvals") as typeof import("../src/lib/helpdesk/approvals");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const approvalsRoute = require("../src/app/api/helpdesk/approvals/route") as typeof import("../src/app/api/helpdesk/approvals/route");
const approvalRoute = require("../src/app/api/helpdesk/approvals/[id]/route") as typeof import("../src/app/api/helpdesk/approvals/[id]/route");
const questionRoute = require("../src/app/api/helpdesk/approvals/[id]/question/route") as typeof import("../src/app/api/helpdesk/approvals/[id]/question/route");
const wfListRoute = require("../src/app/api/helpdesk/admin/workflows/route") as typeof import("../src/app/api/helpdesk/admin/workflows/route");
const wfPublishRoute = require("../src/app/api/helpdesk/admin/workflows/[id]/publish/route") as typeof import("../src/app/api/helpdesk/admin/workflows/[id]/publish/route");
const wfTestRoute = require("../src/app/api/helpdesk/admin/workflows/[id]/test-run/route") as typeof import("../src/app/api/helpdesk/admin/workflows/[id]/test-run/route");
const rtListRoute = require("../src/app/api/helpdesk/admin/request-types/route") as typeof import("../src/app/api/helpdesk/admin/request-types/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdFormField, HdTicket, HdWorkflowStep } from "../src/lib/helpdesk/types";

type IdHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type PlainHandler = (req: Request) => Promise<Response>;

async function call(handler: IdHandler | PlainHandler, req: Request, id?: number): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = id === undefined ? await (handler as PlainHandler)(req) : await (handler as IdHandler)(req, { params: Promise.resolve({ id: String(id) }) });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON */
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

const STAMP = `hdwf-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
}
const people: Record<string, Person> = {};
let itTeam = 0;
let hrTeam = 0;
let facTeam = 0;
let spaceId = 0;
let ownerlessSpaceId = 0;
const personIds: number[] = [];
const workflowIds: number[] = [];
const typeIds: number[] = [];
const ticketIds: number[] = [];
const runIds: number[] = [];
const agentDeliveries: { userId: number; event: string; title: string }[] = [];

async function person(key: string, name: string): Promise<Person> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP}-${key}`, name, `${STAMP}-${key}@example.test`]
  );
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  personIds.push(id);
  people[key] = { id, session, name };
  return people[key];
}

async function team(name: string, members: [string, "agent" | "lead"][]): Promise<number> {
  const r = await pool().query("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} ${name}`]);
  for (const [k, role] of members) {
    await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3)", [r.rows[0].id, people[k].id, role]);
  }
  return r.rows[0].id;
}

const START_FORM: HdFormField[] = [
  { key: "starter_name", label: "New starter's name", type: "text", required: true },
  { key: "start_date", label: "Start date", type: "date", required: true },
  { key: "laptop", label: "Laptop", type: "choice", options: [{ value: "dev", label: "Developer laptop", hint: "16-inch" }] },
];

let wfSeq = 0;
/** A published workflow linked to a new request type of `teamId`. */
async function publishedType(steps: HdWorkflowStep[], opts: { team?: number; form?: HdFormField[] } = {}) {
  const n = ++wfSeq;
  const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} Flow ${n}` });
  assert.ok(meta.ok, !meta.ok ? meta.error : "");
  const def = workflows.parseWorkflowDefinition({ trigger: {}, steps });
  assert.ok(def.ok, !def.ok ? def.error : "");
  const wf = await workflows.createWorkflow(meta.value, def.value);
  workflowIds.push(wf.id);
  const input = await requestTypes.validateRequestTypeInput({
    title: `${STAMP} Type ${n}`,
    team_id: opts.team ?? itTeam,
    form: opts.form ?? START_FORM,
    workflow_id: wf.id,
  });
  assert.ok(input.ok, !input.ok ? input.error : "");
  const rt = await requestTypes.createRequestType(input.value);
  typeIds.push(rt.id);
  const pub = await workflows.publishWorkflow(wf.id);
  assert.ok(pub.ok, !pub.ok ? pub.error : "");
  return { workflowId: wf.id, typeId: rt.id };
}

async function raise(by: Person, typeId: number, answers: Record<string, unknown> = {}, extra: { source?: any; source_ref?: Record<string, unknown> } = {}): Promise<HdTicket> {
  const t = await tickets.createTicket(
    {
      subject: `${STAMP} request`,
      body: "Please sort this out, thank you.",
      requester: { id: by.id, name: by.name, email: `${STAMP}@example.test` },
      request_type_id: typeId,
      answers: answers as never,
      source: extra.source,
      source_ref: extra.source_ref,
    },
    { silent: true, actorId: by.id, actorName: by.name }
  );
  ticketIds.push(t.id);
  const fresh = (await tickets.getTicketById(t.id))!;
  if (fresh.workflow_run_id) runIds.push(fresh.workflow_run_id);
  return fresh;
}

const run = async (ticketId: number) =>
  (await pool().query("SELECT * FROM hd_workflow_runs WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [ticketId])).rows[0];
const steps = async (runId: number) =>
  (await pool().query("SELECT * FROM hd_workflow_steps WHERE run_id = $1 ORDER BY id", [runId])).rows;
const approvalOf = async (ticketId: number) =>
  (await pool().query("SELECT * FROM hd_approvals WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [ticketId])).rows[0];
const children = async (ticketId: number) =>
  (await pool().query("SELECT * FROM hd_tickets WHERE parent_ticket_id = $1 ORDER BY id", [ticketId])).rows;
const systemMessages = async (ticketId: number) =>
  (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 AND kind IN ('system', 'internal') ORDER BY id", [ticketId])).rows as {
    kind: string;
    body: string;
  }[];
const ticketRow = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];

async function solve(ticketId: number, by: Person) {
  const r = await tickets.updateTicket(ticketId, { status: "solved" }, { id: by.id, name: by.name }, { silent: true });
  assert.ok(r, "solved");
}

const decide = (who: Person, approvalId: number, body: unknown) => call(approvalRoute.POST, req(`/approvals/${approvalId}`, who.session, body), approvalId);

before(async () => {
  await getSetting("__schema_bootstrap__");
  await person("req", "Daniel Okafor");
  await person("mgr", "Sara Haddad");
  await person("lead", "Matthew Felix");
  await person("agent", "Ivy Agent");
  await person("hr", "Hana HR");
  await person("fac", "Femi Facilities");
  await person("out", "Otto Outsider");
  await person("owner", "Olive Owner");
  await person("admin", "Ada Config");
  await person("loner", "Lou NoManager");
  itTeam = await team("IT", [["lead", "lead"], ["agent", "agent"]]);
  hrTeam = await team("HR", [["hr", "agent"], ["req", "agent"]]);
  facTeam = await team("Facilities", [["fac", "agent"]]);

  // The directory: Daniel reports to Sara (Lou has no entry at all).
  const dp = await pool().query(
    "INSERT INTO directory_people (name, email) VALUES ($1, $2), ($3, $4) RETURNING id",
    [`${STAMP} Daniel`, `${STAMP}-dp-req@example.test`, `${STAMP} Sara`, `${STAMP}-dp-mgr@example.test`]
  );
  const [reqPerson, mgrPerson] = dp.rows.map((r) => r.id as number);
  await pool().query("UPDATE users SET directory_person_id = $2 WHERE id = $1", [people.req.id, reqPerson]);
  await pool().query("UPDATE users SET directory_person_id = $2 WHERE id = $1", [people.mgr.id, mgrPerson]);
  await pool().query("INSERT INTO directory_person_links (person_id, field_key, target_id) VALUES ($1, 'manager', $2)", [reqPerson, mgrPerson]);

  // The one configuring account: the delegated Helpdesk manager role, not an administrator.
  await pool().query(
    `INSERT INTO role_assignments (role_id, user_id, scope_type) SELECT id, $1, 'global' FROM roles WHERE key = 'helpdesk-manager'`,
    [people.admin.id]
  );

  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility, policy_defaults) VALUES ($1, $2, '🔒', '', 'private', $3::jsonb) RETURNING id`,
    [`${STAMP} Finance`, `${STAMP}-finance`, JSON.stringify({ owner_user_id: people.owner.id })]
  );
  spaceId = sp.rows[0].id;
  const sp2 = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '🔒', '', 'private') RETURNING id`,
    [`${STAMP} Legal`, `${STAMP}-legal`]
  );
  ownerlessSpaceId = sp2.rows[0].id;

  notify.setAgentDeliverySpyForTests((userId, event, payload) => agentDeliveries.push({ userId, event, title: payload.title }));
  email.setHelpdeskTransportForTests(async () => {});
});

after(async () => {
  notify.setAgentDeliverySpyForTests(null);
  email.setHelpdeskTransportForTests(null);
  const kids = await pool().query("SELECT id FROM hd_tickets WHERE parent_ticket_id = ANY($1)", [ticketIds]);
  const all = [...ticketIds, ...kids.rows.map((r) => r.id as number)];
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1)", [workflowIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[itTeam, hrTeam, facTeam]]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR (target_type = 'space' AND target_id = ANY($2))", [
    personIds,
    [String(spaceId), String(ownerlessSpaceId)],
  ]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [personIds]);
  const dps = await pool().query("SELECT directory_person_id AS id FROM users WHERE id = ANY($1) AND directory_person_id IS NOT NULL", [personIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM directory_people WHERE id = ANY($1)", [dps.rows.map((r) => r.id)]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [[spaceId, ownerlessSpaceId]]);
  await pool().end();
});

// --- Definitions and forms -------------------------------------------------------------

describe("definitions", () => {
  test("a definition is checked: unique keys, tasks only in groups, Finish last", () => {
    const ok = workflows.parseWorkflowDefinition({
      trigger: {},
      steps: [
        { key: "a", kind: "approval", title: "Approve", approver: { kind: "manager" } },
        { key: "g", kind: "parallel", steps: [{ key: "t", kind: "task", title: "Do", team_id: 1, due: { field: "start_date", offset_days: -3 } }] },
        { key: "f", kind: "finish", title: "Done" },
      ],
    });
    assert.ok(ok.ok);
    if (ok.ok) assert.equal((ok.value.steps[0] as { on_decline: string }).on_decline, "close", "decline closes by default");
    const bad = (steps: unknown[]) => workflows.parseWorkflowDefinition({ steps });
    assert.equal(bad([{ key: "a", kind: "finish", title: "x" }, { key: "a", kind: "finish", title: "y" }]).ok, false);
    assert.equal(bad([{ key: "f", kind: "finish", title: "x" }, { key: "n", kind: "notify", title: "y", message: "m" }]).ok, false);
    assert.equal(bad([{ key: "g", kind: "parallel", steps: [{ key: "w", kind: "wait", title: "w", until: { after_hours: 1 } }] }]).ok, false);
    assert.equal(bad([{ key: "a", kind: "approval", title: "x", approver: { kind: "everyone" } }]).ok, false);
    assert.equal(bad([{ key: "w", kind: "wait", title: "x", until: { after_hours: 0 } }]).ok, false);
    assert.equal(bad([{ key: "s", kind: "shell", title: "x" }]).ok, false);
  });

  test("references are checked against the database and the linked form", async () => {
    const def = workflows.parseWorkflowDefinition({
      steps: [{ key: "t", kind: "task", title: "Do", team_id: itTeam, due: { field: "laptop" } }],
    });
    assert.ok(def.ok);
    if (!def.ok) return;
    const vsForm = await workflows.checkWorkflowRefs(def.value, START_FORM);
    assert.equal(vsForm.ok, false, "a due date must read a date field");
    const gone = workflows.parseWorkflowDefinition({ steps: [{ key: "t", kind: "task", title: "Do", team_id: 2_000_000_000 }] });
    assert.ok(gone.ok);
    if (gone.ok) assert.equal((await workflows.checkWorkflowRefs(gone.value)).ok, false, "a team that does not exist");
  });

  test("form fields and answers are validated", async () => {
    assert.equal(requestTypes.validateFormFields([{ key: "Bad Key", label: "x", type: "text" }]).ok, false);
    assert.equal(requestTypes.validateFormFields([{ key: "c", label: "x", type: "choice" }]).ok, false, "a choice needs options");
    assert.equal(requestTypes.validateFormFields([{ key: "t", label: "x", type: "text", options: [{ value: "a" }] }]).ok, false);
    assert.equal(requestTypes.validateFormFields([{ key: "a", label: "x", type: "text" }, { key: "a", label: "y", type: "text" }]).ok, false);
    assert.equal(requestTypes.validateFormFields([{ key: "d", label: "x", type: "text", default_from: "http://x" }]).ok, false);
    const form = requestTypes.validateFormFields(START_FORM);
    assert.ok(form.ok);
    const missing = await requestTypes.validateAnswers(START_FORM, { starter_name: "Kim" });
    assert.equal(missing.ok, false, "start date is required");
    const badDate = await requestTypes.validateAnswers(START_FORM, { starter_name: "Kim", start_date: "2026-02-31" });
    assert.equal(badDate.ok, false);
    const badChoice = await requestTypes.validateAnswers(START_FORM, { starter_name: "Kim", start_date: "2026-12-01", laptop: "gaming" });
    assert.equal(badChoice.ok, false);
    const good = await requestTypes.validateAnswers(START_FORM, { starter_name: " Kim ", start_date: "2026-12-01", laptop: "dev", extra: "dropped" });
    assert.ok(good.ok);
    if (good.ok) assert.deepEqual(good.value, { starter_name: "Kim", start_date: "2026-12-01", laptop: "dev" });
  });

  test("a request type is created through the admin route, and its form is checked there", async () => {
    const bad = await call(rtListRoute.POST, req("/admin/request-types", people.admin.session, { title: `${STAMP} Bad`, form: [{ key: "x", type: "nope", label: "x" }] }));
    assert.equal(bad.status, 400);
    const okRes = await call(rtListRoute.POST, req("/admin/request-types", people.admin.session, { title: `${STAMP} Ask IT`, team_id: itTeam, form: START_FORM }));
    assert.equal(okRes.status, 201, JSON.stringify(okRes.body));
    typeIds.push(okRes.body.request_type.id);
    assert.equal(okRes.body.request_type.form.length, 3);
    const audited = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.request_type.created' AND actor_id = $1", [people.admin.id]);
    assert.equal(audited.rowCount, 1);
    const denied = await call(rtListRoute.POST, req("/admin/request-types", people.out.session, { title: `${STAMP} Nope` }));
    assert.equal(denied.status, 403, "a requester cannot configure");
  });

  test("a desk role without the capability gets 403 on workflows and request types", async () => {
    // Ivy is an explicit desk Agent: she works tickets but configures nothing.
    await pool().query(
      "INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'agent') ON CONFLICT (user_id) DO UPDATE SET role = 'agent'",
      [people.agent.id]
    );
    assert.equal((await call(wfListRoute.GET, req("/admin/workflows", people.agent.session))).status, 403);
    assert.equal((await call(wfListRoute.POST, req("/admin/workflows", people.agent.session, { title: `${STAMP} Nope` }))).status, 403);
    assert.equal((await call(rtListRoute.GET, req("/admin/request-types", people.agent.session))).status, 403);
    // The Helpdesk manager (workspace helpdesk.admin: desk Admin) is let in.
    assert.equal((await call(wfListRoute.GET, req("/admin/workflows", people.admin.session))).status, 200);
  });
});

// --- The run lifecycle -----------------------------------------------------------------

describe("lifecycle", () => {
  test("approve → task ticket → solve it → wait → notify → finish", async () => {
    const { typeId } = await publishedType([
      { key: "approve", kind: "approval", title: "Your manager approves", approver: { kind: "manager" }, on_decline: "close", remind_after_hours: 8 },
      { key: "setup", kind: "task", title: "Laptop and accounts", team_id: itTeam, due: { after_hours: 24 }, description: "Set it up." },
      { key: "wait", kind: "wait", title: "Two days", until: { after_hours: 48 } },
      { key: "tell", kind: "notify", title: "Tell the requester", to: "requester", message: "All ready for {{starter_name}} (#{{number}})." },
      { key: "done", kind: "finish", title: "Solve the request", csat: true },
    ]);
    const t = await raise(people.req, typeId, { starter_name: "Kim", start_date: "2026-12-01", laptop: "dev" });
    assert.ok(t.workflow_run_id, "the hook started a run");
    assert.equal(t.in_workflow, true);
    const r0 = await run(t.id);
    assert.equal(r0.state, "running");
    assert.equal(r0.current.index, 0);

    // The manager from the directory is asked, and told.
    const a = await approvalOf(t.id);
    assert.equal(a.approver_kind, "manager");
    assert.equal(a.approver_user_id, people.mgr.id);
    assert.ok(agentDeliveries.some((d) => d.userId === people.mgr.id && d.event === "approval_needed"));
    const listed = await call(approvalsRoute.GET, req("/approvals", people.mgr.session));
    assert.equal(listed.status, 200);
    const card = listed.body.approvals.find((x: any) => x.id === a.id);
    assert.ok(card, "the manager sees it");
    assert.equal(card.reason, "your direct report");
    assert.ok(card.answers.some((x: any) => x.label === "Laptop" && x.value === "Developer laptop · 16-inch"), "answers are labelled");
    assert.equal(card.body, "Please sort this out, thank you.");

    const approved = await decide(people.mgr, a.id, { decision: "approved", note: "Makes sense." });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const again = await decide(people.mgr, a.id, { decision: "approved" });
    assert.equal(again.status, 409, "a second click is refused");

    // The task: a child ticket for IT, due in a day.
    const kids = await children(t.id);
    assert.equal(kids.length, 1);
    const child = kids[0];
    assert.equal(child.team_id, itTeam);
    assert.equal(child.source, "workflow");
    assert.equal(child.subject, `Laptop and accounts: ${STAMP} request`);
    assert.equal(child.requester_id, null, "a task ticket answers no requester");
    assert.equal(child.first_reply_due, null);
    const dueIn = new Date(child.resolve_due).getTime() - Date.now();
    assert.ok(dueIn > 23 * 3_600_000 && dueIn < 25 * 3_600_000, "due in 24 hours");
    assert.ok(agentDeliveries.some((d) => d.userId === people.agent.id && d.event === "task_assigned"));
    const note = (await systemMessages(child.id)).find((m) => m.kind === "internal");
    assert.ok(note?.body.includes("Set it up.") && note.body.includes("Developer laptop"), "the task carries its description and the answers");

    // The requester heard the decision.
    const bell = await pool().query("SELECT title, link FROM notifications WHERE user_id = $1 AND title LIKE '%approved%'", [people.req.id]);
    assert.ok(bell.rowCount && bell.rows[0].link === `/help/requests/${t.number}`);

    // Solving the task (through the core's update) moves the run to the wait.
    await solve(child.id, people.agent);
    const r1 = await run(t.id);
    assert.equal(r1.state, "waiting");
    const wait = (await steps(r1.id)).find((s) => s.step_key === "wait");
    assert.equal(wait.state, "active");
    assert.equal((await ticketRow(t.id)).status === "solved", false);

    // Not yet: the sweep leaves it.
    await engine.sweepWorkflows({ claim: false, runIds: [r1.id], now: new Date(Date.now() + 3_600_000) });
    assert.equal((await run(t.id)).state, "waiting");
    // Two days on: notify, finish.
    const swept = await engine.sweepWorkflows({ claim: false, runIds: [r1.id], now: new Date(Date.now() + 49 * 3_600_000) });
    assert.equal(swept.advanced, 1);
    const r2 = await run(t.id);
    assert.equal(r2.state, "done");
    const done = await ticketRow(t.id);
    assert.equal(done.status, "solved");
    const notified = await pool().query("SELECT body FROM notifications WHERE user_id = $1 AND title LIKE 'Tell the requester%'", [people.req.id]);
    assert.equal(notified.rowCount, 1, "the notify step reached the requester's bell");
    assert.equal(notified.rows[0].body, `All ready for Kim (#${t.number}).`);
    const msgs = (await systemMessages(t.id)).map((m) => m.body);
    assert.ok(msgs.some((b) => b.includes('Sara Haddad approved: Your manager approves. "Makes sense."')));
    assert.ok(msgs.some((b) => b.startsWith("Solved by the workflow")));

    // The tracker, as the requester and as an agent.
    const mine = await engine.getWorkflowProgress(t.id, "requester");
    assert.ok(mine);
    assert.deepEqual(
      mine!.steps.map((s) => s.state),
      ["done", "done", "done", "done", "done"]
    );
    assert.equal(mine!.steps[0].detail, 'Approved by Sara Haddad: "Makes sense."');
    assert.equal(mine!.steps[1].task_ticket_number, undefined, "requesters do not see task numbers");
    const theirs = await engine.getWorkflowProgress(t.id, "agent");
    assert.equal(theirs!.steps[1].task_ticket_number, child.number);

    // Advancing a finished run again changes nothing.
    assert.equal(await engine.advanceRun(r2.id), "done");
    assert.equal((await children(t.id)).length, 1);
  });

  test("a parallel group completes when every task is solved", async () => {
    const { typeId } = await publishedType(
      [
        {
          key: "prep",
          kind: "parallel",
          title: "Get ready",
          steps: [
            { key: "it", kind: "task", title: "Laptop", team_id: itTeam, due: { field: "start_date", offset_days: -3 } },
            { key: "fac", kind: "task", title: "Desk", team_id: facTeam },
          ],
        },
        { key: "done", kind: "finish", title: "Solve", csat: false },
      ],
      { team: hrTeam }
    );
    const t = await raise(people.req, typeId, { starter_name: "Kim", start_date: "2026-12-10" });
    const kids = await children(t.id);
    assert.equal(kids.length, 2, "both tasks start together");
    const it = kids.find((k) => k.team_id === itTeam);
    const fac = kids.find((k) => k.team_id === facTeam);
    assert.equal(new Date(it.resolve_due).toISOString().slice(0, 10), "2026-12-07", "three days before the start date");
    await solve(fac.id, people.fac);
    assert.equal((await run(t.id)).state, "running", "one of two is not enough");
    const mid = await engine.getWorkflowProgress(t.id, "agent");
    assert.equal(mid!.steps[0].state, "active");
    assert.equal(mid!.steps[0].detail, "1 of 2 done");
    // Two events racing for the same run: both serialise on its lock.
    await solve(it.id, people.agent);
    await Promise.all([engine.onTicketSolved(it.id), engine.onTicketSolved(fac.id)]);
    assert.equal((await run(t.id)).state, "done");
    assert.equal((await ticketRow(t.id)).status, "solved");
    assert.equal((await steps((await run(t.id)).id)).filter((s) => s.step_key === "done").length, 1);
  });

  test("solving the request by hand stops its run", async () => {
    const { typeId } = await publishedType([
      { key: "a", kind: "approval", title: "HR approves", approver: { kind: "team", team_id: hrTeam }, on_decline: "close" },
      { key: "f", kind: "finish", title: "Solve" },
    ]);
    const t = await raise(people.out, typeId, { starter_name: "Kim", start_date: "2026-12-01" });
    await solve(t.id, people.lead);
    const r = await run(t.id);
    assert.equal(r.state, "cancelled");
    assert.equal((await approvalOf(t.id)).decision, "cancelled");
    const listed = await approvals.listMyApprovals(people.hr);
    assert.equal(listed.some((x) => x.ticket_number === t.number), false, "nothing left to decide");
  });
});

// --- Declines ----------------------------------------------------------------------------

describe("decline", () => {
  test("declining needs a note, closes the request and tells the requester", async () => {
    const { typeId } = await publishedType([
      { key: "a", kind: "approval", title: "HR approves", approver: { kind: "team", team_id: hrTeam }, on_decline: "close" },
      { key: "t", kind: "task", title: "Do it", team_id: itTeam },
      { key: "f", kind: "finish", title: "Solve" },
    ]);
    const t = await raise(people.out, typeId, { starter_name: "Kim", start_date: "2026-12-01" });
    const a = await approvalOf(t.id);
    const noNote = await decide(people.hr, a.id, { decision: "declined" });
    assert.equal(noNote.status, 400);
    const res = await decide(people.hr, a.id, { decision: "declined", note: "No budget this quarter." });
    assert.equal(res.status, 200);
    assert.equal(res.body.run_state, "declined");
    assert.equal((await ticketRow(t.id)).status, "solved");
    assert.equal((await children(t.id)).length, 0, "nothing after the decline starts");
    const msgs = (await systemMessages(t.id)).map((m) => m.body);
    assert.ok(msgs.some((b) => b.includes("No budget this quarter.")));
    const bell = await pool().query("SELECT body FROM notifications WHERE user_id = $1 AND title LIKE '%declined%'", [people.out.id]);
    assert.equal(bell.rows[0]?.body, "No budget this quarter.");
    const audit = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.approval.declined' AND actor_id = $1", [people.hr.id]);
    assert.equal(audit.rowCount, 1);
    const progress = await engine.getWorkflowProgress(t.id, "requester");
    assert.equal(progress!.state, "declined");
    assert.equal(progress!.steps[0].detail, 'Declined by Hana HR: "No budget this quarter."');
    assert.equal(progress!.steps[1].state, "skipped");
  });

  test("on_decline continue moves on", async () => {
    const { typeId } = await publishedType([
      { key: "a", kind: "approval", title: "Optional sign-off", approver: { kind: "user", user_id: people.lead.id }, on_decline: "continue" },
      { key: "t", kind: "task", title: "Do it anyway", team_id: itTeam },
    ]);
    const t = await raise(people.out, typeId, { starter_name: "Kim", start_date: "2026-12-01" });
    const a = await approvalOf(t.id);
    assert.equal(a.approver_kind, "user");
    const res = await decide(people.lead, a.id, { decision: "declined", note: "Not needed." });
    assert.equal(res.status, 200);
    assert.equal((await children(t.id)).length, 1);
    // No Finish: the run ends and the request stays open for its team.
    await solve((await children(t.id))[0].id, people.agent);
    assert.equal((await run(t.id)).state, "done");
    assert.notEqual((await ticketRow(t.id)).status, "solved");
  });
});

// --- Manager resolution --------------------------------------------------------------------

describe("manager", () => {
  test("the requester's manager comes from the directory", async () => {
    assert.deepEqual(await approvals.resolveManager(people.req.id), { user_id: people.mgr.id, name: "Sara Haddad" });
    assert.equal(await approvals.resolveManager(people.loner.id), null);
  });

  test("no manager: the request type's team leads decide, and the request says so", async () => {
    const { typeId } = await publishedType([
      { key: "a", kind: "approval", title: "Your manager approves", approver: { kind: "manager" }, on_decline: "close" },
      { key: "f", kind: "finish", title: "Solve", csat: false },
    ]);
    const t = await raise(people.loner, typeId, { starter_name: "Kim", start_date: "2026-12-01" });
    const a = await approvalOf(t.id);
    assert.equal(a.approver_kind, "manager");
    assert.equal(a.approver_user_id, null);
    assert.equal(a.approver_team_id, itTeam);
    const msgs = (await systemMessages(t.id)).map((m) => m.body);
    assert.ok(msgs.some((b) => b.includes("No manager is set for Lou NoManager in the directory") && b.includes(`the leads of ${STAMP} IT`)));
    // The lead may decide; a member who is not a lead may not even read it.
    assert.deepEqual(await approvals.approverUserIds(a.id), [people.lead.id]);
    const asAgent = await call(approvalRoute.GET, req(`/approvals/${a.id}`, people.agent.session), a.id);
    assert.equal(asAgent.status, 404);
    const asLead = await call(approvalRoute.GET, req(`/approvals/${a.id}`, people.lead.session), a.id);
    assert.equal(asLead.status, 200);
    assert.equal(asLead.body.approval.reason, "standing in for their manager");
    const res = await decide(people.lead, a.id, { decision: "approved" });
    assert.equal(res.status, 200);
    assert.equal(res.body.run_state, "done");
  });
});

// --- Visibility --------------------------------------------------------------------------

describe("visibility", () => {
  test("only approvers see an approval; the requester sees its outcome; nobody decides their own request", async () => {
    const { typeId } = await publishedType([
      { key: "a", kind: "approval", title: "HR approves", approver: { kind: "team", team_id: hrTeam }, on_decline: "close" },
      { key: "f", kind: "finish", title: "Solve", csat: false },
    ]);
    // Daniel is in HR himself: HR approves his request, but never Daniel.
    const t = await raise(people.req, typeId, { starter_name: "Kim", start_date: "2026-12-01" });
    const a = await approvalOf(t.id);
    for (const who of [people.out, people.req, people.agent]) {
      const got = await call(approvalRoute.GET, req(`/approvals/${a.id}`, who.session), a.id);
      assert.equal(got.status, 404, `${who.name} is not asked`);
      const tried = await decide(who, a.id, { decision: "approved" });
      assert.equal(tried.status, 404, `${who.name} cannot decide`);
      const list = await call(approvalsRoute.GET, req("/approvals", who.session));
      assert.equal(list.body.approvals.some((x: any) => x.id === a.id), false);
    }
    assert.deepEqual(await approvals.approverUserIds(a.id), [people.hr.id], "the requester is left out of their own team's ask");
    assert.equal(await approvals.isApproverFor(people.hr.id, t.id), true);
    assert.equal(await approvals.isApproverFor(people.out.id, t.id), false);

    // The approver's question is a public message from them.
    const q = await call(questionRoute.POST, req(`/approvals/${a.id}/question`, people.hr.session, { body: "Which cost centre?" }), a.id);
    assert.equal(q.status, 201);
    const msg = await pool().query("SELECT kind, author_id FROM hd_messages WHERE id = $1", [q.body.message_id]);
    assert.deepEqual(msg.rows[0], { kind: "public", author_id: people.hr.id });
    const qOut = await call(questionRoute.POST, req(`/approvals/${a.id}/question`, people.out.session, { body: "Hi" }), a.id);
    assert.equal(qOut.status, 404);

    const res = await decide(people.hr, a.id, { decision: "approved", note: "Fine by HR." });
    assert.equal(res.status, 200);
    const outcome = await engine.getWorkflowProgress(t.id, "requester");
    assert.equal(outcome!.steps[0].detail, 'Approved by Hana HR: "Fine by HR."');
    // Decided: the approver still reads it (history) but can no longer decide.
    const after = await call(approvalRoute.GET, req(`/approvals/${a.id}`, people.hr.session), a.id);
    assert.equal(after.body.approval.can_decide, false);
    const history = await call(approvalsRoute.GET, req("/approvals?state=decided", people.hr.session));
    assert.ok(history.body.approvals.some((x: any) => x.id === a.id));
  });
});

// --- Versions ----------------------------------------------------------------------------

describe("versions", () => {
  test("a run keeps the version it started with; new requests run the new one", async () => {
    const { workflowId, typeId } = await publishedType([
      { key: "t1", kind: "task", title: "Version one task", team_id: itTeam },
      { key: "f", kind: "finish", title: "Solve", csat: false },
    ]);
    const first = await raise(people.out, typeId, { starter_name: "Kim", start_date: "2026-12-01" });
    const r1 = await run(first.id);
    assert.equal(r1.workflow_version, 1);

    // Save a draft: nothing changes for anyone until it is published.
    const meta = await workflows.validateWorkflowMeta({}, (await workflows.getWorkflow(workflowId))!);
    assert.ok(meta.ok);
    const v2 = workflows.parseWorkflowDefinition({
      steps: [
        { key: "t2", kind: "task", title: "Version two task", team_id: facTeam },
        { key: "f", kind: "finish", title: "Solve", csat: false },
      ],
    });
    assert.ok(v2.ok && meta.ok);
    if (!v2.ok || !meta.ok) return;
    await workflows.saveWorkflowDraft(workflowId, meta.value, v2.value);
    const draftOnly = await raise(people.out, typeId, { starter_name: "Kim", start_date: "2026-12-01" });
    assert.equal((await children(draftOnly.id))[0].subject.startsWith("Version one task"), true, "a draft is not live");

    const pub = await call(wfPublishRoute.POST, req(`/admin/workflows/${workflowId}/publish`, people.admin.session, {}), workflowId);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.version, 2);
    const nothing = await call(wfPublishRoute.POST, req(`/admin/workflows/${workflowId}/publish`, people.admin.session, {}), workflowId);
    assert.equal(nothing.status, 409, "no changes to publish");

    const second = await raise(people.out, typeId, { starter_name: "Kim", start_date: "2026-12-01" });
    assert.equal((await run(second.id)).workflow_version, 2);
    assert.equal((await children(second.id))[0].subject.startsWith("Version two task"), true);

    // The first run finishes on version one.
    await solve((await children(first.id))[0].id, people.agent);
    const done = await run(first.id);
    assert.equal(done.state, "done");
    assert.equal(done.current.definition.steps[0].key, "t1");
    assert.equal((await children(first.id)).length, 1);
  });
});

// --- The test run --------------------------------------------------------------------------

describe("test run", () => {
  test("simulates every step and writes nothing", async () => {
    const { workflowId } = await publishedType([
      { key: "a", kind: "approval", title: "Manager", approver: { kind: "manager" }, on_decline: "close", remind_after_hours: 24 },
      { key: "g", kind: "parallel", steps: [{ key: "it", kind: "task", title: "Laptop", team_id: itTeam, due: { field: "start_date", offset_days: -3 } }] },
      { key: "w", kind: "wait", title: "Until the start date", until: { field: "start_date" } },
      { key: "n", kind: "notify", title: "Tell the manager", to: { user_id: people.mgr.id }, message: "Ready." },
      { key: "f", kind: "finish", title: "Solve" },
    ]);
    const before = await pool().query(
      `SELECT (SELECT count(*) FROM hd_tickets WHERE request_type_id = ANY($1) OR parent_ticket_id IN (SELECT id FROM hd_tickets WHERE request_type_id = ANY($1)))::int AS t,
              (SELECT count(*) FROM hd_workflow_runs WHERE workflow_id = $2)::int AS r,
              (SELECT count(*) FROM notifications WHERE user_id = ANY($3))::int AS n,
              (SELECT count(*) FROM audit_log WHERE actor_id = $4)::int AS a`,
      [typeIds, workflowId, personIds, people.admin.id]
    );

    // Every statement the simulation sends, from this process.
    const p = pool() as unknown as { query: (...a: unknown[]) => Promise<unknown>; connect: (...a: unknown[]) => Promise<unknown> };
    const seen: string[] = [];
    const origQuery = p.query;
    const origConnect = p.connect;
    p.query = function (this: unknown, ...a: unknown[]) {
      seen.push(String(typeof a[0] === "string" ? a[0] : (a[0] as { text?: string })?.text));
      return (origQuery as (...x: unknown[]) => Promise<unknown>).apply(this, a);
    };
    p.connect = function (this: unknown, ...a: unknown[]) {
      // pool.query checks a client out with a callback; a transaction (withTx) asks for one without.
      if (a.length === 0) seen.push("CONNECT");
      return (origConnect as (...x: unknown[]) => Promise<unknown>).apply(this, a);
    };
    let sim;
    try {
      sim = await workflows.simulateWorkflow(
        (await workflows.getWorkflow(workflowId))!.definition,
        { answers: { start_date: "2026-12-14" }, requester_id: people.req.id, now: new Date("2026-12-01T10:00:00Z") },
        people.admin
      );
    } finally {
      p.query = origQuery;
      p.connect = origConnect;
    }
    assert.ok(sim.ok);
    if (!sim.ok) return;
    assert.ok(seen.length > 0);
    assert.equal(seen.filter((s) => s === "CONNECT" || /^\s*(INSERT|UPDATE|DELETE|WITH|BEGIN)/i.test(s)).length, 0, "reads only, no transaction");
    const v = sim.value;
    assert.equal(v.ends, "solved");
    assert.deepEqual(v.steps.map((s) => s.key), ["a", "g", "it", "w", "n", "f"]);
    assert.ok(v.steps[0].outcome.includes("Sara Haddad"));
    assert.equal(v.steps[2].due_at, "2026-12-11T17:00:00.000Z");
    assert.equal(v.steps[3].wait_until, "2026-12-14T00:00:00.000Z");
    assert.ok(v.steps[4].outcome.includes("Sara Haddad"));

    const declined = await workflows.simulateWorkflow((await workflows.getWorkflow(workflowId))!.definition, { decline_at: "a" }, people.loner);
    assert.ok(declined.ok && declined.value.ends === "declined" && declined.value.steps.length === 1);
    assert.ok(declined.ok && declined.value.warnings.some((w) => w.includes("no manager")));

    const viaRoute = await call(wfTestRoute.POST, req(`/admin/workflows/${workflowId}/test-run`, people.admin.session, { answers: { start_date: "2026-12-14" } }), workflowId);
    assert.equal(viaRoute.status, 200);
    assert.equal(viaRoute.body.test.steps.length, 6);

    const afterCounts = await pool().query(
      `SELECT (SELECT count(*) FROM hd_tickets WHERE request_type_id = ANY($1) OR parent_ticket_id IN (SELECT id FROM hd_tickets WHERE request_type_id = ANY($1)))::int AS t,
              (SELECT count(*) FROM hd_workflow_runs WHERE workflow_id = $2)::int AS r,
              (SELECT count(*) FROM notifications WHERE user_id = ANY($3))::int AS n,
              (SELECT count(*) FROM audit_log WHERE actor_id = $4)::int AS a`,
      [typeIds, workflowId, personIds, people.admin.id]
    );
    assert.deepEqual(afterCounts.rows[0], before.rows[0]);
  });
});

// --- Space access --------------------------------------------------------------------------

describe("space access", () => {
  const grants = async (userId: number) =>
    (
      await pool().query(
        `SELECT r.key, ra.scope_type, ra.space_id FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
          WHERE ra.user_id = $1 AND NOT (r.is_builtin AND r.key IN ('viewer', 'editor', 'approver', 'admin') AND ra.scope_type = 'global')
          ORDER BY ra.id`,
        [userId]
      )
    ).rows;

  test("the owner approves and the requester gets read on the space, audited, nothing more", async () => {
    const { typeId } = await publishedType([
      { key: "approve", kind: "approval", title: "The owner approves", approver: { kind: "space_owner" } as never, on_decline: "close" },
      { key: "done", kind: "finish", title: "Access granted", csat: false },
    ]);
    assert.deepEqual(await grants(people.out.id), []);
    const t = await raise(people.out, typeId, {}, { source: "space_access", source_ref: { space_id: spaceId } });
    const a = await approvalOf(t.id);
    assert.equal(a.approver_kind, "user");
    assert.equal(a.approver_user_id, people.owner.id);
    const res = await decide(people.owner, a.id, { decision: "approved" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await grants(people.out.id), [{ key: "space-member", scope_type: "space", space_id: spaceId }]);
    const perms = await pool().query(
      `SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'space-member'`
    );
    assert.deepEqual(perms.rows.map((r) => r.permission), ["space.member"], "read, and only read");
    const audit = await pool().query(
      "SELECT actor_id, details FROM audit_log WHERE action = 'helpdesk.space_access.granted' AND target_type = 'space' AND target_id = $1",
      [String(spaceId)]
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].actor_id, people.owner.id);
    assert.equal(audit.rows[0].details.user_id, people.out.id);
    assert.equal(audit.rows[0].details.role, "space-member");
    assert.equal((await ticketRow(t.id)).status, "solved");
  });

  test("declined: nothing is granted; no owner: whoever manages space access is asked", async () => {
    const { typeId } = await publishedType([
      { key: "approve", kind: "approval", title: "The owner approves", approver: { kind: "space_owner" } as never, on_decline: "close" },
      { key: "done", kind: "finish", title: "Access granted", csat: false },
    ]);
    const t = await raise(people.loner, typeId, {}, { source: "space_access", source_ref: { space_id: spaceId } });
    const res = await decide(people.owner, (await approvalOf(t.id)).id, { decision: "declined", note: "Finance only." });
    assert.equal(res.status, 200);
    assert.deepEqual(await grants(people.loner.id), []);

    const t2 = await raise(people.loner, typeId, {}, { source: "space_access", source_ref: { space_id: ownerlessSpaceId } });
    const a2 = await approvalOf(t2.id);
    assert.equal(a2.approver_kind, "space");
    assert.equal(a2.approver_user_id, null);
    // The Helpdesk manager does not manage space access: not asked.
    const got = await call(approvalRoute.GET, req(`/approvals/${a2.id}`, people.admin.session), a2.id);
    assert.equal(got.status, 404);
    // Stop it so it leaves nothing pending.
    assert.equal(await engine.cancelRun((await run(t2.id)).id), true);
  });

  test("a finish without an approval never grants", async () => {
    const { typeId } = await publishedType([{ key: "done", kind: "finish", title: "Access granted", csat: false }]);
    const t = await raise(people.loner, typeId, {}, { source: "space_access", source_ref: { space_id: spaceId } });
    assert.equal((await run(t.id)).state, "done");
    assert.deepEqual(await grants(people.loner.id), []);
  });
});

// --- Reminders ------------------------------------------------------------------------------

describe("reminders", () => {
  test("an approval past its step's 'remind after' is reminded once", async () => {
    const { typeId } = await publishedType([
      { key: "a", kind: "approval", title: "Lead signs off", approver: { kind: "user", user_id: people.lead.id }, on_decline: "close", remind_after_hours: 2 },
      { key: "f", kind: "finish", title: "Solve", csat: false },
    ]);
    const t = await raise(people.out, typeId, { starter_name: "Kim", start_date: "2026-12-01" });
    const r = await run(t.id);
    const count = () => agentDeliveries.filter((d) => d.userId === people.lead.id && d.title.startsWith("Reminder:")).length;
    const before = count();
    assert.equal((await engine.sweepWorkflows({ claim: false, runIds: [r.id], now: new Date(Date.now() + 3_600_000) })).reminded, 0);
    assert.equal((await engine.sweepWorkflows({ claim: false, runIds: [r.id], now: new Date(Date.now() + 3 * 3_600_000) })).reminded, 1);
    assert.equal((await engine.sweepWorkflows({ claim: false, runIds: [r.id], now: new Date(Date.now() + 9 * 3_600_000) })).reminded, 0);
    assert.equal(count(), before + 1);
    await engine.cancelRun(r.id);
  });
});

// --- Licence ------------------------------------------------------------------------------

describe("licence", () => {
  test("unlicensed: every route answers 402 and the sweep does nothing", async () => {
    const { typeId } = await publishedType([
      { key: "w", kind: "wait", title: "An hour", until: { after_hours: 1 } },
      { key: "f", kind: "finish", title: "Solve", csat: false },
    ]);
    const t = await raise(people.out, typeId, { starter_name: "Kim", start_date: "2026-12-01" });
    const r = await run(t.id);
    assert.equal(r.state, "waiting");
    edition.features = [];
    try {
      assert.equal((await call(approvalsRoute.GET, req("/approvals", people.mgr.session))).status, 402);
      assert.equal((await call(approvalRoute.POST, req("/approvals/1", people.mgr.session, { decision: "approved" }), 1)).status, 402);
      assert.equal((await call(wfListRoute.GET, req("/admin/workflows", people.admin.session))).status, 402);
      assert.equal((await call(rtListRoute.GET, req("/admin/request-types", people.admin.session))).status, 402);
      const swept = await engine.sweepWorkflows({ claim: false, runIds: [r.id], now: new Date(Date.now() + 2 * 3_600_000) });
      assert.deepEqual(swept, { advanced: 0, reminded: 0 });
      assert.equal((await run(t.id)).state, "waiting");
    } finally {
      edition.features = ["helpdesk"];
    }
    await engine.sweepWorkflows({ claim: false, runIds: [r.id], now: new Date(Date.now() + 2 * 3_600_000) });
    assert.equal((await run(t.id)).state, "done");
    // Licensed again, the admin list answers.
    const list = await call(wfListRoute.GET, req("/admin/workflows", people.admin.session));
    assert.equal(list.status, 200);
    assert.ok(list.body.workflows.some((w: any) => w.id === r.workflow_id));
  });
});
