// Helpdesk 1.20.6 custom fields (lib/helpdesk/custom-fields): the pure checks
// (which team a field applies to, keys, kinds), the settings routes (who may,
// validation, limits, reorder, archive, delete, audit), a ticket's values
// through the desk's PATCH (every kind, the refusals, the timeline, who may),
// moving team (values kept, shown again), the requester's side (a Public
// field is read; an agent-only value is reachable through no requester
// route, tool, export or email), the REST API, webhooks, the Claude
// connector, the "Before you solve" requirement, anonymising, the printed
// ticket, and the upgrade path (no fields: nothing is read beyond one cached
// lookup; a requirement set made before 1.20.6 reads as requiring none).
//
// Same harness as test/helpdesk-solve-requirements: next/headers and lib/ee
// stubbed, routes called with real sessions. Parallel-safe on a shared
// database: every field this file makes is assigned to this file's own teams
// (STAMP), never to "All teams", so no other run's tickets ever show one.
// Fields, sets, tickets, teams and people are removed at the end.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-custom-fields.test.ts

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-custom-fields.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-custom-fields.virtual.js");
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
const cf = require("../src/lib/helpdesk/custom-fields") as typeof import("../src/lib/helpdesk/custom-fields");
const shared = require("../src/lib/helpdesk/custom-fields-shared") as typeof import("../src/lib/helpdesk/custom-fields-shared");
const schema = require("../src/lib/helpdesk/custom-fields-schema") as typeof import("../src/lib/helpdesk/custom-fields-schema");
const sr = require("../src/lib/helpdesk/solve-requirements") as typeof import("../src/lib/helpdesk/solve-requirements");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const detail = require("../src/lib/helpdesk/detail") as typeof import("../src/lib/helpdesk/detail");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const portal = require("../src/lib/helpdesk/portal") as typeof import("../src/lib/helpdesk/portal");
const share = require("../src/lib/helpdesk/share") as typeof import("../src/lib/helpdesk/share");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const hooks = require("../src/lib/helpdesk/webhooks") as typeof import("../src/lib/helpdesk/webhooks");
const claude = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const db = require("../src/lib/db") as typeof import("../src/lib/db");
const withTx = (require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core")).withTx;
const adminRoute = require("../src/app/api/helpdesk/admin/custom-fields/route") as typeof import("../src/app/api/helpdesk/admin/custom-fields/route");
const adminOneRoute = require("../src/app/api/helpdesk/admin/custom-fields/[id]/route") as typeof import("../src/app/api/helpdesk/admin/custom-fields/[id]/route");
const orderRoute = require("../src/app/api/helpdesk/admin/custom-fields/order/route") as typeof import("../src/app/api/helpdesk/admin/custom-fields/order/route");
const solveAdminRoute = require("../src/app/api/helpdesk/admin/solve-requirements/route") as typeof import("../src/app/api/helpdesk/admin/solve-requirements/route");
const solveAdminOneRoute = require("../src/app/api/helpdesk/admin/solve-requirements/[id]/route") as typeof import("../src/app/api/helpdesk/admin/solve-requirements/[id]/route");
const checkRoute = require("../src/app/api/helpdesk/tickets/[number]/solve-requirements/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/solve-requirements/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const requestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
const requestsRoute = require("../src/app/api/helpdesk/requests/route") as typeof import("../src/app/api/helpdesk/requests/route");
const tokensRoute = require("../src/app/api/helpdesk/admin/api/tokens/route") as typeof import("../src/app/api/helpdesk/admin/api/tokens/route");
const v1TicketRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/route");
const v1FieldsRoute = require("../src/app/api/helpdesk/v1/custom-fields/route") as typeof import("../src/app/api/helpdesk/v1/custom-fields/route");
/* eslint-enable @typescript-eslint/no-require-imports */

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

const STAMP = `hdcf-${Date.now()}-${process.pid}`;
/** A key prefix of this run, so keys never meet another run's. */
const K = `t${Date.now().toString(36)}${process.pid.toString(36)}`;
const P: Record<string, { id: number; session: string; name: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const F: Record<string, number> = {};
const setIds: number[] = [];
const ticketIds: number[] = [];
const tokenIds: number[] = [];
const hookIds: number[] = [];
const contactIds: number[] = [];
const mail: { to: string; subject: string; text?: string; html?: string }[] = [];

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

async function ticket(subject: string, team: string | null = "A", status = "open"): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source) VALUES ($1, $2, 'Req', $3, $4, $5, 'portal') RETURNING id, number",
    [`${subject} ${STAMP}`, P.req.id, `${STAMP}-req@example.test`, team ? T[team] : null, status]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

/** A field of this run, by a short name: assigned to team A unless the input says otherwise. */
async function field(name: string, input: Record<string, unknown> = {}): Promise<number> {
  const f = await cf.createCustomField({ label: `${name} ${STAMP}`, key: `${K}_${name}`, team_ids: [T.A], ...input }, { id: P.dadmin.id });
  F[name] = f.id;
  return f.id;
}
const key = (name: string) => `${K}_${name}`;

const lines = async (ticketId: number) =>
  (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows as { kind: string; body: string }[];
const auditRows = async (action: string, actor: number) =>
  (await pool().query("SELECT details, target_label FROM audit_log WHERE action = $1 AND actor_id = $2 ORDER BY id", [action, actor])).rows as { details: any; target_label: string }[];
const stored = async (ticketId: number) =>
  Object.fromEntries(
    (
      await pool().query("SELECT f.key, v.value FROM hd_ticket_custom_values v JOIN hd_custom_fields f ON f.id = v.field_id WHERE v.ticket_id = $1", [ticketId])
    ).rows.map((r) => [r.key.replace(`${K}_`, ""), r.value])
  ) as Record<string, unknown>;
const statusOf = async (id: number) => (await pool().query("SELECT status FROM hd_tickets WHERE id = $1", [id])).rows[0].status as string;
const patch = (who: string, n: number, body: Record<string, unknown>) => call(ticketRoute.PATCH, req(`/tickets/${n}`, P[who].session, body, "PATCH"), { number: String(n) });
const read = (who: string, n: number) => call(ticketRoute.GET, req(`/tickets/${n}`, P[who].session), { number: String(n) });
const shown = async (who: string, n: number) => ((await read(who, n)).body.custom_fields ?? []).map((f: { key: string }) => f.key.replace(`${K}_`, "")) as string[];
const admin = {
  list: () => call(adminRoute.GET, req("/admin/custom-fields", P.dadmin.session)),
  post: (body: unknown, who = "dadmin") => call(adminRoute.POST, req("/admin/custom-fields", P[who].session, body)),
  put: (id: number, body: unknown, who = "dadmin") => call(adminOneRoute.PUT, req(`/admin/custom-fields/${id}`, P[who].session, body, "PUT"), { id: String(id) }),
  del: (id: number, who = "dadmin") => call(adminOneRoute.DELETE, req(`/admin/custom-fields/${id}`, P[who].session, undefined, "DELETE"), { id: String(id) }),
  order: (ids: unknown, who = "dadmin") => call(orderRoute.PUT, req("/admin/custom-fields/order", P[who].session, { ids }, "PUT")),
};

const DEVICE_OPTIONS = [
  { value: "laptop", label: "Laptop" },
  { value: "desktop", label: "Desktop" },
  { value: "phone", label: "Phone", hint: "Company phones only" },
];

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push(m as (typeof mail)[number]);
  });
  hooks.setWebhookAutoSendForTests(false);
  for (const k of ["A", "B", "C"]) {
    const r = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9420) RETURNING id", [`${STAMP} ${k}`]);
    T[k] = r.rows[0].id;
  }
  await person("agent", "agent");
  await person("agent2", "agent");
  await person("newbie", "newbie");
  await person("other", "agent");
  await person("manager", "manager");
  await person("dadmin", "admin");
  await person("req", null);
  await person("stranger", null);
  // agent: teams A and B; agent2 and newbie: A; other: C only.
  await pool().query(
    "INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($1, $4, 'agent'), ($5, $2, 'agent'), ($6, $7, 'agent')",
    [T.A, P.agent.id, P.agent2.id, P.newbie.id, T.B, T.C, P.other.id]
  );
  // The fields most tests share: all of team A.
  await field("device", { type: "select", options: DEVICE_OPTIONS, visibility: "public", help: "What the ticket is about." });
  await field("serial", { type: "text" });
  await field("notes", { type: "textarea" });
  await field("cost", { type: "number" });
  await field("due", { type: "date", visibility: "public" });
  await field("owner", { type: "user" });
  await field("billable", { type: "checkbox" });
  // Team B only, and one on both A and B.
  await field("room", { type: "text", team_ids: [T.B], visibility: "public" });
  await field("site", { type: "select", options: [{ label: "North" }, { label: "South" }], team_ids: [T.A, T.B] });
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  claude.setClaudeLevelForTests(null);
  email.setHelpdeskTransportForTests(null);
  hooks.setWebhookAutoSendForTests(true);
  await pool().query("DELETE FROM hd_solve_requirement_sets WHERE id = ANY($1) OR name LIKE $2", [setIds, `%${STAMP}%`]);
  sr.invalidateSolveSets();
  await pool().query("DELETE FROM hd_webhooks WHERE id = ANY($1) OR name LIKE $2", [hookIds, `${STAMP}%`]);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE id = ANY($1) OR team_id = ANY($2)", [ticketIds, Object.values(T)])).rows.map((r) => r.id as number);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_custom_fields WHERE label LIKE $1 OR key LIKE $2", [`%${STAMP}%`, `${K}%`]);
  cf.invalidateCustomFields();
  await pool().query("DELETE FROM hd_portal_contacts WHERE id = ANY($1)", [contactIds]);
  await pool().query("DELETE FROM hd_api_tokens WHERE id = ANY($1) OR name LIKE $2", [tokenIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1) OR name LIKE $2", [Object.values(T), `${STAMP}%`]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

describe("checks (pure)", () => {
  test("a field applies to its teams; All teams also covers a ticket with no team; an archived field never applies", () => {
    const a = shared.customFieldApplies;
    assert.equal(a({ all_teams: true, team_ids: [], archived: false }, null), true);
    assert.equal(a({ all_teams: true, team_ids: [], archived: false }, 7), true);
    assert.equal(a({ all_teams: false, team_ids: [7, 8], archived: false }, 8), true);
    assert.equal(a({ all_teams: false, team_ids: [7, 8], archived: false }, 9), false);
    assert.equal(a({ all_teams: false, team_ids: [7], archived: false }, null), false, "no team: the All teams fields only");
    assert.equal(a({ all_teams: true, team_ids: [], archived: true }, 7), false);
  });

  test("a key is made from the label: lower case, underscores, a letter first, unique", () => {
    const k = shared.customFieldKeyFrom;
    assert.equal(k("Device type", []), "device_type");
    assert.equal(k("  Order № / Ref ", []), "order_no_ref");
    assert.equal(k("Café étage", []), "cafe_etage");
    assert.equal(k("3rd party", []), "f_3rd_party");
    assert.equal(k("!!!", []), "field");
    assert.equal(k("Device type", ["device_type", "device_type_2"]), "device_type_3");
    assert.ok(k("x".repeat(200), []).length <= shared.CUSTOM_FIELD_LIMITS.key);
    assert.match(k("Ünïcode Straße", []), /^[a-z][a-z0-9_]*$/);
  });

  test("who sees it and its teams: agent by default; teams or All teams, never neither", () => {
    const c = shared.checkCustomFieldScope;
    assert.deepEqual(c({}), { ok: true, value: { visibility: "agent", all_teams: true, team_ids: [] } });
    assert.deepEqual(c({ visibility: "public", team_ids: [3, 3, 4] }), { ok: true, value: { visibility: "public", all_teams: false, team_ids: [3, 4] } });
    assert.deepEqual(c({ all_teams: true, team_ids: [3] }), { ok: true, value: { visibility: "agent", all_teams: true, team_ids: [] } }, "All teams drops the list");
    assert.equal(c({ all_teams: false }).ok, false);
    assert.equal(c({ all_teams: false, team_ids: [] }).ok, false);
    assert.equal(c({ visibility: "everyone" }).ok, false);
    assert.equal(c({ team_ids: ["1"] }).ok, false);
    assert.equal(c({ all_teams: "yes" }).ok, false);
    assert.equal(c(null).ok, false);
  });

  test("kinds are the request form's; text and long text, and the two choices, read the same", () => {
    assert.deepEqual([...shared.CUSTOM_FIELD_KINDS].sort(), ["checkbox", "date", "datetime", "number", "select", "text", "textarea", "user"]);
    assert.equal(shared.sameValueShape("text", "textarea"), true);
    assert.equal(shared.sameValueShape("choice", "select"), true);
    assert.equal(shared.sameValueShape("text", "number"), false);
    assert.equal(shared.sameValueShape("select", "text"), false);
    // The kind the event calendar added to the forms (1.20.6) is a custom field kind too.
    assert.equal(shared.CUSTOM_FIELD_KIND_LABEL.datetime, "Date and time");
    assert.equal(shared.sameValueShape("date", "datetime"), false);
    assert.equal(shared.customValueText({ type: "datetime", options: [] }, "2026-11-20T14:00"), "2026-11-20 14:00");
  });

  test("a value as a person reads it; a removed option keeps the words it was set with", () => {
    const f = { type: "select" as const, options: DEVICE_OPTIONS };
    assert.equal(shared.customValueText(f, "phone"), "Phone");
    assert.equal(shared.customValueText(f, "tablet", { kept: "Tablet" }), "Tablet");
    assert.equal(shared.customValueText(f, null), "");
    assert.equal(shared.customValueText({ type: "checkbox", options: [] }, false), "No");
    assert.equal(shared.customValueText({ type: "user", options: [] }, 7, { names: new Map([[7, "Ana"]]) }), "Ana");
  });
});

describe("upgrade", () => {
  test("the schema is additive and runs again without error", async () => {
    await pool().query(db.guardCreateIndexes(db.guardAddColumns(schema.HD_CUSTOM_FIELDS_SCHEMA)));
    await pool().query(db.guardCreateIndexes(db.guardAddColumns(schema.HD_CUSTOM_FIELDS_SCHEMA)));
    const cols = (await pool().query("SELECT column_name FROM information_schema.columns WHERE table_name = 'hd_solve_requirement_sets' AND column_name = 'custom_field_ids'")).rows;
    assert.equal(cols.length, 1);
  });

  test("a requirement set made before 1.20.6 requires no custom field and works as it did", async () => {
    const r = await pool().query("INSERT INTO hd_solve_requirement_sets (name, enabled, team_ids, ticket_fields) VALUES ($1, 1, $2, '{assignee}') RETURNING id", [`${STAMP} old set`, [T.C]]);
    setIds.push(r.rows[0].id);
    sr.invalidateSolveSets();
    const set = await sr.getSolveSet(r.rows[0].id);
    assert.deepEqual(set?.custom_field_ids, []);
    const t = await ticket("Old set", "C");
    assert.equal((await sr.solveRequirementRefusal(t.id))?.error, "Before you solve, this ticket needs: an owner.");
    await sr.deleteSolveSet(r.rows[0].id);
  });

  test("a ticket whose team has no field: no block, no value read; the definitions are one cached lookup", async () => {
    const t = await ticket("Plain", "C");
    cf.invalidateCustomFields();
    const real = pool().query.bind(pool());
    const seen: string[] = [];
    (pool() as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => {
      const sql = typeof a[0] === "string" ? a[0] : ((a[0] as { text?: string })?.text ?? "");
      if (/hd_custom_fields|hd_ticket_custom_values/.test(sql)) seen.push(sql);
      return (real as (...x: unknown[]) => unknown)(...a);
    };
    try {
      assert.deepEqual(await cf.ticketCustomFields({ id: t.id, team_id: T.C }), []);
      assert.deepEqual(await cf.publicCustomDetails({ id: t.id, team_id: T.C }), []);
      assert.deepEqual(await cf.customFieldsOut({ id: t.id, team_id: T.C }), {});
      assert.equal(seen.length, 1, "one read of the definitions, then the cached copy");
      assert.ok(!seen.some((s) => /hd_ticket_custom_values/.test(s)), "no value is read when no field applies");
    } finally {
      (pool() as unknown as { query: unknown }).query = real;
    }
    const d = await read("other", t.number);
    assert.equal(d.status, 200);
    assert.equal(d.body.custom_fields, undefined, "no block for the side panel");
    const r = await call(requestRoute.GET, req(`/requests/${t.number}`, P.req.session), { number: String(t.number) });
    assert.equal(r.body.request.details, undefined);
  });
});

describe("settings (Desk settings → Custom fields)", () => {
  test("a desk admin creates, edits, archives and deletes; an agent and a manager may not; validation; audited", async () => {
    for (const who of ["agent", "manager", "req"]) {
      assert.ok([401, 403].includes((await admin.post({ label: "Nope" }, who)).status), who);
      assert.ok([401, 403].includes((await call(adminRoute.GET, req("/admin/custom-fields", P[who].session))).status), who);
      assert.ok([401, 403].includes((await admin.put(F.device, { label: "Nope" }, who)).status), who);
      assert.ok([401, 403].includes((await admin.del(F.device, who)).status), who);
      assert.ok([401, 403].includes((await admin.order([F.device], who)).status), who);
    }

    // Validation: each refusal is a sentence.
    const bad = async (body: unknown) => {
      const r = await admin.post(body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      return r.body.error as string;
    };
    assert.equal(await bad({ label: "  ", team_ids: [T.A] }), "Give the field a label.");
    assert.equal(await bad({ label: "x".repeat(81), team_ids: [T.A] }), "Keep the label under 80 characters.");
    assert.match(await bad({ label: `${STAMP} v`, type: "colour", team_ids: [T.A] }), /^The kind is one of: /);
    assert.equal(await bad({ label: `${STAMP} v`, type: "select", team_ids: [T.A] }), "The field needs at least one option.");
    assert.equal(await bad({ label: `${STAMP} v`, type: "select", options: [{ label: "" }], team_ids: [T.A] }), "Every option needs a name.");
    assert.match(await bad({ label: `${STAMP} v`, type: "select", options: Array.from({ length: 51 }, (_, i) => ({ label: `O${i}` })), team_ids: [T.A] }), /more than 50 options/);
    assert.match(await bad({ label: `${STAMP} v`, type: "select", options: [{ value: "a", label: "A" }, { value: "a", label: "B" }], team_ids: [T.A] }), /two options with the value "a"/);
    assert.equal(await bad({ label: `${STAMP} v`, all_teams: false }), "Pick at least one team, or choose All teams.");
    assert.equal(await bad({ label: `${STAMP} v`, team_ids: [999_999_999] }), "One of the teams no longer exists. Pick again.");
    assert.match(await bad({ label: `${STAMP} v`, visibility: "everyone", team_ids: [T.A] }), /^Visibility is /);
    assert.match(await bad({ label: `${STAMP} v`, key: "Bad Key", team_ids: [T.A] }), /^A key is lower-case letters/);
    assert.match(await bad({ label: `${STAMP} v`, help: "h".repeat(501), team_ids: [T.A] }), /help text is longer than 500/i);
    const dup = await admin.post({ label: `${STAMP} v`, key: key("device"), team_ids: [T.A] });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, `Another field already uses the key "${key("device")}".`);

    // Create: the key is made from the label, unique, and options get their values.
    const made = await admin.post({ label: `Asset tag ${STAMP}`, type: "select", options: [{ label: "Green" }, { label: "Amber light" }], team_ids: [T.A, T.B], visibility: "public", help: " Colour of the tag " });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const f = made.body.field;
    assert.match(f.key, /^asset_tag_hdcf_/);
    assert.deepEqual(f.options, [{ value: "green", label: "Green" }, { value: "amber_light", label: "Amber light" }]);
    assert.deepEqual([f.type, f.visibility, f.all_teams, f.team_ids, f.help, f.archived], ["select", "public", false, [T.A, T.B], "Colour of the tag", false]);
    const twin = await admin.post({ label: `Asset tag ${STAMP}`, team_ids: [T.A] });
    assert.equal(twin.status, 201);
    assert.equal(twin.body.field.key, `${f.key}_2`, "the same label again takes the next free key");
    assert.equal(twin.body.field.visibility, "agent", "agent only unless said otherwise");
    assert.ok(twin.body.field.position > f.position, "a new field goes last");

    // The list: every field, with how many tickets hold a value.
    const list = await admin.list();
    assert.equal(list.status, 200);
    const row = list.body.fields.find((x: { id: number }) => x.id === f.id);
    assert.equal(row.tickets, 0);
    assert.ok(list.body.teams.some((t: { id: number }) => t.id === T.A));
    assert.equal(list.body.limit, 100);

    // Edit: what is left out keeps its value; the key never changes; an option keeps its value when renamed.
    const put = await admin.put(f.id, { label: `Asset colour ${STAMP}`, options: [{ value: "green", label: "Green tag" }, { value: "amber_light", label: "Amber" }, { label: "Red" }] });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.field.key, f.key);
    assert.deepEqual(put.body.field.options.map((o: { value: string }) => o.value), ["green", "amber_light", "red"]);
    assert.deepEqual([put.body.field.visibility, put.body.field.team_ids, put.body.field.help], ["public", [T.A, T.B], "Colour of the tag"]);
    const rekey = await admin.put(f.id, { key: "something_else" });
    assert.equal(rekey.status, 400);
    assert.match(rekey.body.error, /^A field's key can't be changed/);
    assert.equal((await admin.put(f.id, { all_teams: true })).body.field.all_teams, true);
    assert.deepEqual((await admin.put(f.id, { team_ids: [T.B] })).body.field.team_ids, [T.B]);
    assert.equal((await admin.put(f.id, { visibility: "agent" })).body.field.visibility, "agent");
    assert.equal((await admin.put(999_999_999, { label: "x" })).status, 404);

    // The kind: free while no ticket holds a value; then only to one that reads the same.
    assert.equal((await admin.put(twin.body.field.id, { type: "number" })).status, 200);
    const t = await ticket("Kind");
    assert.equal((await patch("agent", t.number, { custom_fields: { [twin.body.field.key]: 12 } })).status, 200);
    const locked = await admin.put(twin.body.field.id, { type: "text" });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error, "1 ticket holds a value for this field, so its kind can't change. Archive it and add a new field instead.");
    assert.equal((await admin.put(F.serial, { type: "textarea" })).status, 200, "short to long text reads the same");
    assert.equal((await admin.put(F.serial, { type: "text" })).status, 200);

    // Archive and restore: the value stays; the field is not shown while archived.
    assert.deepEqual(await shown("agent", t.number), ["device", "serial", "notes", "cost", "due", "owner", "billable", "site", twin.body.field.key]);
    const arch = await admin.put(twin.body.field.id, { archived: true });
    assert.equal(arch.body.field.archived, true);
    assert.ok(!(await shown("agent", t.number)).includes(twin.body.field.key));
    const refused = await patch("agent", t.number, { custom_fields: { [twin.body.field.key]: 13 } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, `"Asset tag ${STAMP}" is archived, so it can't be changed.`);
    assert.equal((await pool().query("SELECT value FROM hd_ticket_custom_values WHERE field_id = $1", [twin.body.field.id])).rows[0].value, 12, "archived: the value is kept");
    assert.equal((await admin.put(twin.body.field.id, { archived: false })).body.field.archived, false);
    const back = (await read("agent", t.number)).body.custom_fields.find((x: { key: string }) => x.key === twin.body.field.key);
    assert.equal(back.value, 12, "restored: shown again with its value");

    // Delete: says how many tickets held a value, and the values go.
    const gone = await admin.del(twin.body.field.id);
    assert.deepEqual(gone.body, { ok: true, tickets: 1 });
    assert.equal((await pool().query("SELECT 1 FROM hd_ticket_custom_values WHERE field_id = $1", [twin.body.field.id])).rowCount, 0);
    assert.equal((await admin.del(twin.body.field.id)).status, 404);
    assert.deepEqual((await admin.del(f.id)).body, { ok: true, tickets: 0 });

    // The audit log names each change.
    assert.equal((await auditRows("helpdesk.custom_field.created", P.dadmin.id)).length, 2);
    const updates = await auditRows("helpdesk.custom_field.updated", P.dadmin.id);
    assert.deepEqual(updates[0].details.changed, ["label", "options"]);
    assert.equal(updates[0].details.label_before, `Asset tag ${STAMP}`);
    assert.ok(updates.some((u) => u.details.changed.includes("visibility") && u.details.visibility_before === "public"));
    assert.equal((await auditRows("helpdesk.custom_field.archived", P.dadmin.id)).length, 1);
    assert.equal((await auditRows("helpdesk.custom_field.restored", P.dadmin.id)).length, 1);
    const deleted = await auditRows("helpdesk.custom_field.deleted", P.dadmin.id);
    assert.deepEqual(deleted.map((d) => d.details.tickets_with_a_value), [1, 0]);
  });

  test("a workspace holds up to 100 fields, archived ones included", async () => {
    // Filled up with archived fields of this run's own team (shown nowhere), then removed.
    const n = (await pool().query("SELECT count(*)::int AS n FROM hd_custom_fields")).rows[0].n as number;
    const room = shared.CUSTOM_FIELD_LIMITS.fields - n;
    assert.ok(room > 0, "the shared database is already at the limit");
    await pool().query(
      `INSERT INTO hd_custom_fields (key, label, all_teams, team_ids, position, archived_at)
       SELECT $1 || '_fill_' || g, 'Filler ' || g || ' ' || $2, 0, $3::int[], 9000 + g, now() FROM generate_series(1, $4::int) g`,
      [K, STAMP, [T.A], room]
    );
    try {
      const full = await admin.post({ label: `${STAMP} one too many`, team_ids: [T.A] });
      assert.equal(full.status, 409, JSON.stringify(full.body));
      assert.equal(full.body.error, "Up to 100 custom fields. Delete one you no longer use.");
    } finally {
      await pool().query("DELETE FROM hd_custom_fields WHERE key LIKE $1", [`${K}_fill_%`]);
      cf.invalidateCustomFields();
    }
  });

  test("the order: the listed fields come first, the rest keep their place; tickets list fields in that order", async () => {
    const t = await ticket("Order");
    assert.deepEqual((await shown("agent", t.number)).slice(0, 3), ["device", "serial", "notes"]);
    const r = await admin.order([F.notes, F.device]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await shown("agent", t.number)).slice(0, 4), ["notes", "device", "serial", "cost"]);
    assert.equal((await admin.order([F.device, 999_999_999])).status, 409);
    assert.equal((await admin.order("device")).status, 400);
    assert.equal((await admin.order([F.device, F.serial, F.notes])).status, 200);
    assert.deepEqual((await shown("agent", t.number)).slice(0, 3), ["device", "serial", "notes"]);
    assert.ok((await auditRows("helpdesk.custom_field.reordered", P.dadmin.id)).length >= 2);
  });

  test("a team that is deleted drops out; a field left with no team is shown nowhere and can still be edited", async () => {
    const team = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9421) RETURNING id", [`${STAMP} gone`])).rows[0].id as number;
    const id = await field("orphan", { team_ids: [team] });
    await pool().query("DELETE FROM hd_teams WHERE id = $1", [team]);
    const t = await ticket("Orphan", null);
    assert.deepEqual(await cf.ticketCustomFields({ id: t.id, team_id: null }), [], "no team: only All teams fields");
    const put = await admin.put(id, { label: `Orphan again ${STAMP}` });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.field.team_ids, []);
    assert.equal((await admin.put(id, { archived: true })).status, 200);
    await admin.del(id);
  });
});

describe("on a ticket", () => {
  test("an agent who works the ticket sets every kind; each change leaves an internal line; the detail lists the fields in order", async () => {
    const t = await ticket("Kinds");
    const before = (await read("agent", t.number)).body.custom_fields;
    assert.deepEqual(before.map((f: { key: string; value: unknown; text: string }) => [f.key.replace(`${K}_`, ""), f.value, f.text]), [
      ["device", null, ""],
      ["serial", null, ""],
      ["notes", null, ""],
      ["cost", null, ""],
      ["due", null, ""],
      ["owner", null, ""],
      ["billable", null, ""],
      ["site", null, ""],
    ]);
    assert.equal(before[0].visibility, "public");
    assert.equal(before[0].help, "What the ticket is about.");
    assert.deepEqual(before[0].options, DEVICE_OPTIONS);

    const r = await patch("agent", t.number, {
      custom_fields: { [key("device")]: "laptop", [key("serial")]: "  C02XK1 ", [key("notes")]: "Line one\nLine two", [key("cost")]: "149.5", [key("due")]: "2026-12-01", [key("owner")]: P.agent2.id, [key("billable")]: false, [key("site")]: "north" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.changed, ["custom_fields"]);
    assert.deepEqual(await stored(t.id), { device: "laptop", serial: "C02XK1", notes: "Line one\nLine two", cost: 149.5, due: "2026-12-01", owner: P.agent2.id, billable: false, site: "north" });
    const after = (await read("agent", t.number)).body.custom_fields;
    assert.deepEqual(after.map((f: { text: string }) => f.text), ["Laptop", "C02XK1", "Line one\nLine two", "149.5", "2026-12-01", P.agent2.name, "No", "North"]);
    const ls = await lines(t.id);
    assert.equal(ls.length, 8);
    assert.ok(ls.every((l) => l.kind === "internal"), "every line is agents-only, a Public field's too");
    assert.ok(ls[0].body.includes("set device") && ls[0].body.endsWith("to Laptop"), ls[0].body);
    assert.ok(ls[6].body.endsWith("to No"));

    // The same value again changes nothing; null and "" clear.
    const same = await patch("agent", t.number, { custom_fields: { [key("device")]: "laptop" } });
    assert.deepEqual(same.body.changed, []);
    assert.equal((await lines(t.id)).length, 8);
    const clear = await patch("agent", t.number, { custom_fields: { [key("serial")]: null, [key("notes")]: "  ", [key("billable")]: true } });
    assert.deepEqual(clear.body.changed, ["custom_fields"]);
    const now = await stored(t.id);
    assert.ok(!("serial" in now) && !("notes" in now));
    assert.equal(now.billable, true);
    assert.ok((await lines(t.id)).some((l) => l.kind === "internal" && /cleared serial/.test(l.body)));
    assert.equal((await patch("agent", t.number, { custom_fields: { [key("serial")]: null } })).body.changed.length, 0, "clearing an empty field changes nothing");

    // With another change in the same PATCH.
    const both = await patch("agent", t.number, { tags: ["vpn"], custom_fields: { [key("cost")]: 20 } });
    assert.deepEqual(both.body.changed, ["tags", "custom_fields"]);
  });

  test("a bad key or value is refused with a sentence and nothing is saved", async () => {
    const t = await ticket("Refusals");
    const bad = async (custom_fields: unknown, extra: Record<string, unknown> = {}) => {
      const r = await patch("agent", t.number, { ...extra, custom_fields });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      return r.body.error as string;
    };
    assert.match(await bad("device=laptop"), /^Send custom_fields as an object keyed by field key/);
    assert.match(await bad([1]), /^Send custom_fields as an object/);
    assert.equal(await bad({ nope_not_a_field: 1 }), 'There is no custom field with the key "nope_not_a_field".');
    assert.equal(await bad({ [key("device")]: "tablet" }), `"device ${STAMP}" must be one of its options.`);
    assert.equal(await bad({ [key("cost")]: "a lot" }), `"cost ${STAMP}" must be a number.`);
    assert.equal(await bad({ [key("due")]: "2026-02-31" }), `"due ${STAMP}" must be a date.`);
    assert.equal(await bad({ [key("owner")]: 999_999_999 }), `"owner ${STAMP}" must be a person in this workspace.`);
    assert.equal(await bad({ [key("billable")]: "yes" }), `"billable ${STAMP}" is ticked or not.`);
    assert.equal(await bad({ [key("serial")]: "x".repeat(501) }), `"serial ${STAMP}" is longer than 500 characters.`);
    assert.equal(await bad({ [key("room")]: "B12" }), `"room ${STAMP}" isn't a field of this ticket's team.`);
    // One bad value refuses the whole PATCH: the good value and the tag are not saved either.
    assert.equal(await bad({ [key("serial")]: "GOOD", [key("cost")]: "bad" }, { tags: ["x"] }), `"cost ${STAMP}" must be a number.`);
    assert.deepEqual(await stored(t.id), {});
    assert.deepEqual((await pool().query("SELECT tags FROM hd_tickets WHERE id = $1", [t.id])).rows[0].tags, []);
    assert.equal((await lines(t.id)).length, 0);

    const none = await ticket("No team", null);
    const r = await patch("dadmin", none.number, { custom_fields: { [key("serial")]: "X" } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, `"serial ${STAMP}" isn't a field of tickets with no team.`);
  });

  test("the same permission as the ticket's other properties: an agent who works it, a newbie too; nobody else", async () => {
    const t = await ticket("Who");
    assert.equal((await patch("newbie", t.number, { custom_fields: { [key("serial")]: "N1" } })).status, 200, "a newbie sets a category, so a custom field too");
    assert.equal((await patch("other", t.number, { custom_fields: { [key("serial")]: "O1" } })).status, 404, "an agent of another team does not reach the ticket");
    assert.ok([401, 403].includes((await patch("req", t.number, { custom_fields: { [key("serial")]: "R1" } })).status), "the requester has no desk");
    assert.ok([401, 403].includes((await patch("stranger", t.number, { custom_fields: { [key("serial")]: "S1" } })).status));
    assert.deepEqual(await stored(t.id), { serial: "N1" });
  });
});

describe("moving team", () => {
  test("the ticket shows the new team's fields; values are kept and shown again when it comes back", async () => {
    const t = await ticket("Move");
    await patch("agent", t.number, { custom_fields: { [key("device")]: "phone", [key("serial")]: "KEEP-ME", [key("site")]: "south" } });
    assert.deepEqual(await shown("agent", t.number), ["device", "serial", "notes", "cost", "due", "owner", "billable", "site"]);

    const moved = await patch("dadmin", t.number, { team_id: T.B });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(await shown("agent", t.number), ["room", "site"], "team B's fields only");
    const onB = (await read("agent", t.number)).body.custom_fields;
    assert.equal(onB.find((f: { key: string }) => f.key === key("site")).value, "south", "a field assigned to both teams keeps showing its value");
    assert.deepEqual(await stored(t.id), { device: "phone", serial: "KEEP-ME", site: "south" }, "nothing is deleted by a move");
    // A field of the old team can't be set while the ticket is elsewhere.
    assert.equal((await patch("agent", t.number, { custom_fields: { [key("serial")]: "NEW" } })).status, 400);
    assert.equal((await patch("agent", t.number, { custom_fields: { [key("room")]: "B12" } })).status, 200);

    // A move and a value in one PATCH: checked against the team it moves to.
    const back = await patch("dadmin", t.number, { team_id: T.A, custom_fields: { [key("cost")]: 5 } });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual(back.body.changed, ["team_id", "custom_fields"]);
    const onA = (await read("agent", t.number)).body.custom_fields;
    assert.deepEqual(
      onA.filter((f: { value: unknown }) => f.value !== null).map((f: { key: string; value: unknown }) => [f.key.replace(`${K}_`, ""), f.value]),
      [["device", "phone"], ["serial", "KEEP-ME"], ["cost", 5], ["site", "south"]],
      "back on team A: its values are there again"
    );
    assert.equal((await stored(t.id)).room, "B12", "team B's value waits in storage");
    const wrong = await patch("dadmin", t.number, { team_id: T.B, custom_fields: { [key("cost")]: 6 } });
    assert.equal(wrong.status, 400, "a field of the team it is leaving");
    assert.equal((await pool().query("SELECT team_id FROM hd_tickets WHERE id = $1", [t.id])).rows[0].team_id, T.A, "the refused PATCH moved nothing");

    // Taken out of its team: only All teams fields would show (this file makes none).
    assert.equal((await patch("dadmin", t.number, { team_id: null })).status, 200);
    assert.deepEqual(await cf.ticketCustomFields({ id: t.id, team_id: null }).then((x) => x.filter((f) => f.key.startsWith(K))), []);
    assert.equal(Object.keys(await stored(t.id)).length, 5);
  });
});

describe("the requester's side", () => {
  const SECRET = `AGENTONLY-${STAMP}`;
  const SECRET_NOTE = `PRIVATE-NOTE-${STAMP}`;

  test("a Public field with a value is read on the request; an agent-only value is reachable through no requester route, tool, export or email", async () => {
    const t = await ticket("Requester");
    await pool().query("UPDATE hd_tickets SET assignee_id = $2 WHERE id = $1", [t.id, P.agent.id]);
    // Nothing filled in yet: no Details block.
    const empty = await call(requestRoute.GET, req(`/requests/${t.number}`, P.req.session), { number: String(t.number) });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.request.details, undefined);

    const mailsBefore = mail.length;
    const set = await patch("agent", t.number, {
      custom_fields: { [key("device")]: "desktop", [key("due")]: "2026-12-24", [key("serial")]: SECRET, [key("notes")]: SECRET_NOTE, [key("owner")]: P.agent2.id, [key("cost")]: 987654, [key("billable")]: true },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    // A public reply after the values are set (the requester is emailed).
    await messages.addMessage(t.id, { kind: "public", body: "We have ordered it.", author: { id: P.agent.id, name: P.agent.name, email: "" }, via: "desk" });
    await new Promise((r) => setTimeout(r, 300));

    const leaks = (what: string, text: string) => {
      assert.ok(!text.includes(SECRET), `${what}: the agent-only text value`);
      assert.ok(!text.includes(SECRET_NOTE), `${what}: the agent-only long text value`);
      assert.ok(!text.includes("987654"), `${what}: the agent-only number`);
      assert.ok(!text.includes(key("serial")) && !text.includes(key("notes")) && !text.includes(key("cost")) && !text.includes(key("owner")) && !text.includes(key("billable")), `${what}: an agent-only field's key`);
      assert.ok(!text.includes(`serial ${STAMP}`) && !text.includes(`notes ${STAMP}`) && !text.includes(`cost ${STAMP}`) && !text.includes(`billable ${STAMP}`), `${what}: an agent-only field's label`);
    };

    // 1. Get help: the request itself.
    const one = await call(requestRoute.GET, req(`/requests/${t.number}`, P.req.session), { number: String(t.number) });
    assert.equal(one.status, 200);
    assert.deepEqual(one.body.request.details, [
      { key: key("device"), label: `device ${STAMP}`, type: "select", value: "Desktop" },
      { key: key("due"), label: `due ${STAMP}`, type: "date", value: "2026-12-24" },
    ]);
    leaks("GET /requests/[n]", JSON.stringify(one.body));
    assert.ok(!one.body.request.messages.some((m: { body: string }) => /Desktop|2026-12-24/.test(m.body)), "no timeline line of a Public field either: the Details block is where it shows");
    // 2. Get help: the list.
    const list = await call(requestsRoute.GET, req("/requests", P.req.session));
    assert.equal(list.status, 200);
    leaks("GET /requests", JSON.stringify(list.body));
    // 3. The agents' routes refuse a requester outright.
    assert.ok([401, 403].includes((await read("req", t.number)).status));
    assert.ok([401, 403].includes((await call(checkRoute.GET, req(`/tickets/${t.number}/solve-requirements`, P.req.session), { number: String(t.number) })).status));
    assert.ok([401, 403].includes((await call(adminRoute.GET, req("/admin/custom-fields", P.req.session))).status));
    // 4. Someone else's request: nothing at all.
    const stranger = await call(requestRoute.GET, req(`/requests/${t.number}`, P.stranger.session), { number: String(t.number) });
    assert.ok([403, 404].includes(stranger.status));
    leaks("a stranger", JSON.stringify(stranger.body));
    // 5. The requester's Claude tools.
    const reqUser = (await getUserById(P.req.id))!;
    const ctx = { origin: "http://localhost", ip: null };
    const tool = await hdTools.callHelpdeskTool(reqUser, "hd_read_request", { number: t.number }, ctx);
    assert.equal(tool.isError, false, tool.content[0].text);
    assert.deepEqual(JSON.parse(tool.content[0].text).details, [
      { label: `device ${STAMP}`, value: "Desktop" },
      { label: `due ${STAMP}`, value: "2026-12-24" },
    ]);
    leaks("hd_read_request", tool.content[0].text);
    leaks("hd_my_requests", (await hdTools.callHelpdeskTool(reqUser, "hd_my_requests", {}, ctx)).content[0].text);
    const asAgentTool = await hdTools.callHelpdeskTool(reqUser, "hd_read_ticket", { number: t.number }, ctx);
    assert.equal(asAgentTool.isError, true, "the agents' tool refuses a requester");
    leaks("hd_read_ticket as the requester", asAgentTool.content[0].text);
    // 6. Their personal data export.
    const exported = await retention.personalHelpdeskExport(P.req.id);
    const mine = exported.requests.find((r) => r.number === t.number);
    assert.ok(mine || !exported.included);
    if (mine) assert.deepEqual(mine.details, [{ label: `device ${STAMP}`, value: "Desktop" }, { label: `due ${STAMP}`, value: "2026-12-24" }]);
    leaks("the personal data export", JSON.stringify(exported));
    // 7. Requester-facing email: nothing about custom fields at all.
    const sent = mail.slice(mailsBefore);
    for (const m of sent) leaks(`email to ${m.to}`, JSON.stringify(m));
    // 8. The one read every requester surface makes, asked directly.
    assert.deepEqual((await cf.publicCustomDetails({ id: t.id, team_id: T.A })).map((d) => d.key), [key("device"), key("due")]);

    // A Public field made Agent only is gone from the requester's side at once; back when it is Public again.
    await admin.put(F.due, { visibility: "agent" });
    const hidden = await call(requestRoute.GET, req(`/requests/${t.number}`, P.req.session), { number: String(t.number) });
    assert.deepEqual(hidden.body.request.details.map((d: { key: string }) => d.key), [key("device")]);
    assert.ok(!JSON.stringify(hidden.body).includes("2026-12-24"), "no line left behind in the conversation");
    await admin.put(F.due, { visibility: "public" });
    // Archived: not shown to the requester either.
    await admin.put(F.device, { archived: true });
    assert.deepEqual((await call(requestRoute.GET, req(`/requests/${t.number}`, P.req.session), { number: String(t.number) })).body.request.details.map((d: { key: string }) => d.key), [key("due")]);
    await admin.put(F.device, { archived: false });
    // Moved to a team the field is not assigned to: not shown.
    await patch("dadmin", t.number, { team_id: T.B });
    assert.equal((await call(requestRoute.GET, req(`/requests/${t.number}`, P.req.session), { number: String(t.number) })).body.request.details, undefined);
    await patch("dadmin", t.number, { team_id: T.A });
  });

  test("the customer portal: a contact reads Public values, never a person's name, never an agent-only value", async () => {
    const addr = `${STAMP}-cust@customer.example.test`;
    const contact = (await pool().query("INSERT INTO hd_portal_contacts (email, name) VALUES ($1, 'Casey Customer') RETURNING id", [addr])).rows[0].id as number;
    contactIds.push(contact);
    const r = await pool().query(
      "INSERT INTO hd_tickets (subject, requester_name, requester_email, team_id, status, source, portal_contact_id) VALUES ($1, 'Casey Customer', $2, $3, 'open', 'portal_external', $4) RETURNING id, number",
      [`Portal ${STAMP}`, addr, T.A, contact]
    );
    ticketIds.push(r.rows[0].id);
    const n = r.rows[0].number as number;
    const person = await field("contact_person", { type: "user", visibility: "public" });
    assert.equal((await patch("agent", n, { custom_fields: { [key("device")]: "phone", [key("serial")]: SECRET, [key("contact_person")]: P.agent2.id } })).status, 200);
    const d = await portal.contactRequestDetail({ id: contact, email: addr }, n);
    assert.ok(d);
    assert.deepEqual(d!.details, [{ label: `device ${STAMP}`, value: "Phone" }], "the Public choice; not the person, not the agent-only serial");
    const text = JSON.stringify(d) + JSON.stringify(await portal.listContactRequests(contact));
    assert.ok(!text.includes(SECRET) && !text.includes(P.agent2.name) && !text.includes(key("serial")));
    // Get help names the person (a colleague in the workspace); the portal does not.
    assert.ok((await cf.publicCustomDetails({ id: r.rows[0].id, team_id: T.A })).some((x) => x.value === P.agent2.name));
    await admin.del(person);
  });
});

describe("integrations", () => {
  test("the REST API: custom_fields on GET and PATCH; a bad key, team or value is 400; the definitions are listed", async () => {
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
        headers: { authorization: `Bearer ${made.body.token}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.78" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), params);
    const t = await ticket("API");
    const got = await api(v1TicketRoute.GET, `/tickets/${t.number}`, "GET", undefined, { number: String(t.number) });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const mineOf = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith(K)).map(([k, v]) => [k.replace(`${K}_`, ""), v]));
    assert.deepEqual(mineOf(got.body.custom_fields), { device: null, serial: null, notes: null, cost: null, due: null, owner: null, billable: null, site: null });

    const ok = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { custom_fields: { [key("device")]: "laptop", [key("cost")]: 12.5, [key("billable")]: true } }, { number: String(t.number) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.changed, ["custom_fields"]);
    assert.deepEqual(mineOf(ok.body.ticket.custom_fields), { device: "laptop", serial: null, notes: null, cost: 12.5, due: null, owner: null, billable: true, site: null });
    assert.ok((await lines(t.id)).every((l) => l.body.endsWith(" via API")));

    for (const [body, error] of [
      [{ custom_fields: { [key("device")]: "tablet" } }, `"device ${STAMP}" must be one of its options.`],
      [{ custom_fields: { [key("room")]: "B1" } }, `"room ${STAMP}" isn't a field of this ticket's team.`],
      [{ custom_fields: { nope: 1 } }, 'There is no custom field with the key "nope".'],
      [{ custom_fields: "x" }, 'Send custom_fields as an object keyed by field key, like { "impact": "high" }. null clears a value.'],
    ] as const) {
      const r = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", body, { number: String(t.number) });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, error);
    }
    const cleared = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { custom_fields: { [key("cost")]: null } }, { number: String(t.number) });
    assert.equal(mineOf(cleared.body.ticket.custom_fields).cost, null);

    const defs = await api(v1FieldsRoute.GET, "/custom-fields", "GET");
    assert.equal(defs.status, 200, JSON.stringify(defs.body));
    const device = defs.body.custom_fields.find((f: { key: string }) => f.key === key("device"));
    assert.deepEqual(device, {
      key: key("device"),
      label: `device ${STAMP}`,
      type: "select",
      help: "What the ticket is about.",
      options: [{ value: "laptop", label: "Laptop" }, { value: "desktop", label: "Desktop" }, { value: "phone", label: "Phone" }],
      visibility: "public",
      all_teams: false,
      team_ids: [T.A],
      archived: false,
    });
    assert.equal((await call(v1FieldsRoute.GET, new Request("http://localhost/api/helpdesk/v1/custom-fields", { headers: { "x-forwarded-for": "203.0.113.79" } }))).status, 401, "a bearer token is needed");
  });

  test("webhooks: the ticket in every payload carries custom_fields; ticket.updated lists the change", async () => {
    const hook = await pool().query(
      "INSERT INTO hd_webhooks (name, url, events, team_ids, secret_sealed) VALUES ($1, 'https://hooks.example.test/x', '{ticket.updated,ticket.solved}', $2, 'sealed') RETURNING id",
      [`${STAMP} hook`, [T.A]]
    );
    hookIds.push(hook.rows[0].id);
    const t = await ticket("Webhook");
    assert.equal((await patch("agent", t.number, { custom_fields: { [key("device")]: "phone", [key("serial")]: "W-1" } })).status, 200);
    assert.equal((await patch("agent", t.number, { status: "solved" })).status, 200);
    const rows = (await pool().query("SELECT event, payload FROM hd_webhook_deliveries WHERE hook_id = $1 AND ticket_id = $2 ORDER BY id", [hook.rows[0].id, t.id])).rows;
    const updated = rows.find((r) => r.event === "ticket.updated");
    assert.ok(updated, JSON.stringify(rows.map((r) => r.event)));
    assert.deepEqual(updated.payload.changes, ["custom_fields"]);
    assert.equal(updated.payload.ticket.custom_fields[key("device")], "phone");
    assert.equal(updated.payload.ticket.custom_fields[key("serial")], "W-1");
    assert.equal(updated.payload.ticket.custom_fields[key("cost")], null);
    assert.equal(updated.payload.ticket.number, t.number, "the ticket keeps every field it had");
    const solved = rows.find((r) => r.event === "ticket.solved");
    assert.equal(solved.payload.ticket.custom_fields[key("device")], "phone");
  });

  test("the Claude connector: hd_read_ticket lists the fields and values; hd_update_ticket sets them and says why not", async () => {
    claude.setClaudeLevelForTests("update");
    const t = await ticket("Connector");
    const user = (await getUserById(P.agent.id))!;
    const ctx = { origin: "http://localhost", ip: null };
    const upd = await hdTools.callHelpdeskTool(user, "hd_update_ticket", { number: t.number, custom_fields: { [key("device")]: "desktop", [key("due")]: "2027-01-15" } }, ctx);
    assert.equal(upd.isError, false, upd.content[0].text);
    assert.deepEqual(JSON.parse(upd.content[0].text).changed, ["custom_fields"]);
    assert.ok((await lines(t.id)).every((l) => l.body.endsWith(" via Claude")));
    const out = JSON.parse((await hdTools.callHelpdeskTool(user, "hd_read_ticket", { number: t.number }, ctx)).content[0].text);
    const device = out.custom_fields.find((f: { key: string }) => f.key === key("device"));
    assert.deepEqual(device, {
      key: key("device"),
      label: `device ${STAMP}`,
      type: "select",
      help: "What the ticket is about.",
      options: [{ value: "laptop", label: "Laptop" }, { value: "desktop", label: "Desktop" }, { value: "phone", label: "Phone" }],
      visibility: "public",
      value: "desktop",
      text: "Desktop",
    });
    const bad = await hdTools.callHelpdeskTool(user, "hd_update_ticket", { number: t.number, custom_fields: { [key("device")]: "tablet" } }, ctx);
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /must be one of its options/);
    const def = hdTools.HELPDESK_TOOL_DEFS.find((d) => d.name === "hd_update_ticket")!;
    assert.ok("custom_fields" in (def.inputSchema as { properties: Record<string, unknown> }).properties);
  });

  test("the printed ticket lists the filled-in fields in its details", async () => {
    const t = await ticket("Print");
    await patch("agent", t.number, { custom_fields: { [key("device")]: "laptop", [key("serial")]: "PRINT-1" } });
    const full = (await tickets.getTicketById(t.id))!;
    const view = await share.ticketPrintView({ id: P.agent.id, role: "viewer", name: P.agent.name }, full, { conversation: true, details: true, notes: false, checklists: false, time: false, attachments: false } as never);
    const rows = (view.details ?? []).filter(([label]) => label.endsWith(STAMP));
    assert.deepEqual(rows, [[`device ${STAMP}`, "Laptop"], [`serial ${STAMP}`, "PRINT-1"]]);
  });
});

describe("Before you solve", () => {
  async function requireSet(custom: string[], extra: Record<string, unknown> = {}): Promise<number> {
    const s = await sr.createSolveSet({ name: `${STAMP} set ${setIds.length + 1}`, enabled: true, team_ids: [T.A, T.B], custom_field_ids: custom.map((n) => F[n]), ...extra }, { id: P.dadmin.id });
    setIds.push(s.id);
    return s.id;
  }

  test("a set may require a custom field: saved through the settings route, checked, audited; a deleted field drops out", async () => {
    const extra = await field("extra", { type: "text" });
    const made = await call(solveAdminRoute.POST, req("/admin/solve-requirements", P.dadmin.session, { name: `${STAMP} needs fields`, enabled: true, team_ids: [T.C], custom_field_ids: [F.device, extra, extra] }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.set.id as number;
    setIds.push(id);
    assert.deepEqual(made.body.set.custom_field_ids, [F.device, extra], "a custom field alone is enough to switch a set on");
    const bad = await call(solveAdminOneRoute.PUT, req(`/admin/solve-requirements/${id}`, P.dadmin.session, { custom_field_ids: [999_999_999] }, "PUT"), { id: String(id) });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "One of the custom fields no longer exists. Pick again.");
    assert.equal((await call(solveAdminOneRoute.PUT, req(`/admin/solve-requirements/${id}`, P.dadmin.session, { custom_field_ids: "x" }, "PUT"), { id: String(id) })).status, 400);
    const list = await call(solveAdminRoute.GET, req("/admin/solve-requirements", P.dadmin.session));
    assert.ok(list.body.custom_fields.some((f: { id: number; label: string }) => f.id === F.device && f.label === `device ${STAMP}`), "the settings page is told which fields can be required");
    const put = await call(solveAdminOneRoute.PUT, req(`/admin/solve-requirements/${id}`, P.dadmin.session, { custom_field_ids: [extra] }, "PUT"), { id: String(id) });
    assert.deepEqual(put.body.set.custom_field_ids, [extra]);
    const audits = await auditRows("helpdesk.solve_requirements.updated", P.dadmin.id);
    assert.ok(audits.some((a) => a.details.changed.includes("custom_field_ids")));
    await admin.del(extra);
    assert.deepEqual((await sr.getSolveSet(id))?.custom_field_ids, [], "deleting the field takes it off the set");
    await sr.deleteSolveSet(id);
  });

  test("a solve is refused until the field has a value; sent with the solve it is stored with it, and not at all when the solve is refused", async () => {
    const setId = await requireSet(["device", "billable", "room"], { ticket_fields: ["assignee"] });
    try {
      const t = await ticket("Solve");
      const refused = await patch("agent", t.number, { status: "solved" });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.error, `Before you solve, this ticket needs: an owner, device ${STAMP} and billable ${STAMP}.`, "team B's field is not asked for on a team A ticket");
      assert.equal(refused.body.code, "solve_requirements");
      assert.deepEqual(refused.body.missing.map((m: { kind: string }) => m.kind), ["ticket_field", "custom_field", "custom_field"]);
      assert.deepEqual(refused.body.missing[1], { kind: "custom_field", field_id: F.device, key: key("device"), label: `device ${STAMP}` });

      // What the dialog reads: the fields to draw, each met or not.
      const check = await call(checkRoute.GET, req(`/tickets/${t.number}/solve-requirements`, P.agent.session), { number: String(t.number) });
      assert.equal(check.status, 200);
      assert.deepEqual(check.body.sets[0].custom_fields.map((f: { key: string; met: boolean; type: string }) => [f.key, f.type, f.met]), [[key("device"), "select", false], [key("billable"), "checkbox", false]]);
      assert.deepEqual(check.body.sets[0].custom_fields[0].options, DEVICE_OPTIONS);
      // The dialog's check before it submits: a bad value is said, good ones count, nothing is stored.
      const post = (solve_fields: unknown) => call(checkRoute.POST, req(`/tickets/${t.number}/solve-requirements`, P.agent.session, { solve_fields }), { number: String(t.number) });
      const badValue = await post({ assignee_id: P.agent.id, custom_fields: { [key("device")]: "tablet" } });
      assert.equal(badValue.status, 400);
      assert.equal(badValue.body.error, `"device ${STAMP}" must be one of its options.`);
      const half = await post({ assignee_id: P.agent.id, custom_fields: { [key("device")]: "laptop" } });
      assert.equal(half.body.error, `Before you solve, this ticket needs: billable ${STAMP}.`);
      const full = await post({ assignee_id: P.agent.id, custom_fields: { [key("device")]: "laptop", [key("billable")]: false } });
      assert.deepEqual(full.body.missing, [], "No is an answer to a yes/no field");
      assert.deepEqual(await stored(t.id), {}, "the check stores nothing");

      // A solve that is still refused stores nothing, the custom value sent with it included.
      const still = await patch("agent", t.number, { status: "solved", assignee_id: P.agent.id, custom_fields: { [key("device")]: "laptop" } });
      assert.equal(still.status, 409);
      assert.equal(still.body.error, `Before you solve, this ticket needs: billable ${STAMP}.`);
      assert.deepEqual(await stored(t.id), {});
      assert.equal((await pool().query("SELECT assignee_id FROM hd_tickets WHERE id = $1", [t.id])).rows[0].assignee_id, null);
      assert.equal((await lines(t.id)).length, 0);

      // Everything in one PATCH: solved, and the values are on the ticket.
      const ok = await patch("agent", t.number, { status: "solved", assignee_id: P.agent.id, custom_fields: { [key("device")]: "laptop", [key("billable")]: false } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(await statusOf(t.id), "solved");
      assert.deepEqual(await stored(t.id), { device: "laptop", billable: false });

      // Filled in on the ticket beforehand: the solve needs nothing more. Reopened: still filled in.
      const t2 = await ticket("Solve 2");
      await pool().query("UPDATE hd_tickets SET assignee_id = $2 WHERE id = $1", [t2.id, P.agent.id]);
      await patch("agent", t2.number, { custom_fields: { [key("device")]: "phone", [key("billable")]: true } });
      assert.equal((await patch("agent", t2.number, { status: "solved" })).status, 200);
      assert.equal((await patch("agent", t2.number, { status: "open" })).status, 200);
      assert.equal((await patch("agent", t2.number, { status: "solved" })).status, 200);

      // A ticket of team B is asked for team B's field, not team A's.
      const tb = await ticket("Solve B", "B");
      await pool().query("UPDATE hd_tickets SET assignee_id = $2 WHERE id = $1", [tb.id, P.agent.id]);
      const onB = await patch("agent", tb.number, { status: "solved" });
      assert.equal(onB.body.error, `Before you solve, this ticket needs: room ${STAMP}.`);

      // An archived field is not asked for.
      await admin.put(F.room, { archived: true });
      sr.invalidateSolveSets();
      assert.equal((await patch("agent", tb.number, { status: "solved" })).status, 200);
      await admin.put(F.room, { archived: false });
    } finally {
      await sr.deleteSolveSet(setId);
    }
  });

  test("Send and set Solved carries the dialog's custom fields; the Claude connector is told what to send", async () => {
    const setId = await requireSet(["device"]);
    try {
      const t = await ticket("Send and solve");
      const send = (body: Record<string, unknown>) => call(messagesRoute.POST, req(`/tickets/${t.number}/messages`, P.agent.session, body), { number: String(t.number) });
      const refused = await send({ kind: "public", body: "All done.", then_status: "solved" });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.error, `Before you solve, this ticket needs: device ${STAMP}.`);
      assert.equal((await lines(t.id)).length, 0, "the reply was not sent");
      const bad = await send({ kind: "public", body: "All done.", then_status: "solved", solve_fields: { custom_fields: { [key("device")]: "tablet" } } });
      assert.equal(bad.status, 400);
      const ok = await send({ kind: "public", body: "All done.", then_status: "solved", solve_fields: { custom_fields: { [key("device")]: "desktop" } } });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(await statusOf(t.id), "solved");
      assert.deepEqual(await stored(t.id), { device: "desktop" });

      claude.setClaudeLevelForTests("update");
      const t2 = await ticket("Connector solve");
      const user = (await getUserById(P.agent.id))!;
      const ctx = { origin: "http://localhost", ip: null };
      const out = JSON.parse((await hdTools.callHelpdeskTool(user, "hd_read_ticket", { number: t2.number }, ctx)).content[0].text);
      assert.deepEqual(out.before_you_solve.custom_fields, [
        { key: key("device"), label: `device ${STAMP}`, type: "select", options: [{ value: "laptop", label: "Laptop" }, { value: "desktop", label: "Desktop" }, { value: "phone", label: "Phone" }], filled: false },
      ]);
      const no = await hdTools.callHelpdeskTool(user, "hd_update_ticket", { number: t2.number, status: "solved" }, ctx);
      assert.equal(no.isError, true);
      assert.match(no.content[0].text, /custom fields with custom_fields/);
      const yes = await hdTools.callHelpdeskTool(user, "hd_update_ticket", { number: t2.number, status: "solved", custom_fields: { [key("device")]: "phone" } }, ctx);
      assert.equal(yes.isError, false, yes.content[0].text);
      assert.equal(await statusOf(t2.id), "solved");
    } finally {
      await sr.deleteSolveSet(setId);
    }
  });
});

describe("retention", () => {
  test("anonymising a ticket removes text and people from its custom fields; choices, numbers, dates and ticks stay", async () => {
    const t = await ticket("Anon");
    assert.equal(
      (await patch("agent", t.number, { custom_fields: { [key("device")]: "laptop", [key("serial")]: "SN-1", [key("notes")]: "Their flat number is 4", [key("cost")]: 10, [key("due")]: "2026-12-01", [key("owner")]: P.agent2.id, [key("billable")]: true } })).status,
      200
    );
    await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now() WHERE id = $1", [t.id]);
    await withTx((c) => retention.anonymiseTicketTx(c, t.id));
    assert.deepEqual(await stored(t.id), { device: "laptop", cost: 10, due: "2026-12-01", billable: true });
    assert.ok((await lines(t.id)).every((l) => !l.body.includes("flat number") && !l.body.includes("SN-1")), "the timeline lines that quoted them are blanked");
  });

  test("deleting a ticket deletes its values", async () => {
    const t = await ticket("Delete");
    await patch("agent", t.number, { custom_fields: { [key("serial")]: "DEL-1" } });
    await pool().query("DELETE FROM hd_tickets WHERE id = $1", [t.id]);
    assert.equal((await pool().query("SELECT 1 FROM hd_ticket_custom_values WHERE ticket_id = $1", [t.id])).rowCount, 0);
  });
});
