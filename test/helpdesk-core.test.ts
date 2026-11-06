// Helpdesk 1.19.0 (core): tickets, messages, access, views, numbering, the
// licence gate, suggestions and attachments, through the routes the desk and
// Get help call (route handlers called directly, as in
// test/handbook-confirm.test.ts: next/headers resolves to a stub serving the
// request under test, lib/ee to a stub that grants "helpdesk").
//
// Parallel-safe: every row this file reads is its own (its teams, its
// people, its spaces, its request type; queues are asked for in its teams'
// scope). Nobody here is a workspace admin: agents and the helpdesk admin
// hold their keys through roles assigned to plain viewers. Global state
// touched: the starter SLA rows are inserted if missing (insert-only, never
// changed or removed), nothing else.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-core.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { pool, getSetting, createSession, setSpaceGroups } from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-core.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-core.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
/** lib/ee as a licensed enterprise build sees it; the licence test empties `features`. */
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
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) return EE_STUB;
    if (request === "../ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "..", "ee") === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

type AnyHandler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any; res: Response }> {
  currentRequest = req;
  try {
    const res = await (handler as AnyHandler)(req, { params: Promise.resolve(params) });
    let body: any = null;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      try {
        body = await res.clone().json();
      } catch {
        /* none */
      }
    }
    return { status: res.status, body, res };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.77" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function uploadReq(session: string, name: string, bytes: Buffer, type = "application/octet-stream"): Request {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type }), name);
  return new Request("http://localhost/api/helpdesk/attachments", {
    method: "POST",
    headers: { cookie: `compass_session=${session}` },
    body: form,
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdcore-${Date.now()}-${randomBytes(3).toString("hex")}`;
/** A word no other document has, for the suggestion tests (letters only: the tsvector keeps it whole). */
const WORD = "qz" + [...randomBytes(6)].map((b) => "abcdefghijklmnopqrstuvwxyz"[b % 26]).join("");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

const P: Record<string, { id: number; session: string }> = {};
const PEOPLE = ["requester", "agentA", "agentB", "agentAll", "hdAdmin", "approver", "stranger"] as const;
let teamA = 0;
let teamB = 0;
let requestTypeA = 0;
let roleAll = 0;
let roleAdmin = 0;
let groupId = 0;
let openSpace = 0;
let closedSpace = 0;
let handbookId = 0;
const docIds: number[] = [];
let uploadDirectory = "";

const id = (k: (typeof PEOPLE)[number]) => P[k].id;
const s = (k: (typeof PEOPLE)[number]) => P[k].session;
const user = (k: (typeof PEOPLE)[number]) => ({ id: id(k), role: "viewer" as const });

async function roleId(key: string): Promise<number> {
  return (await pool().query("SELECT id FROM roles WHERE key = $1", [key])).rows[0].id;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "compass-hdcore-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDirectory;
  const creds = hashPassword("Helpdesk!Core123");
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const k of PEOPLE) {
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status, password_hash, password_salt)
       VALUES ($1, $2, $3, 'viewer', 'active', $4, $5) RETURNING id`,
      [`${STAMP}-${k}`, `Hd ${k}`, `${STAMP}-${k}@example.test`, creds.hash, creds.salt]
    );
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    P[k] = { id: r.rows[0].id, session };
  }
  // Keys through roles, never the admin ladder.
  const agentRole = await roleId("helpdesk-agent");
  const all = await fixtureQuery("INSERT INTO roles (key, name, description) VALUES ($1, $2, '') RETURNING id", [`${STAMP}-all`, `${STAMP} all teams`]);
  roleAll = all.rows[0].id;
  await pool().query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.agent'), ($1, 'helpdesk.agent_all')", [roleAll]);
  const adm = await fixtureQuery("INSERT INTO roles (key, name, description) VALUES ($1, $2, '') RETURNING id", [`${STAMP}-admin`, `${STAMP} configure`]);
  roleAdmin = adm.rows[0].id;
  await pool().query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.admin')", [roleAdmin]);
  for (const [k, r] of [["agentA", agentRole], ["agentB", agentRole], ["agentAll", roleAll], ["hdAdmin", roleAdmin]] as const) {
    await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [r, id(k)]);
  }
  const ta = await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} Team A`]);
  teamA = ta.rows[0].id;
  const tb = await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} Team B`]);
  teamB = tb.rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'lead'), ($3, $4, 'agent')", [teamA, id("agentA"), teamB, id("agentB")]);
  const rt = await fixtureQuery(
    `INSERT INTO hd_request_types (slug, title, team_id, form) VALUES ($1, 'Core test request', $2, $3::jsonb) RETURNING id`,
    [STAMP, teamA, JSON.stringify([{ key: "where", label: "Where?", type: "text", required: true }])]
  );
  requestTypeA = rt.rows[0].id;

  // The knowledge base: a private space the requester's group reads, one nobody here reads.
  const g = await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} staff`]);
  groupId = g.rows[0].id;
  await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, id("requester")]);
  const sp = await fixtureQuery(
    "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id",
    [`HD Core ${STAMP}`, `${STAMP}-kb`]
  );
  openSpace = sp.rows[0].id;
  await setSpaceGroups(openSpace, [groupId]);
  const cl = await fixtureQuery(
    "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '🔒', '', 'private') RETURNING id",
    [`HD Core Closed ${STAMP}`, `${STAMP}-closed`]
  );
  closedSpace = cl.rows[0].id;
  const doc = async (space: number, title: string, findMode = "space") => {
    const r = await fixtureQuery(
      `INSERT INTO documents (space_id, title, slug, type, status, content, find_mode, author)
       VALUES ($1, $2, $3, 'knowledge', 'published', $4, $5, 'test') RETURNING id`,
      [space, `${title} ${WORD}`, `${STAMP}-${docIds.length}`, `How to fix the ${WORD} problem. `.repeat(50), findMode]
    );
    docIds.push(r.rows[0].id);
    return r.rows[0].id as number;
  };
  await doc(openSpace, "Readable guide");
  await doc(closedSpace, "Closed guide");
  const hbDoc = await doc(openSpace, "Handbook-only policy", "handbook_only");
  const hb = await fixtureQuery(
    `INSERT INTO handbooks (title, status, audience, created_by_name, published_at) VALUES ($1, 'published', 'groups', 'test', now()) RETURNING id`,
    [`${STAMP} handbook`]
  );
  handbookId = hb.rows[0].id;
  await pool().query("INSERT INTO handbook_audience (handbook_id, group_id) VALUES ($1, $2)", [handbookId, groupId]);
  const sec = await pool().query("INSERT INTO handbook_sections (handbook_id, title) VALUES ($1, 'All') RETURNING id", [handbookId]);
  await pool().query("INSERT INTO handbook_items (handbook_id, section_id, document_id) VALUES ($1, $2, $3)", [handbookId, sec.rows[0].id, hbDoc]);

  const { ensureStarterPolicies } = await import("../src/lib/helpdesk/db-sla");
  await ensureStarterPolicies();
});

after(async () => {
  const userIds = PEOPLE.map((k) => P[k]?.id).filter(Boolean);
  const files = await pool().query(
    `SELECT a.id FROM hd_attachments a LEFT JOIN hd_tickets t ON t.id = a.ticket_id
      WHERE a.uploaded_by = ANY($1) OR t.team_id = ANY($2) OR t.requester_id = ANY($1)`,
    [userIds, [teamA, teamB]]
  );
  await pool().query("DELETE FROM hd_attachments WHERE id = ANY($1)", [files.rows.map((r) => r.id)]);
  await pool().query("DELETE FROM hd_tickets WHERE requester_id = ANY($1) OR team_id = ANY($2) OR assignee_id = ANY($1)", [userIds, [teamA, teamB]]);
  await pool().query("DELETE FROM hd_request_types WHERE id = $1", [requestTypeA]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[teamA, teamB]]);
  await pool().query("DELETE FROM hd_agent_prefs WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM handbooks WHERE id = $1", [handbookId]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [[roleAll, roleAdmin]]);
  await pool().query("DELETE FROM group_members WHERE group_id = $1", [groupId]);
  await pool().query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [[openSpace, closedSpace]]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  if (uploadDirectory) await rm(uploadDirectory, { recursive: true, force: true });
});

const routes = {
  requests: () => import("../src/app/api/helpdesk/requests/route"),
  request: () => import("../src/app/api/helpdesk/requests/[number]/route"),
  requestMessages: () => import("../src/app/api/helpdesk/requests/[number]/messages/route"),
  tickets: () => import("../src/app/api/helpdesk/tickets/route"),
  ticket: () => import("../src/app/api/helpdesk/tickets/[number]/route"),
  ticketMessages: () => import("../src/app/api/helpdesk/tickets/[number]/messages/route"),
  counts: () => import("../src/app/api/helpdesk/counts/route"),
  suggest: () => import("../src/app/api/helpdesk/suggest/route"),
  upload: () => import("../src/app/api/helpdesk/attachments/route"),
  download: () => import("../src/app/api/helpdesk/attachments/[id]/route"),
  settings: () => import("../src/app/api/helpdesk/admin/settings/route"),
  teams: () => import("../src/app/api/helpdesk/admin/teams/route"),
};

/** A request from the requester through Get help's route, in team A (via the request type). */
async function postRequest(subject: string, extra: Record<string, unknown> = {}) {
  const { POST } = await routes.requests();
  const r = await call(POST, req("/api/helpdesk/requests", s("requester"), { request_type_id: requestTypeA, subject, body: `${subject}: details`, answers: { where: "Desk 4" }, ...extra }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.ticket.number as number;
}

/**
 * The same request through lib/helpdesk/tickets createTicket (what the route
 * calls), for the tests that need many: the route's per-person rate limit
 * (10 a minute) would refuse the rest.
 */
async function newRequest(subject: string) {
  const { createTicket } = await import("../src/lib/helpdesk/tickets");
  const t = await createTicket(
    {
      subject,
      body: `${subject}: details`,
      requester: { id: id("requester"), name: "Hd requester", email: `${STAMP}-requester@example.test` },
      request_type_id: requestTypeA,
      answers: { where: "Desk 4" },
    },
    { silent: true }
  );
  return t.number;
}

async function ticketRow(number: number) {
  return (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [number])).rows[0];
}

// --- The tests ----------------------------------------------------------------------

describe("tickets and numbering", () => {
  test("a request gets the next number from 1001, its type's team, a reply token, SLA dues and its opening message", async () => {
    const a = await postRequest("Printer jammed");
    const b = await postRequest("Monitor flickers");
    assert.ok(a >= 1001 && b > a, `numbers ${a}, ${b}`);
    const row = await ticketRow(a);
    assert.equal(row.team_id, teamA);
    assert.equal(row.status, "new");
    assert.equal(row.source, "portal");
    assert.deepEqual(row.form_answers, { where: "Desk 4" });
    assert.match(row.reply_token, /^[a-z0-9]{16}$/);
    assert.notEqual(row.reply_token, (await ticketRow(b)).reply_token);
    assert.ok(row.first_reply_due && row.resolve_due, "dues from the starter policy");
    const msgs = await pool().query("SELECT kind, body, author_id FROM hd_messages WHERE ticket_id = $1", [row.id]);
    assert.deepEqual(msgs.rows, [{ kind: "public", body: "Printer jammed: details", author_id: id("requester") }]);
  });

  test("validation: a missing required answer, an unknown source, an overlong subject", async () => {
    const { POST } = await routes.requests();
    const bad = async (b: unknown) => (await call(POST, req("/api/helpdesk/requests", s("requester"), b))).status;
    assert.equal(await bad({ request_type_id: requestTypeA, subject: "x", body: "y", answers: {} }), 400);
    assert.equal(await bad({ subject: "x", body: "y", source: "workflow" }), 400);
    assert.equal(await bad({ subject: "x".repeat(201), body: "y" }), 400);
    assert.equal(await bad({ subject: "x", body: "y", source_ref: { evil: 1 } }), 400);
  });
});

describe("access", () => {
  test("the matrix: requester, agent of the team, agent of another team, assignee, agent_all, admin, approver, stranger", async () => {
    const { canSeeTicket, canWorkTicket } = await import("../src/lib/helpdesk/access");
    const n = await newRequest("Badge does not open the door");
    const t = await ticketRow(n);
    const n2 = await newRequest("Second desk lamp");
    const t2 = await ticketRow(n2);
    await pool().query("UPDATE hd_tickets SET assignee_id = $2 WHERE id = $1", [t2.id, id("agentB")]);
    const t2a = await ticketRow(n2);
    // An approver named on a (hand-made) approval of t.
    const run = await pool().query("INSERT INTO hd_workflow_runs (ticket_id, state) VALUES ($1, 'running') RETURNING id", [t.id]);
    const step = await pool().query("INSERT INTO hd_workflow_steps (run_id, step_key, kind, state) VALUES ($1, 'a', 'approval', 'active') RETURNING id", [run.rows[0].id]);
    await pool().query(
      "INSERT INTO hd_approvals (run_id, step_id, ticket_id, approver_kind, approver_user_id) VALUES ($1, $2, $3, 'user', $4)",
      [run.rows[0].id, step.rows[0].id, t.id, id("approver")]
    );
    const expect: [string, boolean, boolean, boolean, boolean][] = [
      // who, sees t, works t, sees t2 (assigned to agentB), works t2
      ["requester", true, false, true, false],
      ["agentA", true, true, true, true],
      ["agentB", false, false, true, true],
      ["agentAll", true, true, true, true],
      // helpdesk.admin is the desk Admin role (lib/helpdesk/roles): it works every queue.
      ["hdAdmin", true, true, true, true],
      ["approver", true, false, false, false],
      ["stranger", false, false, false, false],
    ];
    for (const [who, seeT, workT, seeT2, workT2] of expect) {
      const u = user(who as (typeof PEOPLE)[number]);
      assert.equal(await canSeeTicket(u, t), seeT, `${who} sees t`);
      assert.equal(await canWorkTicket(u, t), workT, `${who} works t`);
      assert.equal(await canSeeTicket(u, t2a), seeT2, `${who} sees t2`);
      assert.equal(await canWorkTicket(u, t2a), workT2, `${who} works t2`);
    }
    // Through the routes: the desk read is for agents who work it; the request read for anyone who sees it.
    const { GET: deskGet } = await routes.ticket();
    const { GET: reqGet } = await routes.request();
    const desk = async (who: (typeof PEOPLE)[number]) => (await call(deskGet, req(`/api/helpdesk/tickets/${n}`, s(who)), { number: String(n) })).status;
    const help = async (who: (typeof PEOPLE)[number]) => (await call(reqGet, req(`/api/helpdesk/requests/${n}`, s(who)), { number: String(n) })).status;
    assert.equal(await desk("agentA"), 200);
    assert.equal(await desk("agentAll"), 200);
    assert.equal(await desk("agentB"), 404);
    assert.equal(await desk("requester"), 403);
    assert.equal(await desk("approver"), 403);
    assert.equal(await help("requester"), 200);
    assert.equal(await help("approver"), 200);
    assert.equal(await help("stranger"), 404);
    // The admin key reaches the configuration; an agent's does not.
    const { GET: settingsGet } = await routes.settings();
    assert.equal((await call(settingsGet, req("/api/helpdesk/admin/settings", s("hdAdmin")))).status, 200);
    assert.equal((await call(settingsGet, req("/api/helpdesk/admin/settings", s("agentA")))).status, 403);
    assert.equal(await desk("hdAdmin"), 200);
  });

  test("the licence gate answers 402 everywhere and writes nothing", async () => {
    edition.features = [];
    try {
      const { POST } = await routes.requests();
      const before = (await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE requester_id = $1", [id("requester")])).rows[0].n;
      const r = await call(POST, req("/api/helpdesk/requests", s("requester"), { subject: "Unlicensed", body: "x" }));
      assert.equal(r.status, 402);
      const { GET } = await routes.tickets();
      assert.equal((await call(GET, req("/api/helpdesk/tickets", s("agentA")))).status, 402);
      const { GET: counts } = await routes.counts();
      assert.equal((await call(counts, req("/api/helpdesk/counts", s("agentA")))).status, 402);
      const after = (await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE requester_id = $1", [id("requester")])).rows[0].n;
      assert.equal(after, before);
    } finally {
      edition.features = ["helpdesk"];
    }
  });
});

describe("messages and privacy", () => {
  test("an agent's reply and internal note; the requester never reads the note, the timeline's internal lines or internal fields", async () => {
    const n = await newRequest("Cannot print in colour");
    const { POST: deskPost } = await routes.ticketMessages();
    const { PATCH } = await routes.ticket();
    const note = await call(deskPost, req(`/api/helpdesk/tickets/${n}/messages`, s("agentA"), { kind: "internal", body: "Toner is low on floor 3" }), { number: String(n) });
    assert.equal(note.status, 201);
    const patched = await call(PATCH, req(`/api/helpdesk/tickets/${n}`, s("agentA"), { assignee_id: id("agentA"), tags: ["printer"], priority: "high" }, "PATCH"), { number: String(n) });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual(patched.body.changed.sort(), ["assignee_id", "priority", "tags"]);
    const reply = await call(deskPost, req(`/api/helpdesk/tickets/${n}/messages`, s("agentA"), { kind: "public", body: "Swapping the toner now" }), { number: String(n) });
    assert.equal(reply.status, 201);
    const row = await ticketRow(n);
    assert.ok(row.first_replied_at, "the first public reply stamps first_replied_at");
    assert.equal(row.status, "open", "an agent's reply opens a new ticket");

    const { GET } = await routes.request();
    const view = await call(GET, req(`/api/helpdesk/requests/${n}`, s("requester")), { number: String(n) });
    assert.equal(view.status, 200);
    const text = JSON.stringify(view.body);
    assert.ok(!text.includes("Toner is low"), "no internal note");
    assert.ok(!text.includes("assigned the ticket"), "no internal timeline line");
    for (const k of ["tags", "assignee_id", "reply_token", "first_reply_due", "sla_policy_id"]) {
      assert.ok(!(k in view.body.request), `no ${k}`);
    }
    assert.ok(view.body.request.messages.every((m: { kind: string }) => m.kind !== "internal"));
    assert.ok(view.body.request.messages.some((m: { body: string }) => m.body === "Swapping the toner now"));
    // The agent's view has everything.
    const { GET: deskGet } = await routes.ticket();
    const detail = await call(deskGet, req(`/api/helpdesk/tickets/${n}`, s("agentA")), { number: String(n) });
    assert.ok(detail.body.messages.some((m: { body: string; kind: string }) => m.kind === "internal" && m.body === "Toner is low on floor 3"));
    assert.equal(detail.body.ticket.priority, "high");
    assert.equal(detail.body.requester.name, "Hd requester");
    assert.equal(detail.body.can_work, true);
  });

  test("a requester can only post public replies on their own request; their reply reopens a request waiting on them", async () => {
    const n = await newRequest("Keyboard missing keys");
    const { PATCH } = await routes.ticket();
    await call(PATCH, req(`/api/helpdesk/tickets/${n}`, s("agentA"), { status: "pending" }, "PATCH"), { number: String(n) });
    assert.ok((await ticketRow(n)).sla_paused_at, "pending pauses the clock");
    const { POST } = await routes.requestMessages();
    const other = await call(POST, req(`/api/helpdesk/requests/${n}/messages`, s("stranger"), { body: "hi" }), { number: String(n) });
    assert.equal(other.status, 404);
    const approverPost = await call(POST, req(`/api/helpdesk/requests/${n}/messages`, s("agentA"), { body: "as requester?" }), { number: String(n) });
    assert.equal(approverPost.status, 404, "an agent cannot post as the requester");
    const mine = await call(POST, req(`/api/helpdesk/requests/${n}/messages`, s("requester"), { body: "Here is the photo" }), { number: String(n) });
    assert.equal(mine.status, 201);
    assert.equal(mine.body.status, "open");
    const row = await ticketRow(n);
    assert.equal(row.status, "open");
    assert.equal(row.sla_paused_at, null, "the clock runs again");
  });

  test("pause and resume keep the business time that was left", async () => {
    const { getBusinessHours } = await import("../src/lib/helpdesk/settings");
    const { resumedDues } = await import("../src/lib/helpdesk/sla");
    const n = await newRequest("Phone handset crackles");
    const t = await ticketRow(n);
    const { PATCH } = await routes.ticket();
    await call(PATCH, req(`/api/helpdesk/tickets/${n}`, s("agentA"), { status: "on_hold" }, "PATCH"), { number: String(n) });
    // Pretend it went on hold three hours ago.
    const pausedAt = new Date(Date.now() - 3 * 3_600_000);
    await pool().query("UPDATE hd_tickets SET sla_paused_at = $2 WHERE id = $1", [t.id, pausedAt]);
    const paused = await ticketRow(n);
    await call(PATCH, req(`/api/helpdesk/tickets/${n}`, s("agentA"), { status: "open" }, "PATCH"), { number: String(n) });
    const resumed = await ticketRow(n);
    assert.equal(resumed.sla_paused_at, null);
    assert.ok(Number(resumed.sla_paused_ms) >= 3 * 3_600_000 - 1000, "the pause is counted");
    const policy = (await pool().query("SELECT * FROM hd_sla_policies WHERE id = $1", [t.sla_policy_id])).rows[0];
    const want = resumedDues(
      { first_reply_due: new Date(paused.first_reply_due).toISOString(), resolve_due: new Date(paused.resolve_due).toISOString(), first_replied_at: null },
      pausedAt.getTime(),
      Date.now(),
      policy,
      await getBusinessHours()
    );
    const got = new Date(resumed.first_reply_due).getTime();
    assert.ok(Math.abs(got - want.first_reply_due!.getTime()) < 120_000, "first reply due moved by the paused business time");
    assert.ok(got >= new Date(paused.first_reply_due).getTime());
  });

  test("solving: Send and mark solved stamps solved_at, the requester's reply reopens it, a bad assignee is refused", async () => {
    const n = await newRequest("Chair wheel broke");
    const { POST } = await routes.ticketMessages();
    const r = await call(POST, req(`/api/helpdesk/tickets/${n}/messages`, s("agentA"), { kind: "public", body: "New chair ordered", then_status: "solved" }), { number: String(n) });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "solved");
    assert.ok((await ticketRow(n)).solved_at);
    const { POST: reply } = await routes.requestMessages();
    await call(reply, req(`/api/helpdesk/requests/${n}/messages`, s("requester"), { body: "Still broken" }), { number: String(n) });
    const row = await ticketRow(n);
    assert.equal(row.status, "open");
    assert.equal(row.solved_at, null);
    const { PATCH } = await routes.ticket();
    // Assigning outside the team needs tickets.assign_any (not an Agent's); an Admin may, but only to an agent.
    const outside = await call(PATCH, req(`/api/helpdesk/tickets/${n}`, s("agentA"), { assignee_id: id("stranger") }, "PATCH"), { number: String(n) });
    assert.equal(outside.status, 403);
    const bad = await call(PATCH, req(`/api/helpdesk/tickets/${n}`, s("hdAdmin"), { assignee_id: id("stranger") }, "PATCH"), { number: String(n) });
    assert.equal(bad.status, 400);
    assert.equal((await ticketRow(n)).assignee_id, null);
    const timeline = await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 AND via = 'system' ORDER BY id", [row.id]);
    assert.ok(timeline.rows.some((m) => m.kind === "system" && /to Solved/.test(m.body)));
  });
});

describe("queues and counts", () => {
  test("views and counts in the caller's scope", async () => {
    const { listTickets, countViews } = await import("../src/lib/helpdesk/tickets");
    const mine = await newRequest("Mine: projector cable");
    const free = await newRequest("Unassigned: whiteboard pens");
    const { PATCH } = await routes.ticket();
    await call(PATCH, req(`/api/helpdesk/tickets/${mine}`, s("agentA"), { assignee_id: id("agentA") }, "PATCH"), { number: String(mine) });
    const view = async (v: "mine" | "unassigned" | "open") => (await listTickets(user("agentA"), { view: v, limit: 100 })).rows.map((r) => r.number);
    assert.ok((await view("mine")).includes(mine));
    assert.ok(!(await view("mine")).includes(free));
    assert.ok((await view("unassigned")).includes(free));
    // agentB's scope is team B plus what is assigned to them: none of team A's unassigned tickets.
    const bOpen = (await listTickets(user("agentB"), { view: "open", limit: 100 })).rows.map((r) => r.number);
    assert.ok(!bOpen.includes(free) && !bOpen.includes(mine));
    // Counts agree with the lists for agentA (team A is this file's own).
    const counts = await countViews(user("agentA"));
    assert.equal(counts.views.mine, (await listTickets(user("agentA"), { view: "mine", limit: 100 })).total);
    assert.equal(counts.views.unassigned, (await listTickets(user("agentA"), { view: "unassigned", limit: 100 })).total);
    assert.equal(counts.headline.open, counts.views.open);
    assert.ok(counts.teams.some((t) => t.team_id === teamA));
    assert.ok(!counts.teams.some((t) => t.team_id === teamB));
    // Search by number and by subject; overdue appears once its due has passed.
    const { GET } = await routes.tickets();
    const byNum = await call(GET, req(`/api/helpdesk/tickets?view=open&q=%23${free}`, s("agentA")));
    assert.deepEqual(byNum.body.tickets.map((t: { number: number }) => t.number), [free]);
    await pool().query("UPDATE hd_tickets SET first_reply_due = now() - interval '5 minutes' WHERE number = $1", [free]);
    const overdue = await call(GET, req("/api/helpdesk/tickets?view=overdue", s("agentA")));
    const hit = overdue.body.tickets.find((t: { number: number }) => t.number === free);
    assert.ok(hit, "overdue view");
    assert.equal(hit.sla_state, "breached");
    assert.match(hit.due_label, /^Reply overdue/);
    assert.equal((await call(GET, req("/api/helpdesk/tickets?view=nonsense", s("agentA")))).status, 400);
  });

  test("report drill-downs and search: every status, the filters, inside the caller's scope", async () => {
    const { GET } = await routes.tickets();
    const word = `drill${STAMP.replace(/[^a-z0-9]/gi, "").slice(-8)}`;
    const solved = await newRequest(`${word} solved one`);
    const open = await newRequest(`${word} open one`);
    await pool().query(
      "UPDATE hd_tickets SET status = 'solved', solved_at = '2026-03-04T12:00:00Z', tags = '{printer}', category = 'Hardware', first_reply_breached_at = now() WHERE number = $1",
      [solved]
    );
    await pool().query("UPDATE hd_tickets SET source = 'email', created_at = '2026-03-02T09:00:00Z' WHERE number = $1", [open]);
    const nums = async (qs: string, who: Parameters<typeof s>[0] = "agentA") => {
      const r = await call(GET, req(`/api/helpdesk/tickets?${qs}`, s(who)));
      assert.equal(r.status, 200, `${qs}: ${JSON.stringify(r.body)}`);
      return (r.body.tickets as { number: number }[]).map((t) => t.number).filter((n) => n === solved || n === open).sort();
    };
    const both = [solved, open].sort();
    // A search without a view looks through solved tickets too; the default list does not.
    assert.deepEqual(await nums(`q=${word}`), both);
    assert.deepEqual(await nums(`view=open&q=${word}`), [open]);
    assert.deepEqual(await nums(`view=all&team=${teamA}`), both);
    assert.deepEqual(await nums(`view=all&request_type=${requestTypeA}&q=${word}`), both);
    assert.deepEqual(await nums("view=all&channel=email&q=" + word), [open]);
    assert.deepEqual(await nums("view=all&tag=printer&q=" + word), [solved]);
    assert.deepEqual(await nums("view=all&category=Hardware&q=" + word), [solved]);
    assert.deepEqual(await nums("view=all&breached=1&q=" + word), [solved]);
    assert.deepEqual(await nums("view=all&status_group=open&q=" + word), [open]);
    assert.deepEqual(await nums("view=all&origin=people&q=" + word), both);
    assert.deepEqual(await nums("view=all&origin=automated&q=" + word), []);
    assert.deepEqual(await nums("view=all&vip=no&q=" + word), both);
    assert.deepEqual(await nums("view=all&vip=yes&q=" + word), []);
    assert.deepEqual(await nums("view=all&integration=none&q=" + word), both);
    assert.deepEqual(await nums("view=all&assignee=none&channel=trigger&q=" + word), []);
    assert.deepEqual(await nums("view=all&created_from=2026-03-02&created_to=2026-03-02&q=" + word), [open]);
    assert.deepEqual(await nums("view=all&solved_from=2026-03-04&solved_to=2026-03-04"), [solved]);
    assert.deepEqual(await nums("view=all&solved_from=2026-03-05&q=" + word), []);
    assert.deepEqual(await nums(`view=all&requester=${id("requester")}&q=${word}`), both);
    assert.deepEqual(await nums(`view=all&requester_email=${encodeURIComponent(`${STAMP}-requester@example.test`)}&q=${word}`), both);
    // Another team's agent finds none of them, whatever the filters say.
    assert.deepEqual(await nums(`q=${word}`, "agentB"), []);
    assert.deepEqual(await nums(`view=all&team=${teamA}`, "agentB"), []);
    // Bad values are refused, never sent to the database.
    for (const qs of ["view=all&channel=pigeon", "view=all&created_from=2026-02-31", "view=all&breached=yes", "view=all&request_type=x", "view=all&origin=robots", "view=all&vip=maybe", "view=all&integration=x"]) {
      assert.equal((await call(GET, req(`/api/helpdesk/tickets?${qs}`, s("agentA")))).status, 400, qs);
    }
    // Queue rows carry the automated flag and the clock note.
    const r = await call(GET, req(`/api/helpdesk/tickets?view=all&q=${word}`, s("agentA")));
    for (const t of r.body.tickets) {
      assert.equal(t.automated, 0);
      assert.deepEqual(t.source_ref, {});
      assert.ok("clock_note" in t);
    }
  });

  test("the SLA sweep claims a breach once", async () => {
    const { claimSlaEvents } = await import("../src/lib/helpdesk/db-sla");
    const n = await newRequest("Sweep me");
    const t = await ticketRow(n);
    await pool().query("UPDATE hd_tickets SET first_reply_due = now() - interval '1 minute' WHERE id = $1", [t.id]);
    let first;
    for (let i = 0; i < 20; i++) {
      first = await claimSlaEvents(new Date(), [t.id]);
      if (first.ran) break;
      await new Promise((r) => setTimeout(r, 100)); // another process holds the sweep lock
    }
    assert.ok(first!.ran);
    assert.deepEqual(first!.events.filter((e) => e.kind === "breach"), [{ ticket_id: t.id, kind: "breach", target: "first_reply" }]);
    let again;
    for (let i = 0; i < 20; i++) {
      again = await claimSlaEvents(new Date(), [t.id]);
      if (again.ran) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(again!.events.filter((e) => e.kind === "breach"), []);
    assert.ok((await ticketRow(n)).first_reply_breached_at);
  });
});

describe("suggestions", () => {
  test("respect space scope and handbook-only find scope", async () => {
    const { GET } = await routes.suggest();
    const r = await call(GET, req(`/api/helpdesk/suggest?q=${WORD}`, s("requester")));
    assert.equal(r.status, 200);
    const titles = r.body.articles.map((a: { title: string }) => a.title);
    assert.deepEqual(titles, [`Readable guide ${WORD}`], JSON.stringify(titles));
    const a = r.body.articles[0];
    assert.equal(a.url, `/doc/${a.doc_id}`);
    assert.ok(a.read_minutes >= 1);
    assert.equal(a.space_name, `HD Core ${STAMP}`);
    // A stranger reads neither private space.
    const none = await call(GET, req(`/api/helpdesk/suggest?q=${WORD}`, s("stranger")));
    assert.deepEqual(none.body.articles, []);
  });
});

describe("attachments", () => {
  test("upload, bind on reply, and who may download", async () => {
    const n = await newRequest("Screen shows lines");
    const { POST: upload } = await routes.upload();
    const up = await call(upload, uploadReq(s("requester"), "screen.png", PNG, "image/png"));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.attachment.type, "image/png");
    const attId = up.body.attachment.id as number;
    // A client-sent name and size are ignored: the stored row is what travels.
    const { POST: reply } = await routes.requestMessages();
    const sent = await call(reply, req(`/api/helpdesk/requests/${n}/messages`, s("requester"), { body: "Photo attached", attachments: [{ id: attId, name: "evil.exe", size: 1 }] }), { number: String(n) });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.message.attachments, [{ id: attId, name: "screen.png", size: PNG.length, type: "image/png" }]);
    // Someone else's upload id cannot be attached.
    const theirs = await call(upload, uploadReq(s("stranger"), "x.pdf", Buffer.from("%PDF-1.4 test")));
    const stolen = await call(reply, req(`/api/helpdesk/requests/${n}/messages`, s("requester"), { body: "x", attachments: [theirs.body.attachment.id] }), { number: String(n) });
    assert.equal(stolen.status, 400);

    const { GET } = await routes.download();
    const dl = async (who: (typeof PEOPLE)[number], aid: number) => {
      const r = await call(GET, req(`/api/helpdesk/attachments/${aid}`, s(who)), { id: String(aid) });
      return r;
    };
    const mineDl = await dl("requester", attId);
    assert.equal(mineDl.status, 200);
    assert.equal(mineDl.res.headers.get("x-content-type-options"), "nosniff");
    assert.match(mineDl.res.headers.get("content-disposition") ?? "", /^inline/);
    assert.equal((await dl("agentA", attId)).status, 200);
    assert.equal((await dl("stranger", attId)).status, 404);
    assert.equal((await dl("agentB", attId)).status, 404);

    // An internal note's file: agents only.
    const note = await call(upload, uploadReq(s("agentA"), "notes.txt", Buffer.from("internal details")));
    const { POST: deskPost } = await routes.ticketMessages();
    const posted = await call(deskPost, req(`/api/helpdesk/tickets/${n}/messages`, s("agentA"), { kind: "internal", body: "see file", attachments: [note.body.attachment.id] }), { number: String(n) });
    assert.equal(posted.status, 201);
    assert.equal((await dl("agentA", note.body.attachment.id)).status, 200);
    const asRequester = await dl("requester", note.body.attachment.id);
    assert.equal(asRequester.status, 404);
    const txt = await dl("agentA", note.body.attachment.id);
    assert.match(txt.res.headers.get("content-disposition") ?? "", /^attachment/);
    assert.equal(txt.res.headers.get("content-type"), "application/octet-stream");
  });

  test("size and type limits; unbound uploads are swept", async () => {
    const { classifyUpload, ATTACHMENT_LIMITS, AttachmentRejectedError, sweepUnboundAttachments } = await import("../src/lib/helpdesk/attachments");
    assert.throws(() => classifyUpload(Buffer.alloc(ATTACHMENT_LIMITS.maxBytes + 1, 1), "big.pdf"), AttachmentRejectedError);
    assert.throws(() => classifyUpload(Buffer.from("MZ..."), "setup.exe"), AttachmentRejectedError);
    assert.throws(() => classifyUpload(Buffer.from("<html><script>1</script>"), "page.html"), AttachmentRejectedError);
    assert.throws(() => classifyUpload(Buffer.from("<svg onload=alert(1)>"), "pic.svg"), AttachmentRejectedError);
    assert.throws(() => classifyUpload(Buffer.from("<!doctype html><p>"), "report.pdf"), AttachmentRejectedError);
    assert.throws(() => classifyUpload(Buffer.alloc(0), "empty.pdf"), AttachmentRejectedError);
    assert.deepEqual(classifyUpload(Buffer.from("not really"), "photo.png"), { mime: "application/octet-stream", ext: ".png" });
    assert.deepEqual(classifyUpload(PNG, "anything.bin"), { mime: "image/png", ext: ".png" });
    const { POST: upload } = await routes.upload();
    const r = await call(upload, uploadReq(s("requester"), "tool.exe", Buffer.from("MZ")));
    assert.equal(r.status, 415);
    const kept = await call(upload, uploadReq(s("requester"), "later.pdf", Buffer.from("%PDF-1.4 later")));
    const aid = kept.body.attachment.id as number;
    assert.equal(await sweepUnboundAttachments(3_600_000, [aid]), 0, "a fresh upload is kept");
    assert.equal(await sweepUnboundAttachments(0, [aid]), 1, "an old unbound upload goes");
    assert.equal((await pool().query("SELECT 1 FROM hd_attachments WHERE id = $1", [aid])).rowCount, 0);
  });
});
