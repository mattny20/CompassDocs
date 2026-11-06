// Helpdesk 1.19.0 review fixes (S1): regression tests for the confirmed
// findings in the workflow engine, approvals, space access, macros and
// attachments.
//
//   #1/#2  a space is granted only by a "Request access" run whose
//          space-owner approval was asked about that same space; a
//          requester can name a space only on that type, and only a
//          private space they cannot read
//   #20    requesters never see the space owner's name (no oracle)
//   #6/#12 applying a macro checks the per-field capabilities, the
//          newbie review, and a workflow task's required hand-off
//   #13    the decision notice says what really happened
//   #17    files on held or returned replies are agents' only
//   #34    the approval card's opening message is never a held reply
//   #23    deleting a task ticket moves its run on
//   #24    every solve path asks for a task's required hand-off
//   #25    a workflow solving a paused request banks the paused time
//   #27    an approval whose team or person is deleted gets a stand-in
//
// Parallel-safe: every account, team, space, type, workflow and macro is
// this file's own (STAMP); nobody is a workspace administrator; the sweep
// runs with claim:false and this file's run ids.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-review-fixes-s1.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-s1.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-s1.virtual.js");
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
const engine = require("../src/lib/helpdesk/engine") as typeof import("../src/lib/helpdesk/engine");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const approvals = require("../src/lib/helpdesk/approvals") as typeof import("../src/lib/helpdesk/approvals");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const macros = require("../src/lib/helpdesk/macros") as typeof import("../src/lib/helpdesk/macros");
const attachments = require("../src/lib/helpdesk/attachments") as typeof import("../src/lib/helpdesk/attachments");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const requestsRoute = require("../src/app/api/helpdesk/requests/route") as typeof import("../src/app/api/helpdesk/requests/route");
const approvalRoute = require("../src/app/api/helpdesk/approvals/[id]/route") as typeof import("../src/app/api/helpdesk/approvals/[id]/route");
const macroRoute = require("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const attachmentRoute = require("../src/app/api/helpdesk/attachments/[id]/route") as typeof import("../src/app/api/helpdesk/attachments/[id]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdFormField, HdTicket, HdWorkflowStep } from "../src/lib/helpdesk/types";

type AnyHandler = (req: Request, ctx?: any) => Promise<Response>;

async function call(handler: AnyHandler, req: Request, params?: Record<string, string>): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = params ? await handler(req, { params: Promise.resolve(params) }) : await handler(req);
    let body: any = null;
    try {
      body = await res.clone().json();
    } catch {
      /* not JSON (a file) */
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

const STAMP = `hds1-${Date.now()}-${process.pid}`;
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
const spaceIds: number[] = [];
const workflowIds: number[] = [];
const typeIds: number[] = [];
const ticketIds: number[] = [];
const macroIds: number[] = [];
const mail: { to: string; subject: string; text: string }[] = [];
let IT = 0;
let OTHER = 0;
let finance = 0; // private, owned by P.owner
let legal = 0; // private, no owner
let known = 0; // private, P.req already reads it
let open = 0; // internal
let uploadDirectory = "";

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

async function space(name: string, visibility: string, ownerId?: number): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility, policy_defaults) VALUES ($1, $2, '🔒', '', $3, $4::jsonb) RETURNING id`,
    [`${STAMP} ${name}`, `${STAMP}-${name.toLowerCase()}`, visibility, JSON.stringify(ownerId ? { owner_user_id: ownerId } : {})]
  );
  spaceIds.push(r.rows[0].id);
  return r.rows[0].id;
}

const FORM: HdFormField[] = [{ key: "why", label: "Why", type: "text" }];

let wfSeq = 0;
async function publishedType(steps: HdWorkflowStep[], opts: { team?: number } = {}) {
  const n = ++wfSeq;
  const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} Flow ${n}` });
  assert.ok(meta.ok, !meta.ok ? meta.error : "");
  const def = workflows.parseWorkflowDefinition({ trigger: {}, steps });
  assert.ok(def.ok, !def.ok ? def.error : "");
  const wf = await workflows.createWorkflow(meta.value, def.value);
  workflowIds.push(wf.id);
  const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Type ${n}`, team_id: opts.team ?? IT, form: FORM, workflow_id: wf.id });
  assert.ok(input.ok, !input.ok ? input.error : "");
  const rt = await requestTypes.createRequestType(input.value);
  typeIds.push(rt.id);
  const pub = await workflows.publishWorkflow(wf.id);
  assert.ok(pub.ok, !pub.ok ? pub.error : "");
  return rt.id;
}

async function raise(by: Person, typeId: number | null, extra: { source?: any; source_ref?: Record<string, unknown>; body?: string; team_id?: number } = {}): Promise<HdTicket> {
  const t = await tickets.createTicket(
    {
      subject: `${STAMP} request`,
      body: extra.body ?? "Please sort this out, thank you.",
      requester: { id: by.id, name: by.name, email: by.email },
      request_type_id: typeId,
      team_id: extra.team_id,
      answers: {} as never,
      source: extra.source,
      source_ref: extra.source_ref,
    } as never,
    { silent: true, actorId: by.id, actorName: by.name }
  );
  ticketIds.push(t.id);
  return (await tickets.getTicketById(t.id))!;
}

const runOf = async (ticketId: number) => (await pool().query("SELECT * FROM hd_workflow_runs WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [ticketId])).rows[0];
const approvalOf = async (ticketId: number) => (await pool().query("SELECT * FROM hd_approvals WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [ticketId])).rows[0];
const childrenOf = async (ticketId: number) => (await pool().query("SELECT * FROM hd_tickets WHERE parent_ticket_id = $1 ORDER BY id", [ticketId])).rows;
const ticketRow = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const messages = async (ticketId: number, kinds = ["public", "system", "internal"]) =>
  (await pool().query("SELECT kind, body, review_state FROM hd_messages WHERE ticket_id = $1 AND kind = ANY($2) ORDER BY id", [ticketId, kinds])).rows as {
    kind: string;
    body: string;
    review_state: string | null;
  }[];
const spaceGrants = async (userId: number) =>
  (
    await pool().query(
      `SELECT ra.space_id FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
        WHERE ra.user_id = $1 AND r.key = 'space-member' AND ra.scope_type = 'space' ORDER BY ra.space_id`,
      [userId]
    )
  ).rows.map((r) => r.space_id as number);
const decide = (who: Person, approvalId: number, body: unknown) =>
  call(approvalRoute.POST as AnyHandler, req(`/approvals/${approvalId}`, who.session, body), { id: String(approvalId) });

before(async () => {
  await getSetting("__schema_bootstrap__");
  await pool().query(roles.HD_ROLES_SCHEMA);
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "compass-hds1-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDirectory;
  for (const [k, n] of [
    ["req", "Daniel Okafor"],
    ["mgr", "Sara Haddad"],
    ["owner", "Olive Owner"],
    ["lead", "Matthew Felix"],
    ["agent", "Ivy Agent"],
    ["newbie", "Nia Newbie"],
    ["hr", "Hana HR"],
    ["gone", "Gil Gone"],
  ] as const) {
    await person(k, n);
  }
  // helpdesk.request for everyone (raise requests, read and decide approvals).
  const role = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-request`]);
  roleIds.push(role.rows[0].id);
  await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.request')", [role.rows[0].id]);
  for (const id of personIds) await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [role.rows[0].id, id]);
  for (const [k, r] of [["agent", "agent"], ["newbie", "newbie"]] as const) {
    await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [P[k].id, r]);
  }
  IT = await team("IT", [["lead", "lead"], ["agent", "agent"], ["newbie", "agent"]]);
  OTHER = await team("Other", []);

  // Daniel reports to Sara.
  const dp = await pool().query("INSERT INTO directory_people (name, email) VALUES ($1, $2), ($3, $4) RETURNING id", [
    `${STAMP} Daniel`,
    `${STAMP}-dp-req@example.test`,
    `${STAMP} Sara`,
    `${STAMP}-dp-mgr@example.test`,
  ]);
  const [reqPerson, mgrPerson] = dp.rows.map((r) => r.id as number);
  await pool().query("UPDATE users SET directory_person_id = $2 WHERE id = $1", [P.req.id, reqPerson]);
  await pool().query("UPDATE users SET directory_person_id = $2 WHERE id = $1", [P.mgr.id, mgrPerson]);
  await pool().query("INSERT INTO directory_person_links (person_id, field_key, target_id) VALUES ($1, 'manager', $2)", [reqPerson, mgrPerson]);

  finance = await space("Finance", "private", P.owner.id);
  legal = await space("Legal", "private");
  known = await space("Known", "private", P.owner.id);
  open = await space("Open", "internal", P.owner.id);
  await pool().query(
    `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT id, $1, 'space', $2 FROM roles WHERE key = 'space-member'`,
    [P.req.id, known]
  );

  notify.setAgentDeliverySpyForTests(() => {});
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push({ to: m.to, subject: m.subject, text: m.text });
  });
});

after(async () => {
  notify.setAgentDeliverySpyForTests(null);
  email.setHelpdeskTransportForTests(null);
  const kids = await pool().query("SELECT id FROM hd_tickets WHERE parent_ticket_id = ANY($1)", [ticketIds]);
  const all = [...ticketIds, ...kids.rows.map((r) => r.id as number)];
  for (const id of all) await attachments.deleteTicketFiles(id);
  await pool().query("DELETE FROM hd_attachments WHERE uploaded_by = ANY($1)", [personIds]);
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_macros WHERE id = ANY($1)", [macroIds]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1)", [workflowIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [teamIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR (target_type = 'space' AND target_id = ANY($2))", [
    personIds,
    spaceIds.map(String),
  ]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  const dps = await pool().query("SELECT directory_person_id AS id FROM users WHERE id = ANY($1) AND directory_person_id IS NOT NULL", [personIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM directory_people WHERE id = ANY($1)", [dps.rows.map((r) => r.id)]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [spaceIds]);
  await rm(uploadDirectory, { recursive: true, force: true });
  await pool().end();
});

const ACCESS_STEPS: HdWorkflowStep[] = [
  { key: "approve", kind: "approval", title: "The owner approves", approver: { kind: "space_owner" } as never, on_decline: "close" },
  { key: "done", kind: "finish", title: "Access granted", csat: false },
];
const LAPTOP_STEPS: HdWorkflowStep[] = [
  { key: "approve", kind: "approval", title: "Your manager approves", approver: { kind: "manager" }, on_decline: "close" },
  { key: "done", kind: "finish", title: "Ready to collect", csat: false },
];

const postRequest = (by: Person, body: Record<string, unknown>) => call(requestsRoute.POST as AnyHandler, req("/requests", by.session, body));
const ticketByNumber = async (n: number) => (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [n])).rows[0];
async function routeRaise(by: Person, body: Record<string, unknown>) {
  const r = await postRequest(by, { subject: `${STAMP} access`, body: "I need this for the audit.", ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const t = await ticketByNumber(r.body.ticket.number);
  ticketIds.push(t.id);
  return t;
}

// --- #1 / #2 / #20: space access ---------------------------------------------------

describe("space access (#1, #2, #20)", () => {
  let accessType = 0;
  let laptopType = 0;
  before(async () => {
    accessType = await publishedType(ACCESS_STEPS);
    laptopType = await publishedType(LAPTOP_STEPS);
  });

  test("a requester cannot attach a space to an unrelated type: it is dropped, and the manager's approval grants nothing", async () => {
    const t = await routeRaise(P.req, { request_type_id: laptopType, source: "space_access", source_ref: { space_id: finance } });
    assert.equal(t.source, "portal");
    assert.equal(t.source_ref.space_id, undefined);
    const a = await approvalOf(t.id);
    assert.equal(a.approver_user_id, P.mgr.id);
    assert.equal((await decide(P.mgr, a.id, { decision: "approved" })).status, 200);
    assert.equal((await runOf(t.id)).state, "done");
    assert.deepEqual(await spaceGrants(P.req.id), [known]);
  });

  test("the grant layer alone: a non-access run that names a space (written past the route) never grants", async () => {
    const t = await raise(P.req, laptopType, { source: "space_access", source_ref: { space_id: finance } });
    const a = await approvalOf(t.id);
    assert.equal((await decide(P.mgr, a.id, { decision: "approved" })).status, 200);
    assert.equal((await runOf(t.id)).state, "done");
    assert.deepEqual(await spaceGrants(P.req.id), [known]);
    assert.ok((await messages(t.id, ["internal"])).some((m) => m.body.startsWith("No access was granted")));
  });

  test("a space-owner approval asked about another space never grants this one", async () => {
    // A run whose space step was asked about Legal, while the request names Finance (a tampered row).
    const t = await raise(P.req, accessType, { source: "space_access", source_ref: { space_id: legal } });
    await pool().query("UPDATE hd_tickets SET source_ref = $2::jsonb WHERE id = $1", [t.id, JSON.stringify({ space_id: finance })]);
    const a = await approvalOf(t.id);
    assert.equal(a.approver_kind, "space");
    await pool().query("UPDATE hd_approvals SET decision = 'approved', decided_at = now() WHERE id = $1", [a.id]);
    await engine.advanceRun(a.run_id);
    assert.equal((await runOf(t.id)).state, "done");
    assert.deepEqual(await spaceGrants(P.req.id), [known]);
  });

  test("Request access from the trigger (slug): the owner sees the space on the card and approves; the requester never sees the owner's name", async () => {
    const t = await routeRaise(P.req, { request_type_id: accessType, source: "space_access", source_ref: { space_slug: `${STAMP}-finance` } });
    assert.equal(t.source, "space_access");
    assert.equal(t.source_ref.space_id, finance);
    const a = await approvalOf(t.id);
    assert.equal(a.approver_user_id, P.owner.id);

    // The approver's card names the space.
    const card = await call(approvalRoute.GET as AnyHandler, req(`/approvals/${a.id}`, P.owner.session), { id: String(a.id) });
    assert.equal(card.status, 200, JSON.stringify(card.body));
    const row = (card.body.approval ?? card.body).answers.find((x: { key: string }) => x.key === "_space");
    assert.equal(row?.value, `${STAMP} Finance`);

    // The requester: generic words only, on the timeline and the tracker.
    const publicText = (await messages(t.id, ["public", "system"])).map((m) => m.body).join("\n");
    assert.ok(publicText.includes("Waiting for approval from the people who look after the space"), publicText);
    assert.ok(!publicText.includes("Olive Owner"), publicText);
    const mine = await engine.getWorkflowProgress(t.id, "requester");
    assert.equal(mine!.steps[0].detail, "Waiting for the people who look after the space");
    const desk = await engine.getWorkflowProgress(t.id, "agent");
    assert.equal(desk!.steps[0].detail, "Waiting for Olive Owner");

    assert.equal((await decide(P.owner, a.id, { decision: "approved" })).status, 200);
    assert.deepEqual(await spaceGrants(P.req.id), [finance, known].sort((x, y) => x - y));
    await pool().query("DELETE FROM role_assignments WHERE user_id = $1 AND space_id = $2", [P.req.id, finance]);
  });

  test("a space that is missing, not private, or already readable is dropped, and the requester reads the same words for all of them (#20)", async () => {
    const seen: string[] = [];
    for (const ref of [{ space_id: 987_654_321 }, { space_id: open }, { space_id: known }, { space_slug: `${STAMP}-nope` }, { space_id: legal }]) {
      const t = await routeRaise(P.req, { request_type_id: accessType, source: "space_access", source_ref: ref });
      const kept = ref.space_id === legal;
      assert.equal(t.source_ref.space_id, kept ? legal : undefined, JSON.stringify(ref));
      seen.push(
        (await messages(t.id, ["public", "system"]))
          .map((m) => m.body)
          .join("\n")
      );
      const progress = await engine.getWorkflowProgress(t.id, "requester");
      assert.equal(progress!.steps[0].detail, "Waiting for the people who look after the space");
      await engine.cancelRun((await runOf(t.id)).id);
    }
    // The requester's timelines up to the cancel read alike (the opening message, then the same waiting line).
    const waiting = seen.map((s) => s.split("\n").filter((l) => l.startsWith("Waiting for approval")));
    for (const w of waiting) assert.deepEqual(w, waiting[0]);
  });

  test("the fallback approver (no space named) approving grants nothing", async () => {
    const t = await routeRaise(P.req, { request_type_id: accessType, source: "space_access", source_ref: { space_id: open } });
    const a = await approvalOf(t.id);
    assert.equal(a.approver_kind, "manager");
    assert.equal(a.approver_team_id, IT);
    assert.equal((await decide(P.lead, a.id, { decision: "approved" })).status, 200);
    assert.equal((await runOf(t.id)).state, "done");
    assert.deepEqual(await spaceGrants(P.req.id), [known]);
  });
});

// --- #13: what the decision notice says ------------------------------------------------

describe("decision notice (#13)", () => {
  test("a decline that closes the request says so; an approval that finishes it says it is complete", async () => {
    const typeId = await publishedType(LAPTOP_STEPS);
    const declined = await raise(P.req, typeId);
    mail.length = 0;
    assert.equal((await decide(P.mgr, (await approvalOf(declined.id)).id, { decision: "declined", note: "No budget." })).status, 200);
    const approved = await raise(P.req, typeId);
    assert.equal((await decide(P.mgr, (await approvalOf(approved.id)).id, { decision: "approved" })).status, 200);
    const mine = mail.filter((m) => m.to.includes(P.req.email));
    const text = mine.map((m) => m.text).join("\n---\n");
    assert.ok(mine.length >= 2, `mail to the requester: ${mine.length}`);
    assert.ok(text.includes("Your request has been closed."), text);
    assert.ok(text.includes("Your request is complete."), text);
    assert.ok(!text.includes("Your request carries on to the next step."), text);
  });
});

// --- #6 / #12: macros ------------------------------------------------------------------

describe("macros (#6, #12)", () => {
  const macro = async (body: string, actions: Record<string, unknown>) => {
    const m = await macros.createMacro({ title: `${STAMP} macro ${macroIds.length}`, body, actions: actions as never, team_id: IT }, null);
    macroIds.push(m.id);
    return m.id;
  };
  const apply = (who: Person, number: number, macroId: number) =>
    call(macroRoute.POST as AnyHandler, req(`/tickets/${number}/macro/${macroId}`, who.session, {}), { number: String(number), macroId: String(macroId) });

  test("a Newbie cannot solve, re-prioritise or transfer through a macro; nothing is posted", async () => {
    const t = await raise(P.req, null, { team_id: IT });
    const before = (await messages(t.id, ["public"])).length;
    for (const actions of [{ status: "solved" }, { priority: "urgent" }, { team_id: OTHER }]) {
      const id = await macro("Thanks, all sorted.", actions);
      const r = await apply(P.newbie, t.number, id);
      assert.equal(r.status, 403, JSON.stringify({ actions, body: r.body }));
    }
    const row = await ticketRow(t.id);
    assert.notEqual(row.status, "solved");
    assert.equal(row.priority, "normal");
    assert.equal(row.team_id, IT);
    assert.equal((await messages(t.id, ["public"])).length, before);
  });

  test("a Newbie's macro reply is held for review, and a held reply's status change waits with it", async () => {
    const t = await raise(P.req, null, { team_id: IT });
    const id = await macro("We're looking into it.", { tags_add: ["s1-tag"] });
    const r = await apply(P.newbie, t.number, id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.held, true);
    const held = (await messages(t.id, ["public"])).find((m) => m.body === "We're looking into it.");
    assert.equal(held?.review_state, "pending");
    assert.ok((await ticketRow(t.id)).tags.includes("s1-tag"));

    // The library path (as an automation would call it, no route checks): the reply is held, so "solved" waits.
    const solveId = await macro("All sorted, closing this.", { status: "solved" });
    const lib = await macros.applyMacroToTicket(t.id, solveId, { id: P.newbie.id, name: P.newbie.name, email: P.newbie.email });
    assert.ok(lib.ok);
    assert.equal(lib.ok && lib.held, true);
    assert.notEqual((await ticketRow(t.id)).status, "solved");
  });

  test("an Agent's solve macro on a workflow task with a required hand-off is refused with what is missing (409)", async () => {
    const typeId = await publishedType([
      { key: "it", kind: "task", title: "Laptop", team_id: IT, outputs: [{ key: "tag", label: "Asset tag", type: "text", required: true }] } as never,
      { key: "done", kind: "finish", title: "Done", csat: false },
    ]);
    const t = await raise(P.req, typeId);
    const [child] = await childrenOf(t.id);
    const id = await macro("Done, closing.", { status: "solved" });
    const r = await apply(P.agent, child.number, id);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(r.body.missing, ["tag"]);
    assert.equal((await ticketRow(child.id)).status === "solved", false);
    assert.equal((await messages(child.id, ["public"])).length, 0, "nothing posted");
  });
});

// --- #24: every solve path asks for the hand-off -------------------------------------------

describe("required hand-off (#24)", () => {
  test("updateTicket and a reply's then_status refuse to solve a task without its required outputs; recording them works", async () => {
    const typeId = await publishedType([
      { key: "it", kind: "task", title: "Laptop", team_id: IT, outputs: [{ key: "tag", label: "Asset tag", type: "text", required: true }] } as never,
      { key: "done", kind: "finish", title: "Done", csat: false },
    ]);
    const t = await raise(P.req, typeId);
    const [child] = await childrenOf(t.id);
    await assert.rejects(
      tickets.updateTicket(child.id, { status: "solved" }, { id: P.agent.id, name: P.agent.name }, { silent: true }),
      (e: unknown) => e instanceof tickets.HdTicketError && e.status === 409
    );
    const r = await call(
      messagesRoute.POST as AnyHandler,
      req(`/tickets/${child.number}/messages`, P.agent.session, { kind: "internal", body: "Handed over.", then_status: "solved" }),
      { number: String(child.number) }
    );
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(r.body.missing, [{ key: "tag", label: "Asset tag" }]);
    assert.deepEqual(r.body.missing_keys, ["tag"]);
    assert.equal((await messages(child.id, ["internal"])).filter((m) => m.body === "Handed over.").length, 0);
    assert.equal((await runOf(t.id)).state, "running");

    const done = await engine.recordTaskOutcome({ ...P.agent, username: P.agent.name }, child.id, { outcome: "done", outputs: { tag: "LT-1" } });
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal((await ticketRow(child.id)).status, "solved");
    assert.equal((await runOf(t.id)).state, "done");
  });
});

// --- #23: a deleted task ticket ------------------------------------------------------------

describe("deleted task ticket (#23)", () => {
  const TASK_STEPS = (): HdWorkflowStep[] => [
    { key: "it", kind: "task", title: "Set it up", team_id: IT } as never,
    { key: "done", kind: "finish", title: "Done", csat: false },
  ];

  test("the sweep moves a run on when its task ticket was deleted", async () => {
    const typeId = await publishedType(TASK_STEPS());
    const t = await raise(P.req, typeId);
    const [child] = await childrenOf(t.id);
    await tickets.deleteTicket(child.id);
    assert.equal((await runOf(t.id)).state, "running");
    const run = await runOf(t.id);
    const r = await engine.sweepWorkflows({ claim: false, runIds: [run.id] });
    assert.equal(r.advanced, 1);
    assert.equal((await runOf(t.id)).state, "done");
    assert.equal((await ticketRow(t.id)).status, "solved");
    assert.ok((await messages(t.id, ["internal"])).some((m) => m.body.includes("was deleted")));
  });

  test("the delete hook moves it on at once", async () => {
    const typeId = await publishedType(TASK_STEPS());
    const t = await raise(P.req, typeId);
    const [child] = await childrenOf(t.id);
    const row = await tickets.deleteTicket(child.id);
    await engine.onTaskTicketDeleted(row!.source_ref);
    assert.equal((await runOf(t.id)).state, "done");
  });
});

// --- #25: solving a paused request ---------------------------------------------------------

describe("paused request solved by the workflow (#25)", () => {
  test("the paused time is banked and sla_paused_at cleared", async () => {
    const typeId = await publishedType([
      { key: "it", kind: "task", title: "Set it up", team_id: IT } as never,
      { key: "done", kind: "finish", title: "Done", csat: false },
    ]);
    const t = await raise(P.req, typeId);
    await tickets.updateTicket(t.id, { status: "on_hold" }, { id: P.agent.id, name: P.agent.name }, { silent: true });
    const hourAgo = new Date(Date.now() - 3_600_000);
    await pool().query("UPDATE hd_tickets SET sla_paused_at = $2, sla_paused_ms = 1000 WHERE id = $1", [t.id, hourAgo]);
    const [child] = await childrenOf(t.id);
    await tickets.updateTicket(child.id, { status: "solved" }, { id: P.agent.id, name: P.agent.name }, { silent: true });
    const row = await ticketRow(t.id);
    assert.equal(row.status, "solved");
    assert.equal(row.sla_paused_at, null);
    assert.ok(Number(row.sla_paused_ms) >= 1000 + 3_600_000 - 5_000, String(row.sla_paused_ms));
  });
});

// --- #27: an approver who is gone ----------------------------------------------------------

describe("approver deleted (#27)", () => {
  test("a deleted approving team: the sweep hands the approval to the type's team leads, with a note", async () => {
    const doomed = await team("Doomed", [["hr", "agent"]]);
    const typeId = await publishedType([
      { key: "a", kind: "approval", title: "Doomed approves", approver: { kind: "team", team_id: doomed }, on_decline: "close" },
      { key: "done", kind: "finish", title: "Done", csat: false },
    ]);
    const t = await raise(P.req, typeId);
    const a = await approvalOf(t.id);
    await pool().query("DELETE FROM hd_teams WHERE id = $1", [doomed]);
    const r = await engine.sweepWorkflows({ claim: false, runIds: [a.run_id] });
    assert.equal(r.reassigned, 1);
    const after = await approvalOf(t.id);
    assert.equal(after.approver_kind, "manager");
    assert.equal(after.approver_team_id, IT);
    assert.deepEqual(await approvals.approverUserIds(a.id), [P.lead.id]);
    assert.ok((await messages(t.id, ["system"])).some((m) => m.body.includes("no longer exists")));
    assert.equal((await decide(P.lead, a.id, { decision: "approved" })).status, 200);
    assert.equal((await runOf(t.id)).state, "done");
  });

  test("a deleted named approver: the same stand-in", async () => {
    const typeId = await publishedType([
      { key: "a", kind: "approval", title: "Gil approves", approver: { kind: "user", user_id: P.gone.id }, on_decline: "close" },
      { key: "done", kind: "finish", title: "Done", csat: false },
    ]);
    const t = await raise(P.req, typeId);
    const a = await approvalOf(t.id);
    assert.equal(a.approver_user_id, P.gone.id);
    await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [P.gone.id]);
    const r = await engine.sweepWorkflows({ claim: false, runIds: [a.run_id] });
    assert.equal(r.reassigned, 1);
    assert.deepEqual(await approvals.approverUserIds(a.id), [P.lead.id]);
  });
});

// --- #17 / #34: held replies stay the desk's -------------------------------------------------

describe("held replies (#17, #34)", () => {
  test("a held reply's file is agents' only, and the approval card never shows the held reply as the opening message", async () => {
    const typeId = await publishedType(LAPTOP_STEPS);
    // A form-only request: no opening message.
    const t = await raise(P.req, typeId, { body: "" });
    const file = await attachments.saveHelpdeskAttachment({ buf: Buffer.from("payroll,secret\n1,2\n"), filename: "payroll.csv", userId: P.newbie.id });
    const posted = await call(
      messagesRoute.POST as AnyHandler,
      req(`/tickets/${t.number}/messages`, P.newbie.session, { kind: "public", body: "Draft: here is the payroll file.", attachments: [file.id] }),
      { number: String(t.number) }
    );
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal(posted.body.held, true);

    const download = (who: Person) => call(attachmentRoute.GET as AnyHandler, req(`/attachments/${file.id}`, who.session), { id: String(file.id) });
    assert.equal((await download(P.req)).status, 404, "the requester");
    assert.equal((await download(P.mgr)).status, 404, "the approver");
    assert.equal((await download(P.agent)).status, 200, "an agent of the team");
    assert.equal((await download(P.newbie)).status, 200, "the uploader");
    await pool().query("UPDATE hd_messages SET review_state = 'returned' WHERE ticket_id = $1 AND review_state = 'pending'", [t.id]);
    assert.equal((await download(P.req)).status, 404, "returned: still not the requester's");

    const a = await approvalOf(t.id);
    const card = await call(approvalRoute.GET as AnyHandler, req(`/approvals/${a.id}`, P.mgr.session), { id: String(a.id) });
    assert.equal(card.status, 200);
    assert.equal((card.body.approval ?? card.body).body, "");
  });
});
