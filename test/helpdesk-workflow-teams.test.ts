// Helpdesk 1.19.0 multi-team workflows (agent B): conditions that skip a
// step, routing a task to a team, "can't be done" (carry on, or hold the
// run for the coordinating team: retry, skip, cancel), hand-offs (required
// outputs, the request's "Hand-offs", later tasks' notes, placeholders),
// the read-only request view for task teams, transfers and the time-per-
// team record, publish-time checks and the dry run.
//
// Same harness as test/helpdesk-workflow.test.ts: next/headers and lib/ee
// stubbed, requests raised and solved through the core (createTicket,
// updateTicket), routes called with real sessions. Parallel-safe: every
// team, type, workflow and account is this file's own; desk roles are
// explicit hd_agent_roles rows on this file's accounts only.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-workflow-teams.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-workflow-teams.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-workflow-teams.virtual.js");
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
  ee.exports = { ee: () => edition, eePresent: () => true, featureEnabled: async (f: string) => edition.features.includes(f) };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (r: string, p: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const engine = require("../src/lib/helpdesk/engine") as typeof import("../src/lib/helpdesk/engine");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const outcomeRoute = require("../src/app/api/helpdesk/tickets/[number]/task-outcome/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/task-outcome/route");
const contextRoute = require("../src/app/api/helpdesk/tickets/[number]/workflow-context/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/workflow-context/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const retryRoute = require("../src/app/api/helpdesk/runs/[id]/retry-step/route") as typeof import("../src/app/api/helpdesk/runs/[id]/retry-step/route");
const skipRoute = require("../src/app/api/helpdesk/runs/[id]/skip-step/route") as typeof import("../src/app/api/helpdesk/runs/[id]/skip-step/route");
const cancelRoute = require("../src/app/api/helpdesk/runs/[id]/cancel/route") as typeof import("../src/app/api/helpdesk/runs/[id]/cancel/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdFormField, HdStatus, HdTicket } from "../src/lib/helpdesk/types";

const HD_STATUSES: readonly string[] = ["new", "open", "pending", "on_hold", "solved", "closed"] satisfies readonly HdStatus[];
import type { HdWorkflowStepB } from "../src/lib/helpdesk/types";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string>): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* none */
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

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdwft-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
}
const p: Record<string, Person> = {};
const personIds: number[] = [];
const teams: Record<string, number> = {};
const workflowIds: number[] = [];
const typeIds: number[] = [];
const ticketIds: number[] = [];

async function person(key: string, name: string, deskRole?: "agent" | "team_lead"): Promise<Person> {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    `${STAMP}-${key}@example.test`,
  ]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2)", [id, deskRole]);
  personIds.push(id);
  p[key] = { id, session, name };
  return p[key];
}

async function team(key: string, name: string, members: [string, "agent" | "lead"][]) {
  const r = await pool().query("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} ${name}`]);
  teams[key] = r.rows[0].id;
  for (const [k, role] of members) await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3)", [teams[key], p[k].id, role]);
}

const FORM: HdFormField[] = [
  { key: "needs_laptop", label: "Needs a laptop", type: "checkbox" },
  { key: "start_date", label: "Start date", type: "date" },
];

let seq = 0;
async function publishedType(steps: HdWorkflowStepB[], teamKey = "hr") {
  const n = ++seq;
  const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} Flow ${n}` });
  assert.ok(meta.ok);
  const def = workflows.parseWorkflowDefinition({ steps });
  assert.ok(def.ok, !def.ok ? def.error : "");
  if (!meta.ok || !def.ok) throw new Error("bad fixture");
  const wf = await workflows.createWorkflow(meta.value, def.value);
  workflowIds.push(wf.id);
  const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Type ${n}`, team_id: teams[teamKey], form: FORM, workflow_id: wf.id });
  assert.ok(input.ok, !input.ok ? input.error : "");
  if (!input.ok) throw new Error("bad fixture");
  const rt = await requestTypes.createRequestType(input.value);
  typeIds.push(rt.id);
  const pub = await workflows.publishWorkflow(wf.id);
  assert.ok(pub.ok, !pub.ok ? pub.error : "");
  return { workflowId: wf.id, typeId: rt.id };
}

async function raise(typeId: number, answers: Record<string, unknown>): Promise<HdTicket> {
  const t = await tickets.createTicket(
    {
      subject: `${STAMP} new starter`,
      body: "Kim starts soon.",
      requester: { id: p.req.id, name: p.req.name, email: `${STAMP}@example.test` },
      request_type_id: typeId,
      answers: answers as never,
    },
    { silent: true, actorId: p.req.id, actorName: p.req.name }
  );
  ticketIds.push(t.id);
  return (await tickets.getTicketById(t.id))!;
}

const runOf = async (ticketId: number) => (await pool().query("SELECT * FROM hd_workflow_runs WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [ticketId])).rows[0];
const stepOf = async (runId: number, key: string) => (await pool().query("SELECT * FROM hd_workflow_steps WHERE run_id = $1 AND step_key = $2", [runId, key])).rows[0];
const kids = async (ticketId: number) => (await pool().query("SELECT * FROM hd_tickets WHERE parent_ticket_id = $1 ORDER BY id", [ticketId])).rows;
const row = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const lines = async (ticketId: number, kind = "system") =>
  (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = $2 ORDER BY id", [ticketId, kind])).rows.map((r) => r.body as string);
const outcome = (who: Person, number: number, body: unknown) => call(outcomeRoute.POST, req(`/tickets/${number}/task-outcome`, who.session, body), { number: String(number) });

before(async () => {
  await getSetting("__schema_bootstrap__");
  await person("req", "Rhea Requester");
  await person("itl", "Liam London IT", "agent");
  await person("itp", "Pia Paris IT", "agent");
  await person("fac", "Fred Facilities", "agent");
  await person("hrl", "Hana HR Lead", "team_lead");
  await person("out", "Oscar Other Desk", "agent");
  await team("itLondon", "IT London", [["itl", "agent"]]);
  await team("itParis", "IT Paris", [["itp", "agent"]]);
  await team("fac", "Facilities", [["fac", "agent"]]);
  await team("hr", "HR", [["hrl", "lead"]]);
  await team("other", "Other", [["out", "agent"]]);
  const dp = await pool().query("INSERT INTO directory_people (name, email, office, department) VALUES ($1, $2, 'London', 'Sales') RETURNING id", [
    `${STAMP} Rhea`,
    `${STAMP}-dp@example.test`,
  ]);
  await pool().query("UPDATE users SET directory_person_id = $2 WHERE id = $1", [p.req.id, dp.rows[0].id]);
  email.setHelpdeskTransportForTests(async () => {});
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  const children = await pool().query("SELECT id FROM hd_tickets WHERE parent_ticket_id = ANY($1)", [ticketIds]);
  const all = [...ticketIds, ...children.rows.map((r) => r.id as number)];
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1)", [workflowIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(teams)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [personIds]);
  const dps = await pool().query("SELECT directory_person_id AS id FROM users WHERE id = ANY($1) AND directory_person_id IS NOT NULL", [personIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM directory_people WHERE id = ANY($1)", [dps.rows.map((r) => r.id)]);
  await pool().end();
});

// The starter flow of this file: a routed laptop task with a required
// hand-off, a desk task that runs only when the laptop was handed off,
// then a notice quoting the hand-off.
const starterSteps = (): HdWorkflowStepB[] => [
  {
    key: "laptop",
    kind: "task",
    title: "Order a laptop",
    team_id: teams.itParis,
    description: "A laptop for {{requester}}, starting {{start_date}}.",
    when: { match: "all", rules: [{ source: "answer", field: "needs_laptop", op: "is_true" }] },
    route: { source: "requester", field: "office", map: [{ value: "London", team_id: teams.itLondon }] },
    outputs: [
      { key: "asset_tag", label: "Asset tag", type: "text", required: true },
      { key: "imaged", label: "Imaged", type: "yes_no" },
    ],
  },
  {
    key: "desk",
    kind: "task",
    title: "Set up the desk",
    team_id: teams.fac,
    description: "Laptop {{outputs.laptop.asset_tag}} goes on the desk.",
    when: { match: "all", rules: [{ source: "output", field: "laptop.asset_tag", op: "not_empty" }] },
  },
  { key: "tell", kind: "notify", title: "Tell the requester", to: "requester", message: "Laptop {{outputs.laptop.asset_tag}} is on your desk." },
  { key: "done", kind: "finish", title: "Solve", csat: false },
];

// --- Conditions, routing, hand-offs ------------------------------------------------------

describe("conditions, routing and hand-offs", () => {
  test("routed by the requester's office; a required hand-off is asked before solving; it reaches later steps", async () => {
    const { typeId } = await publishedType(starterSteps());
    const t = await raise(typeId, { needs_laptop: true, start_date: "2026-12-01" });
    const [laptop] = await kids(t.id);
    assert.equal(laptop.team_id, teams.itLondon, "London routes to IT London");
    assert.ok((await lines(t.id)).some((b) => b === `Routed to ${STAMP} IT London (Office is London): Order a laptop.`));
    const note = (await lines(laptop.id, "internal")).join("\n");
    assert.ok(note.includes("A laptop for Rhea Requester, starting 2026-12-01."), "the description's placeholders are filled");
    assert.ok(note.includes("Asset tag (required)"));

    // A plain solve is refused while the required hand-off is missing.
    assert.deepEqual(await engine.validateTaskSolve(laptop.id), {
      error: "Record the hand-off before solving: Asset tag.",
      missing: [{ key: "asset_tag", label: "Asset tag" }],
      missing_keys: ["asset_tag"],
    });
    const patched = await call(ticketRoute.PATCH, req(`/tickets/${laptop.number}`, p.itl.session, { status: "solved" }, "PATCH"), { number: String(laptop.number) });
    assert.equal(patched.status, 409);
    assert.deepEqual(patched.body.missing, [{ key: "asset_tag", label: "Asset tag" }], "labelled");
    assert.deepEqual(patched.body.missing_keys, ["asset_tag"], "the keys too, for older clients");
    // The outcome form: missing → 400 with what is missing; outsiders → 404.
    assert.equal((await outcome(p.out, laptop.number, { outcome: "done" })).status, 404);
    const incomplete = await outcome(p.itl, laptop.number, { outcome: "done", outputs: { imaged: "yes" } });
    assert.equal(incomplete.status, 400);
    assert.deepEqual(incomplete.body.missing, [{ key: "asset_tag", label: "Asset tag" }]);
    assert.deepEqual(incomplete.body.missing_keys, ["asset_tag"]);
    const ok = await outcome(p.itl, laptop.number, { outcome: "done", outputs: { asset_tag: "LT-0042", imaged: "yes" }, handoff_note: "Charger in the drawer." });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.step_state, "done");
    assert.equal((await row(laptop.id)).status, "solved", "the task ticket is solved with the outcome");
    assert.equal(await engine.validateTaskSolve(laptop.id), null);
    assert.equal((await outcome(p.itl, laptop.number, { outcome: "done", outputs: { asset_tag: "x" } })).status, 409, "once");

    const handoff = (await lines(t.id)).find((b) => b.startsWith("Hand-off from"));
    assert.equal(handoff, `Hand-off from ${STAMP} IT London: Order a laptop\n\n- Asset tag: LT-0042\n- Imaged: Yes\n- Note: Charger in the drawer.`);
    // The desk task runs (the hand-off is there) and carries it.
    const desk = (await kids(t.id)).find((k) => k.team_id === teams.fac);
    assert.ok(desk);
    const deskNote = (await lines(desk.id, "internal")).join("\n");
    assert.ok(deskNote.includes("Laptop LT-0042 goes on the desk."));
    assert.ok(deskNote.includes("Hand-offs so far") && deskNote.includes("- Asset tag: LT-0042"));

    const progress = await engine.getWorkflowProgress(t.id, "requester");
    assert.deepEqual(progress!.steps[0].outputs, [
      { key: "asset_tag", label: "Asset tag", value: "LT-0042" },
      { key: "imaged", label: "Imaged", value: "Yes" },
    ]);
    assert.equal(progress!.steps[0].handoff_note, "Charger in the drawer.");
    assert.equal(progress!.steps[0].actor, "Liam London IT");
    assert.equal(progress!.steps[0].reason, "Routed: Office is London");
    assert.deepEqual((await engine.getHandoffs(progress!.run_id)).map((h) => h.step_key), ["laptop"]);

    // Facilities finish by solving their ticket (nothing required): the notice quotes the hand-off.
    await tickets.updateTicket(desk.id, { status: "solved" }, { id: p.fac.id, name: p.fac.name }, { silent: true });
    assert.equal((await runOf(t.id)).state, "done");
    const bell = await pool().query("SELECT body FROM notifications WHERE user_id = $1 AND title LIKE 'Tell the requester%'", [p.req.id]);
    assert.ok(bell.rows.some((r) => String(r.body).includes("Laptop LT-0042 is on your desk.")), JSON.stringify(bell.rows));
  });

  test("a false condition skips the step with the reason on the request", async () => {
    const { typeId } = await publishedType(starterSteps());
    const t = await raise(typeId, { needs_laptop: false, start_date: "2026-12-01" });
    assert.equal((await kids(t.id)).length, 0);
    const said = await lines(t.id);
    assert.ok(said.includes("Skipped: Order a laptop (Needs a laptop is No)."), JSON.stringify(said));
    assert.ok(said.includes("Skipped: Set up the desk (Asset tag is empty)."));
    const r = await runOf(t.id);
    assert.equal(r.state, "done");
    assert.equal((await stepOf(r.id, "laptop")).state, "skipped");
    const progress = await engine.getWorkflowProgress(t.id, "requester");
    assert.equal(progress!.steps[0].state, "skipped");
    assert.equal(progress!.steps[0].detail, "Skipped: Needs a laptop is No");
  });

  test("no route matches and no fallback: the task's own team; a fallback when given", async () => {
    await pool().query("UPDATE directory_people SET office = 'Lisbon' WHERE id = (SELECT directory_person_id FROM users WHERE id = $1)", [p.req.id]);
    try {
      const { typeId } = await publishedType(starterSteps());
      const t = await raise(typeId, { needs_laptop: true });
      assert.equal((await kids(t.id))[0].team_id, teams.itParis);
      const steps = starterSteps();
      (steps[0] as { route: { fallback_team_id?: number } }).route.fallback_team_id = teams.fac;
      const second = await publishedType(steps);
      const t2 = await raise(second.typeId, { needs_laptop: true });
      assert.equal((await kids(t2.id))[0].team_id, teams.fac);
      assert.ok((await lines(t2.id)).some((b) => b.includes("(Office is Lisbon, so the fallback team)")));
      for (const x of [t, t2]) await engine.cancelRun((await runOf(x.id)).id);
    } finally {
      await pool().query("UPDATE directory_people SET office = 'London' WHERE id = (SELECT directory_person_id FROM users WHERE id = $1)", [p.req.id]);
    }
  });
});

// --- Can't be done -------------------------------------------------------------------------

describe("can't be done", () => {
  const groupSteps = (onCantDo: "stop" | "continue"): HdWorkflowStepB[] => [
    {
      key: "prep",
      kind: "parallel",
      title: "Get ready",
      steps: [
        { key: "it", kind: "task", title: "Laptop", team_id: teams.itLondon, on_cant_do: onCantDo },
        { key: "fac", kind: "task", title: "Desk", team_id: teams.fac },
      ],
    },
    { key: "done", kind: "finish", title: "Solve", csat: false },
  ];

  test("stop: the run goes on hold for the coordinating team, who retry it", async () => {
    const { typeId } = await publishedType(groupSteps("stop"));
    const t = await raise(typeId, {});
    const [it, fac] = await kids(t.id);
    assert.equal((await outcome(p.itl, it.number, { outcome: "cant_do" })).status, 400, "a note is required");
    const res = await outcome(p.itl, it.number, { outcome: "cant_do", note: "Out of stock until January." });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.run_state, "blocked");
    const r = await runOf(t.id);
    assert.equal(r.state, "blocked");
    assert.equal(r.current.blocked.step_key, "it");
    assert.equal((await stepOf(r.id, "it")).state, "failed");
    assert.equal((await stepOf(r.id, "it")).result.note, "Out of stock until January.");
    assert.equal((await row(it.id)).status, "solved", "the task ticket closes with its outcome");
    const parent = await row(t.id);
    assert.equal(parent.status, "open");
    assert.equal(parent.team_id, teams.hr, "back with the coordinating team");
    assert.ok((await lines(t.id, "internal")).some((b) => b.includes("The workflow is on hold")));
    const bell = await pool().query("SELECT title FROM notifications WHERE user_id = $1 AND title LIKE 'Workflow on hold%'", [p.hrl.id]);
    assert.equal(bell.rowCount, 1, "the coordinating team's lead is told");
    const asAgent = await engine.getWorkflowProgress(t.id, "agent");
    assert.equal(asAgent!.state, "blocked");
    assert.equal(asAgent!.blocked!.note, "Out of stock until January.");
    assert.equal(asAgent!.steps[0].state, "failed");
    const asRequester = await engine.getWorkflowProgress(t.id, "requester");
    assert.equal(asRequester!.blocked!.note, "", "requesters do not read the failure note");

    // The sibling finishes while the run is on hold; nothing moves yet.
    const facDone = await outcome(p.fac, fac.number, { outcome: "done" });
    assert.equal(facDone.status, 200);
    assert.equal((await runOf(t.id)).state, "blocked");

    // Only someone who works the request coordinates.
    assert.equal((await call(retryRoute.POST, req(`/runs/${r.id}/retry-step`, p.out.session, {}), { id: String(r.id) })).status, 404);
    assert.equal((await call(retryRoute.POST, req(`/runs/${r.id}/retry-step`, p.itl.session, {}), { id: String(r.id) })).status, 404);
    const retried = await call(retryRoute.POST, req(`/runs/${r.id}/retry-step`, p.hrl.session, {}), { id: String(r.id) });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.run_state, "running");
    const again = (await kids(t.id)).filter((k) => k.team_id === teams.itLondon);
    assert.equal(again.length, 2, "a new task ticket for the same team");
    const step = await stepOf(r.id, "it");
    assert.equal(step.state, "active");
    assert.equal(step.task_ticket_id, again[1].id);
    assert.equal(step.result.attempts, 2);
    assert.equal(step.result.attempt_log[0].note, "Out of stock until January.");
    assert.equal((await outcome(p.itl, again[1].number, { outcome: "done" })).status, 200);
    assert.equal((await runOf(t.id)).state, "done");
    assert.equal((await row(t.id)).status, "solved");
    const audited = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.workflow_run.step_retried' AND actor_id = $1", [p.hrl.id]);
    assert.equal(audited.rowCount, 1);
  });

  test("stop, then skip or cancel", async () => {
    const { typeId } = await publishedType(groupSteps("stop"));
    const a = await raise(typeId, {});
    await outcome(p.itl, (await kids(a.id))[0].number, { outcome: "cant_do", note: "No." });
    await outcome(p.fac, (await kids(a.id))[1].number, { outcome: "done" });
    const ra = await runOf(a.id);
    const skipped = await call(skipRoute.POST, req(`/runs/${ra.id}/skip-step`, p.hrl.session, { note: "They'll bring their own." }), { id: String(ra.id) });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
    assert.equal((await runOf(a.id)).state, "done");
    assert.equal((await stepOf(ra.id, "it")).state, "skipped");
    assert.ok((await lines(a.id)).some((b) => b.startsWith(`Skipped by Hana HR Lead: Laptop. "They'll bring their own."`)));
    assert.equal((await call(skipRoute.POST, req(`/runs/${ra.id}/skip-step`, p.hrl.session, {}), { id: String(ra.id) })).status, 409, "not on hold");

    const b = await raise(typeId, {});
    await outcome(p.itl, (await kids(b.id))[0].number, { outcome: "cant_do", note: "No." });
    const rb = await runOf(b.id);
    const cancelled = await call(cancelRoute.POST, req(`/runs/${rb.id}/cancel`, p.hrl.session, { note: "Hire withdrawn." }), { id: String(rb.id) });
    assert.equal(cancelled.status, 200);
    assert.equal((await runOf(b.id)).state, "cancelled");
    assert.ok((await lines(b.id)).some((b2) => b2.includes("was stopped by Hana HR Lead") && b2.includes("Hire withdrawn.")));
  });

  test("continue: the step is failed and the workflow carries on", async () => {
    const { typeId } = await publishedType(groupSteps("continue"));
    const t = await raise(typeId, {});
    const [it, fac] = await kids(t.id);
    await outcome(p.itl, it.number, { outcome: "cant_do", note: "Not this week." });
    assert.equal((await runOf(t.id)).state, "running");
    await outcome(p.fac, fac.number, { outcome: "done" });
    const r = await runOf(t.id);
    assert.equal(r.state, "done");
    assert.equal((await stepOf(r.id, "it")).state, "failed");
  });
});

// --- The task team's view of the request ----------------------------------------------------

describe("workflow context", () => {
  test("task teams read the request: answers, public messages only, progress, siblings", async () => {
    const { typeId } = await publishedType([
      {
        key: "prep",
        kind: "parallel",
        steps: [
          { key: "it", kind: "task", title: "Laptop", team_id: teams.itLondon, outputs: [{ key: "tag", label: "Tag", type: "text" }] },
          { key: "fac", kind: "task", title: "Desk", team_id: teams.fac },
        ],
      },
    ]);
    const t = await raise(typeId, { needs_laptop: true, start_date: "2026-12-01" });
    await messages.addMessage(t.id, { kind: "internal", body: `${STAMP} secret internal note`, author: { id: p.hrl.id, name: p.hrl.name, email: "" }, via: "desk" }, { silent: true });
    const [it, fac] = await kids(t.id);
    await outcome(p.itl, it.number, { outcome: "done", outputs: { tag: "T-9" } });

    const got = await call(contextRoute.GET, req(`/tickets/${fac.number}/workflow-context`, p.fac.session), { number: String(fac.number) });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const ctx = got.body.context;
    assert.equal(ctx.request.number, t.number);
    assert.equal(ctx.requester.name, "Rhea Requester");
    assert.equal(ctx.form_answers.start_date, "2026-12-01");
    assert.ok(ctx.messages.every((m: any) => m.kind === "public"));
    assert.ok(ctx.messages.some((m: any) => m.body === "Kim starts soon."));
    assert.equal(JSON.stringify(ctx).includes("secret internal note"), false, "no internal notes");
    assert.deepEqual(ctx.handoffs.map((h: any) => [h.step_key, h.outputs[0].value]), [["it", "T-9"]]);
    const sib = Object.fromEntries(ctx.siblings.map((s: any) => [s.step_key, s]));
    assert.equal(sib.fac.can_open, true);
    assert.equal(sib.it.can_open, false, "a sibling's ticket is linked only for its own team");
    assert.equal(sib.it.number, it.number);
    assert.equal(ctx.workflow.steps[0].children[0].team_name, `${STAMP} IT London`);

    // The request itself, by its coordinating team; not by another desk, not by the requester.
    assert.equal((await call(contextRoute.GET, req(`/tickets/${t.number}/workflow-context`, p.hrl.session), { number: String(t.number) })).status, 200);
    assert.equal((await call(contextRoute.GET, req(`/tickets/${fac.number}/workflow-context`, p.out.session), { number: String(fac.number) })).status, 404);
    assert.equal((await call(contextRoute.GET, req(`/tickets/${fac.number}/workflow-context`, p.req.session), { number: String(fac.number) })).status, 403);
    await engine.cancelRun((await runOf(t.id)).id);
  });
});

describe("workflow context: the task's own step and the viewer", () => {
  const ctxOf = async (who: Person, number: number) => {
    const got = await call(contextRoute.GET, req(`/tickets/${number}/workflow-context`, who.session), { number: String(number) });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    return got.body.context;
  };

  test("task: hand-off fields, on_cant_do and the coordinating team from the run's pinned definition, not a newer version", async () => {
    const v1: HdWorkflowStepB[] = [
      {
        key: "prep",
        kind: "parallel",
        title: "Get ready",
        steps: [
          { key: "it", kind: "task", title: "Laptop", team_id: teams.itLondon, outputs: [{ key: "tag", label: "Asset tag", type: "text", required: true }] },
          { key: "fac", kind: "task", title: "Desk", team_id: teams.fac, on_cant_do: "continue" },
        ],
      },
    ];
    const { typeId, workflowId } = await publishedType(v1);
    const t = await raise(typeId, {});
    const [it, fac] = await kids(t.id);

    // A newer version: the laptop task carries on and asks for something else; the desk task stops.
    const v2 = JSON.parse(JSON.stringify(v1));
    v2[0].steps[0].title = "Laptop (v2)";
    v2[0].steps[0].on_cant_do = "continue";
    v2[0].steps[0].outputs = [{ key: "serial", label: "Serial number", type: "text" }];
    v2[0].steps[1].on_cant_do = "stop";
    await pool().query("UPDATE hd_workflows SET draft = $2::jsonb WHERE id = $1", [workflowId, JSON.stringify({ trigger: {}, steps: v2 })]);
    const pub = await workflows.publishWorkflow(workflowId);
    assert.ok(pub.ok && pub.version === 2, JSON.stringify(pub));

    const itCtx = await ctxOf(p.itl, it.number);
    assert.deepEqual(itCtx.task, {
      step_key: "it",
      title: "Laptop",
      outputs: [{ key: "tag", label: "Asset tag", type: "text", required: true }],
      on_cant_do: "stop",
      coordinating_team: { id: teams.hr, name: `${STAMP} HR` },
    });
    const facCtx = await ctxOf(p.fac, fac.number);
    assert.equal(facCtx.task.on_cant_do, "continue", "a Carry on step says so (the dialog's wording)");
    assert.deepEqual(facCtx.task.outputs, []);
    assert.equal(facCtx.task.coordinating_team.name, `${STAMP} HR`);
    // The request itself has no task of its own.
    assert.equal((await ctxOf(p.hrl, t.number)).task, null);

    // A request raised now runs version 2.
    const t2 = await raise(typeId, {});
    const [it2, fac2] = await kids(t2.id);
    const it2Ctx = await ctxOf(p.itl, it2.number);
    assert.equal(it2Ctx.task.title, "Laptop (v2)");
    assert.equal(it2Ctx.task.on_cant_do, "continue");
    assert.deepEqual(it2Ctx.task.outputs.map((o: any) => o.label), ["Serial number"]);
    assert.equal((await ctxOf(p.fac, fac2.number)).task.on_cant_do, "stop");

    // The engine agrees with what the context said: the pinned "stop" blocks the first run, the pinned "continue" carries on.
    await outcome(p.itl, it.number, { outcome: "cant_do", note: "None left." });
    assert.equal((await runOf(t.id)).state, "blocked");
    await outcome(p.itl, it2.number, { outcome: "cant_do", note: "None left." });
    assert.equal((await runOf(t2.id)).state, "running");
    for (const x of [t, t2]) await engine.cancelRun((await runOf(x.id)).id);
  });

  test("viewer: the caller's teams with a task on it, and whether they may work the request", async () => {
    const { typeId } = await publishedType([
      {
        key: "prep",
        kind: "parallel",
        steps: [
          { key: "it", kind: "task", title: "Laptop", team_id: teams.itLondon },
          { key: "fac", kind: "task", title: "Desk", team_id: teams.fac },
        ],
      },
    ]);
    const t = await raise(typeId, {});
    const [it, fac] = await kids(t.id);
    const facCtx = await ctxOf(p.fac, fac.number);
    assert.deepEqual(facCtx.viewer, { team_names: [`${STAMP} Facilities`], can_work_request: false });
    // Statuses are the ticket's own (HdStatus), for the UI's HD_STATUS_LABEL.
    assert.ok(HD_STATUSES.includes(facCtx.request.status), facCtx.request.status);
    assert.ok(facCtx.siblings.length === 2 && facCtx.siblings.every((s: any) => HD_STATUSES.includes(s.status)));
    // The coordinator: works the request, has no task on it.
    assert.deepEqual((await ctxOf(p.hrl, it.number)).viewer, { team_names: [], can_work_request: true });
    // Assigned a sibling task outside their team: that task's team is why they see it too.
    await pool().query("UPDATE hd_tickets SET assignee_id = $2 WHERE id = $1", [it.id, p.fac.id]);
    assert.deepEqual((await ctxOf(p.fac, fac.number)).viewer.team_names, [`${STAMP} IT London`, `${STAMP} Facilities`]);
    await engine.cancelRun((await runOf(t.id)).id);
  });
});

// --- Transfers and time per team -------------------------------------------------------------

describe("transfers", () => {
  test("a task moved to another team takes its step along, with a history", async () => {
    const { typeId } = await publishedType([{ key: "it", kind: "task", title: "Set up laptop", team_id: teams.itLondon }]);
    const t = await raise(typeId, {});
    const [child] = await kids(t.id);
    const r = await runOf(t.id);
    const before = await stepOf(r.id, "it");
    assert.equal(before.result.started_team_id, teams.itLondon);
    assert.ok(before.started_at);
    // The core's update calls the engine's transfer hook after its commit.
    await tickets.updateTicket(child.id, { team_id: teams.fac }, { id: p.itl.id, name: p.itl.name }, { silent: true });
    const s = await stepOf(r.id, "it");
    assert.equal(s.result.team_id, teams.fac);
    assert.equal(s.result.team_name, `${STAMP} Facilities`);
    assert.equal(s.result.transfers.length, 1);
    // The same team again is no move.
    await engine.onTaskTransferred(child.id, teams.fac, teams.fac);
    assert.equal((await stepOf(r.id, "it")).result.transfers.length, 1);
    assert.equal(s.result.transfers.at(-1).from_team_id, teams.itLondon);
    assert.equal(s.result.transfers.at(-1).to_team_id, teams.fac);
    // Who moved it, from the core's update (its actor reaches the hook).
    assert.equal(s.result.transfers.at(-1).actor_id, p.itl.id);
    assert.equal(s.result.transfers.at(-1).actor_name, "Liam London IT");
    assert.equal(s.result.transfers.at(-1).note, undefined, "no note unless one is given");
    assert.ok((await lines(t.id)).includes(`Task moved from ${STAMP} IT London to ${STAMP} Facilities: Set up laptop.`));
    // A move with a note (and an actor named by id only): both recorded; the agents' progress carries them.
    await engine.onTaskTransferred(child.id, teams.fac, teams.itLondon, { actor: { id: p.fac.id, name: "" }, note: "  Wrong desk, sorry.  " });
    const moved = (await stepOf(r.id, "it")).result.transfers;
    assert.equal(moved.length, 2);
    assert.deepEqual(
      { by: moved[1].actor_id, name: moved[1].actor_name, note: moved[1].note },
      { by: p.fac.id, name: "Fred Facilities", note: "Wrong desk, sorry." }
    );
    // An engine-made move (no actor): no actor fields, as before.
    await engine.onTaskTransferred(child.id, teams.itLondon, teams.fac);
    const third = (await stepOf(r.id, "it")).result.transfers[2];
    assert.equal("actor_id" in third, false);
    const agentView = await engine.getWorkflowProgress(t.id, "agent");
    assert.equal(agentView!.steps[0].transfers![1].actor_name, "Fred Facilities");
    assert.equal((await engine.getWorkflowProgress(t.id, "requester"))!.steps[0].transfers, undefined, "requesters never read transfers");
    await outcome(p.fac, child.number, { outcome: "done" });
    const done = await stepOf(r.id, "it");
    assert.equal(done.state, "done");
    assert.ok(done.finished_at && done.result.outcome === "done" && done.result.solved_by_id === p.fac.id, "time per team: who, when, outcome");
  });
});

// --- Publish checks and the dry run ------------------------------------------------------------

describe("checks", () => {
  test("conditions and routes are checked when saved and published", async () => {
    const check = async (steps: unknown[]) => {
      const parsed = workflows.parseWorkflowDefinition({ steps });
      if (!parsed.ok) return parsed.error;
      const refs = await workflows.checkWorkflowRefs(parsed.value, FORM);
      return refs.ok ? null : refs.error;
    };
    const task = { key: "t", kind: "task", title: "T", team_id: teams.fac };
    assert.ok(await check([{ ...task, when: { match: "all", rules: [{ source: "answer", field: "nope", op: "is_true" }] } }]));
    assert.ok(await check([{ ...task, when: { match: "all", rules: [{ source: "requester", field: "shoe_size", op: "not_empty" }] } }]));
    assert.ok(await check([{ ...task, when: { match: "all", rules: [{ source: "answer", field: "needs_laptop", op: "equals" }] } }]), "a value is needed");
    assert.ok(await check([{ ...task, route: { source: "requester", field: "office", map: [] } }]), "an empty map");
    assert.ok(await check([{ ...task, route: { source: "requester", field: "office", map: [{ value: "X", team_id: 2_000_000_000 }] } }]), "a deleted team");
    assert.ok(
      await check([
        { ...task, when: { match: "all", rules: [{ source: "output", field: "later.tag", op: "not_empty" }] } },
        { key: "later", kind: "task", title: "L", team_id: teams.fac, outputs: [{ key: "tag", label: "Tag", type: "text" }] },
      ]),
      "a hand-off from a later step"
    );
    assert.ok(await check([{ ...task, outputs: [{ key: "s", label: "S", type: "select" }] }]), "a select needs options");
    assert.ok(await check([{ ...task, on_cant_do: "panic" }]));
    assert.equal(await check(starterSteps()), null);
  });

  test("the dry run reports skips and routes with their reasons", async () => {
    const { typeId } = await publishedType(starterSteps());
    const sim = await workflows.simulateWorkflow({ steps: starterSteps() }, { answers: { needs_laptop: false }, requester_id: p.req.id, request_type_id: typeId }, p.hrl);
    assert.ok(sim.ok);
    if (!sim.ok) return;
    assert.equal(sim.value.steps[0].skipped, true);
    assert.equal(sim.value.steps[0].reason, "Needs a laptop is No");
    const routed = await workflows.simulateWorkflow(
      { steps: starterSteps() },
      { answers: { needs_laptop: true }, requester_id: p.req.id, request_type_id: typeId, outputs: { laptop: { asset_tag: "LT-1" } } },
      p.hrl
    );
    assert.ok(routed.ok);
    if (!routed.ok) return;
    assert.equal(routed.value.steps[0].team_name, `${STAMP} IT London`);
    assert.equal(routed.value.steps[0].reason, "Office is London");
    assert.equal(routed.value.steps[1].skipped, undefined, "the sample hand-off satisfies the desk's condition");
  });
});
