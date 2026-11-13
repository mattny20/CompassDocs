// Helpdesk 1.20.6 managed categories and sub-categories (lib/helpdesk/
// categories): the pure rules (names, how a pick is checked), the upgrade
// path (what is already in use joins the list, one entry per name whatever
// its case), the settings routes (who may, validation, rename, reorder,
// archive, delete, merge, each audited), what a rename and a merge rewrite
// (tickets, request types, automations, saved views, report filters; never a
// timeline line), and every place a category is set or read: the desk's
// PATCH and POST, the REST API, the Claude connector, automations, request
// types, webhooks, the printed ticket, reports and "Before you solve".
//
// Same harness as test/helpdesk-solve-requirements: next/headers and lib/ee
// stubbed, routes called with real sessions. Parallel-safe on a shared
// database: every category this file makes carries STAMP in its name, and
// only those are asserted on and removed (the list is one per workspace, so
// other runs' entries are simply ignored).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-categories.test.ts

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-categories.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-categories.virtual.js");
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
const cats = require("../src/lib/helpdesk/categories") as typeof import("../src/lib/helpdesk/categories");
const shared = require("../src/lib/helpdesk/categories-shared") as typeof import("../src/lib/helpdesk/categories-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const automations = require("../src/lib/helpdesk/automations") as typeof import("../src/lib/helpdesk/automations");
const sr = require("../src/lib/helpdesk/solve-requirements") as typeof import("../src/lib/helpdesk/solve-requirements");
const srShared = require("../src/lib/helpdesk/solve-requirements-shared") as typeof import("../src/lib/helpdesk/solve-requirements-shared");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const hooks = require("../src/lib/helpdesk/webhooks") as typeof import("../src/lib/helpdesk/webhooks");
const claude = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const share = require("../src/lib/helpdesk/share") as typeof import("../src/lib/helpdesk/share");
const reports = require("../src/lib/helpdesk/reports") as typeof import("../src/lib/helpdesk/reports");
const engine = require("../src/lib/helpdesk/analytics/engine") as typeof import("../src/lib/helpdesk/analytics/engine");
const analytics = require("../src/lib/helpdesk/analytics/shared") as typeof import("../src/lib/helpdesk/analytics/shared");
const time = require("../src/lib/helpdesk/time") as typeof import("../src/lib/helpdesk/time");
const ticketFilters = require("../src/lib/helpdesk/ticket-filters") as typeof import("../src/lib/helpdesk/ticket-filters");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const labels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const listRoute = require("../src/app/api/helpdesk/categories/route") as typeof import("../src/app/api/helpdesk/categories/route");
const adminRoute = require("../src/app/api/helpdesk/admin/categories/route") as typeof import("../src/app/api/helpdesk/admin/categories/route");
const adminOneRoute = require("../src/app/api/helpdesk/admin/categories/[id]/route") as typeof import("../src/app/api/helpdesk/admin/categories/[id]/route");
const mergeRoute = require("../src/app/api/helpdesk/admin/categories/[id]/merge/route") as typeof import("../src/app/api/helpdesk/admin/categories/[id]/merge/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const ticketsRoute = require("../src/app/api/helpdesk/tickets/route") as typeof import("../src/app/api/helpdesk/tickets/route");
const automationsRoute = require("../src/app/api/helpdesk/admin/automations/route") as typeof import("../src/app/api/helpdesk/admin/automations/route");
const typesRoute = require("../src/app/api/helpdesk/admin/request-types/route") as typeof import("../src/app/api/helpdesk/admin/request-types/route");
const typeOneRoute = require("../src/app/api/helpdesk/admin/request-types/[id]/route") as typeof import("../src/app/api/helpdesk/admin/request-types/[id]/route");
const optionsRoute = require("../src/app/api/helpdesk/analytics/options/route") as typeof import("../src/app/api/helpdesk/analytics/options/route");
const tokensRoute = require("../src/app/api/helpdesk/admin/api/tokens/route") as typeof import("../src/app/api/helpdesk/admin/api/tokens/route");
const v1TicketRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/route");
const v1TicketsRoute = require("../src/app/api/helpdesk/v1/tickets/route") as typeof import("../src/app/api/helpdesk/v1/tickets/route");
const v1CategoriesRoute = require("../src/app/api/helpdesk/v1/categories/route") as typeof import("../src/app/api/helpdesk/v1/categories/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdCategory, HdCategoryAdmin } from "../src/lib/helpdesk/categories-shared";

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

const STAMP = `hdcat-${Date.now()}-${process.pid}`;
/** A category name of this run: "<STAMP> Hardware". */
const N = (name: string) => `${STAMP} ${name}`;
const P: Record<string, { id: number; session: string; name: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const ticketIds: number[] = [];
const typeIds: number[] = [];
const ruleIds: number[] = [];
const tokenIds: number[] = [];
const hookIds: number[] = [];
const setIds: number[] = [];

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

/** A ticket written straight to the table, as an older version (or an import) would have left it. */
async function ticket(subject: string, extra: { category?: string; subcategory?: string; status?: string; created_at?: string; solved_at?: string } = {}): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source, category, subcategory, created_at, solved_at)
     VALUES ($1, $2, 'Req', $3, $4, $5, 'portal', $6, $7, COALESCE($8::timestamptz, now()), $9) RETURNING id, number`,
    [`${subject} ${STAMP}`, P.req.id, `${STAMP}-req@example.test`, T.A, extra.status ?? "open", extra.category ?? "", extra.subcategory ?? "", extra.created_at ?? null, extra.solved_at ?? null]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

const rowOf = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const pairOf = async (id: number) => {
  const r = await rowOf(id);
  return [r.category, r.subcategory] as [string, string];
};
const lines = async (ticketId: number) => ((await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows as { body: string }[]).map((r) => r.body);
const auditRows = async (action: string) =>
  (await pool().query("SELECT target_label, details FROM audit_log WHERE action = $1 AND actor_id = $2 ORDER BY id", [action, P.admin.id])).rows as { target_label: string; details: any }[];
const patch = (who: string, n: number, body: Record<string, unknown>) => call(ticketRoute.PATCH, req(`/tickets/${n}`, P[who].session, body, "PATCH"), { number: String(n) });

/** This run's entries of the admin list. */
async function mine(): Promise<HdCategoryAdmin[]> {
  const r = await call(adminRoute.GET, req("/admin/categories", P.admin.session));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.categories as HdCategoryAdmin[]).filter((c) => c.name.includes(STAMP));
}
const find = async (name: string) => (await mine()).find((c) => c.name === N(name));
const add = (name: string, parentId?: number) => call(adminRoute.POST, req("/admin/categories", P.admin.session, { name, ...(parentId ? { parent_id: parentId } : {}) }));
/** A category with sub-categories, made through the route. Returns their ids. */
async function make(name: string, subs: string[] = []): Promise<{ id: number; subs: Record<string, number> }> {
  const c = await add(N(name));
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const out: Record<string, number> = {};
  for (const s of subs) {
    const r = await add(s, c.body.category.id);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    out[s] = r.body.category.id;
  }
  return { id: c.body.category.id, subs: out };
}
const change = (id: number, body: Record<string, unknown>) => call(adminOneRoute.PATCH, req(`/admin/categories/${id}`, P.admin.session, body, "PATCH"), { id: String(id) });
const del = (id: number) => call(adminOneRoute.DELETE, req(`/admin/categories/${id}`, P.admin.session, undefined, "DELETE"), { id: String(id) });
const mergeInto = (id: number, into: number) => call(mergeRoute.POST, req(`/admin/categories/${id}/merge`, P.admin.session, { into_id: into }), { id: String(id) });

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  email.setHelpdeskTransportForTests(async () => {});
  hooks.setWebhookAutoSendForTests(false);
  const r = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9420) RETURNING id", [`${STAMP} A`]);
  T.A = r.rows[0].id;
  await person("agent", "agent");
  await person("manager", "manager");
  await person("admin", "admin");
  await person("req", null);
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent')", [T.A, P.agent.id]);
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  claude.setClaudeLevelForTests(null);
  email.setHelpdeskTransportForTests(null);
  hooks.setWebhookAutoSendForTests(true);
  await pool().query("DELETE FROM hd_solve_requirement_sets WHERE id = ANY($1) OR name LIKE $2", [setIds, `%${STAMP}%`]);
  sr.invalidateSolveSets();
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE id = ANY($1) OR team_id = $2", [ticketIds, T.A])).rows.map((r) => r.id as number);
  await pool().query("DELETE FROM hd_webhooks WHERE id = ANY($1) OR name LIKE $2", [hookIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_automations WHERE id = ANY($1) OR name LIKE $2", [ruleIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1) OR slug LIKE $2", [typeIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_saved_views WHERE name LIKE $1", [`${STAMP}%`]);
  await pool().query("DELETE FROM hd_dashboards WHERE name LIKE $1", [`${STAMP}%`]);
  await pool().query("DELETE FROM hd_api_tokens WHERE id = ANY($1) OR name LIKE $2", [tokenIds, `${STAMP}%`]);
  // Sub-categories go with their category (ON DELETE CASCADE).
  await pool().query("DELETE FROM hd_categories WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = $1", [T.A]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2 OR details::text LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

describe("the rules (pure)", () => {
  const list: HdCategory[] = [
    { id: 1, name: "Hardware", archived: false, subcategories: [{ id: 11, name: "Laptop", archived: false }, { id: 12, name: "Dock", archived: true }] },
    { id: 2, name: "Access", archived: false, subcategories: [] },
    { id: 3, name: "Fax", archived: true, subcategories: [{ id: 31, name: "Paper", archived: false }] },
  ];

  test("names: trimmed, inner spaces as one, 1 to 80 characters, never the separator", () => {
    assert.equal(shared.cleanCategoryName("  Hardware   and  devices "), "Hardware and devices");
    assert.equal(shared.cleanCategoryName(7), "");
    assert.equal(shared.categoryNameProblem(""), "Give the category a name.");
    assert.equal(shared.categoryNameProblem("", "sub-category"), "Give the sub-category a name.");
    assert.equal(shared.categoryNameProblem("x".repeat(81)), "Keep the name under 80 characters.");
    assert.equal(shared.categoryNameProblem("x".repeat(80)), null);
    assert.equal(shared.categoryNameProblem("A › B"), "A name can't contain ›.");
    assert.equal(shared.categoryNameProblem("R&D / Lab (2)"), null);
  });

  test("a pair is written Category › Sub-category, and read back", () => {
    assert.equal(shared.categoryLabel("Hardware", "Laptop"), "Hardware › Laptop");
    assert.equal(shared.categoryLabel("Hardware", ""), "Hardware");
    assert.equal(shared.categoryLabel("", "Laptop"), "");
    assert.deepEqual(shared.splitCategoryLabel("Hardware › Laptop"), { category: "Hardware", subcategory: "Laptop" });
    assert.deepEqual(shared.splitCategoryLabel("Hardware"), { category: "Hardware", subcategory: "" });
  });

  test("a pick: on the list whatever its case, in the list's spelling; nothing at all clears both", () => {
    assert.deepEqual(shared.resolveCategoryPick(list, { category: " hardware ", subcategory: "LAPTOP" }), { ok: true, category: "Hardware", subcategory: "Laptop" });
    assert.deepEqual(shared.resolveCategoryPick(list, { category: "access" }), { ok: true, category: "Access", subcategory: "" });
    assert.deepEqual(shared.resolveCategoryPick(list, { category: "" }), { ok: true, category: "", subcategory: "" });
  });

  test("a name that is not on the list is refused, with the allowed values in the sentence and beside it", () => {
    const r = shared.resolveCategoryPick(list, { category: "Printers" });
    assert.deepEqual(r, { ok: false, code: "category_not_listed", error: '"Printers" is not a category on the list. Categories: Hardware, Access.', allowed: ["Hardware", "Access"] });
    const none = shared.resolveCategoryPick([], { category: "Printers" });
    assert.equal(!none.ok && none.error, '"Printers" is not a category on the list. No categories are set up yet. An admin adds them in Desk settings, Categories.');
    const sub = shared.resolveCategoryPick(list, { category: "Hardware", subcategory: "Phone" });
    assert.deepEqual(sub, { ok: false, code: "subcategory_not_listed", error: '"Phone" is not a sub-category of Hardware. Sub-categories of Hardware: Laptop.', allowed: ["Laptop"] });
    const noSubs = shared.resolveCategoryPick(list, { category: "Access", subcategory: "VPN" });
    assert.equal(!noSubs.ok && noSubs.error, '"VPN" is not a sub-category of Access. Access has no sub-categories.');
    const alone = shared.resolveCategoryPick(list, { category: "", subcategory: "Laptop" });
    assert.equal(!alone.ok && alone.error, "A sub-category needs a category. Send the category too.");
  });

  test("archived: can't be set, but what is already held is kept as it is (and so is a value from before the list)", () => {
    const set = shared.resolveCategoryPick(list, { category: "Fax" });
    assert.equal(!set.ok && set.error, '"Fax" is archived, so it can\'t be set on a ticket. Categories: Hardware, Access.');
    assert.deepEqual(shared.resolveCategoryPick(list, { category: "fax" }, { category: "Fax" }), { ok: true, category: "Fax", subcategory: "" });
    // An archived category keeps taking its own sub-categories while the ticket has it.
    assert.deepEqual(shared.resolveCategoryPick(list, { category: "Fax", subcategory: "paper" }, { category: "Fax" }), { ok: true, category: "Fax", subcategory: "Paper" });
    const dock = shared.resolveCategoryPick(list, { category: "Hardware", subcategory: "Dock" });
    assert.equal(!dock.ok && dock.code, "subcategory_not_listed");
    assert.deepEqual(shared.resolveCategoryPick(list, { category: "Hardware", subcategory: "Dock" }, { category: "Hardware", subcategory: "Dock" }), { ok: true, category: "Hardware", subcategory: "Dock" });
    // Typed by an older version and not on the list: kept while it stays, refused as a new value.
    assert.deepEqual(shared.resolveCategoryPick(list, { category: "Old one" }, { category: "Old one" }), { ok: true, category: "Old one", subcategory: "" });
    assert.equal(shared.resolveCategoryPick(list, { category: "Old one" }, { category: "Hardware" }).ok, false);
  });

  test("a long list is cut in the sentence, never in `allowed`; the facts line reads in words", () => {
    const many: HdCategory[] = Array.from({ length: 35 }, (_, i) => ({ id: i + 1, name: `C${i + 1}`, archived: false, subcategories: [] }));
    const r = shared.resolveCategoryPick(many, { category: "x" });
    assert.ok(!r.ok && r.error.endsWith("C30 and 5 more."), !r.ok ? r.error : "");
    assert.equal(!r.ok && r.allowed.length, 35);
    assert.equal(shared.categoryUseLine({ tickets: 1204, request_types: 2, automations: 1 }), "1,204 tickets · 2 request types · 1 automation");
    assert.equal(shared.categoryUseLine({ tickets: 0, request_types: 0, automations: 0 }), "Not used yet");
  });
});

describe("upgrade: what is already in use joins the list", () => {
  test("every category on a ticket, a request type or an automation becomes one entry per name, whatever its case; tickets take that spelling", async () => {
    const a = await ticket("old 1", { category: N("Phones") });
    const b = await ticket("old 2", { category: N("Phones") });
    const c = await ticket("old 3", { category: N("phones") });
    const d = await ticket("old 4", { category: `  ${N("PHONES")} ` });
    const e = await ticket("old 5", { category: N("Wifi") });
    const spaced = await ticket("old 7", { category: `${STAMP}   Wifi` });
    const none = await ticket("old 6");
    const stampOf = async (id: number) => (await pool().query("SELECT updated_at::text AS at FROM hd_tickets WHERE id = $1", [id])).rows[0].at as string;
    const touched = await stampOf(c.id);
    const rt = await fixtureQuery("INSERT INTO hd_request_types (slug, title, category, form, position, active) VALUES ($1, $2, $3, '[]', 999, 0) RETURNING id", [`${STAMP}-old`, `${STAMP} Old type`, N("Onboarding")]);
    typeIds.push(rt.rows[0].id);
    const rule = await fixtureQuery(
      "INSERT INTO hd_automations (name, event, conditions, actions, active, position) VALUES ($1, 'ticket_created', $2, $3, 0, 9999) RETURNING id",
      [`${STAMP} old rule`, JSON.stringify({ categories: [N("wifi"), N("Escalations")] }), JSON.stringify({ category: N("Urgent desk") })]
    );
    ruleIds.push(rule.rows[0].id);

    // (Another process on the same database may run the same step first: what counts is the list afterwards.)
    await cats.adoptCategories();
    const added = [N("Escalations"), N("Onboarding"), N("Phones"), N("Urgent desk"), N("Wifi")].sort();
    assert.deepEqual((await mine()).map((x) => x.name).sort(), added, "one entry per name; the spelling most tickets use; a ticket's spelling before a rule's");
    for (const t of [a, b, c, d]) assert.deepEqual(await pairOf(t.id), [N("Phones"), ""]);
    assert.deepEqual(await pairOf(e.id), [N("Wifi"), ""]);
    assert.deepEqual(await pairOf(spaced.id), [N("Wifi"), ""], "runs of spaces inside a name are one space");
    assert.deepEqual(await pairOf(none.id), ["", ""], "a ticket with no category stays without one");
    assert.equal(await stampOf(c.id), touched, "the spelling fix is not a ticket change of its own: updated_at stays");

    // Again: nothing more to do.
    const again = await cats.adoptCategories();
    assert.deepEqual(again.added.filter((n) => n.includes(STAMP)), []);
    const list = await mine();
    assert.deepEqual(list.map((x) => x.name).sort(), added);
    assert.deepEqual(list.find((x) => x.name === N("Phones"))!.use, { tickets: 4, request_types: 0, automations: 0 });
    assert.deepEqual(list.find((x) => x.name === N("Wifi"))!.use, { tickets: 2, request_types: 0, automations: 1 });
    assert.deepEqual(list.find((x) => x.name === N("Onboarding"))!.use, { tickets: 0, request_types: 1, automations: 0 });
    // Said once in the audit log, by the system.
    const said = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.category.adopted' AND details::text LIKE $1", [`%${STAMP}%`])).rows;
    assert.ok(said.length >= 1);
    assert.ok(labels.hasActionLabel("helpdesk.category.adopted"));
  });

  test("a ticket an older version (or an import) wrote later is taken in on the next read; a sub-category its category does not list is cleared", async () => {
    const late = await ticket("late", { category: N("Typed later") });
    const stale = await ticket("stale", { category: N("Wifi"), subcategory: "Laptop" });
    assert.ok(await find("Typed later"), "opening the settings page takes it in");
    assert.deepEqual(await pairOf(stale.id), [N("Wifi"), ""]);
    assert.deepEqual(await pairOf(late.id), [N("Typed later"), ""]);
  });
});

describe("the settings routes", () => {
  test("only Helpdesk settings may read or change the list; every desk role may read what pickers offer", async () => {
    for (const who of ["agent", "manager", "req"]) {
      assert.equal((await call(adminRoute.GET, req("/admin/categories", P[who].session))).status, 403, who);
      assert.equal((await call(adminRoute.POST, req("/admin/categories", P[who].session, { name: N("Nope") }))).status, 403, who);
      assert.equal((await call(adminOneRoute.PATCH, req("/admin/categories/1", P[who].session, { name: "x" }, "PATCH"), { id: "1" })).status, 403, who);
      assert.equal((await call(adminOneRoute.DELETE, req("/admin/categories/1", P[who].session, undefined, "DELETE"), { id: "1" })).status, 403, who);
      assert.equal((await call(mergeRoute.POST, req("/admin/categories/1/merge", P[who].session, { into_id: 2 }), { id: "1" })).status, 403, who);
    }
    assert.equal((await call(adminRoute.GET, new Request("http://localhost/api/helpdesk/admin/categories"))).status, 401);
    const asAgent = await call(listRoute.GET, req("/categories", P.agent.session));
    assert.equal(asAgent.status, 200);
    assert.equal(asAgent.body.can_manage, false);
    assert.ok(Array.isArray(asAgent.body.categories));
    assert.equal((await call(listRoute.GET, req("/categories", P.admin.session))).body.can_manage, true);
    assert.equal((await call(listRoute.GET, req("/categories", P.req.session))).status, 403, "a requester has no desk side");
  });

  test("add: a category, then sub-categories; names are checked; a name its level already has is refused whatever its case", async () => {
    assert.equal((await add("  ")).status, 400);
    assert.equal((await add("x".repeat(81))).body.error, "Keep the name under 80 characters.");
    assert.equal((await add(`${N("A")} › B`)).body.error, "A name can't contain ›.");
    const hw = await make("Hardware", ["Laptop", "Monitor"]);
    const dup = await add(N("hardware"));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, `There is already a category called "${N("hardware")}".`);
    const dupSub = await add("laptop", hw.id);
    assert.equal(dupSub.status, 409);
    assert.equal(dupSub.body.error, `${N("Hardware")} already has a sub-category called "laptop".`);
    assert.equal((await add("Deeper", hw.subs.Laptop)).status, 404, "two levels only");
    assert.equal((await add("Orphan", 2_000_000_000)).status, 404);
    // The same sub-category name under another category is fine.
    const acc = await make("Access", ["Laptop"]);
    assert.ok(acc.subs.Laptop);
    const got = await find("Hardware");
    assert.deepEqual(got!.subcategories.map((s) => s.name), ["Laptop", "Monitor"]);
    const made = await auditRows("helpdesk.category.created");
    assert.ok(made.some((r) => r.target_label === N("Hardware") && r.details.kind === "category"));
    assert.ok(made.some((r) => r.target_label === `${N("Hardware")} › Laptop` && r.details.kind === "sub-category" && r.details.category === N("Hardware")));
  });

  test("a category holds up to 100 sub-categories", async () => {
    const big = await make("Big");
    await pool().query("INSERT INTO hd_categories (parent_id, name, position) SELECT $1, 'Sub ' || g, g FROM generate_series(1, 100) g", [big.id]);
    const r = await add("One more", big.id);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "A category holds up to 100 sub-categories.");
    assert.equal((await del(big.id)).status, 200, "an unused category goes with its unused sub-categories");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_categories WHERE parent_id = $1", [big.id])).rows[0].n, 0);
  });

  test("reorder: one place up or down within its level", async () => {
    const hw = (await find("Hardware"))!;
    const [laptop, monitor] = hw.subcategories;
    assert.equal((await change(monitor.id, { move: "up" })).body.moved, true);
    assert.deepEqual((await find("Hardware"))!.subcategories.map((s) => s.name), ["Monitor", "Laptop"]);
    assert.equal((await change(monitor.id, { move: "up" })).body.moved, false, "already first");
    assert.equal((await change(laptop.id, { move: "sideways" })).status, 400);
    assert.equal((await change(laptop.id, { move: "up" })).body.moved, true);
    const order = async () => (await mine()).map((c) => c.name).filter((n) => n === N("Hardware") || n === N("Access"));
    assert.deepEqual(await order(), [N("Hardware"), N("Access")]);
    const acc = (await find("Access"))!;
    // (Other runs' categories may sit between the two on a shared database: move until it has passed.)
    for (let i = 0; i < 50 && (await order())[0] !== N("Access"); i++) assert.equal((await change(acc.id, { move: "up" })).status, 200);
    assert.deepEqual(await order(), [N("Access"), N("Hardware")]);
    const moved = await auditRows("helpdesk.category.moved");
    assert.ok(moved.some((r) => r.details.name === "Monitor" && r.details.direction === "up" && r.details.category === N("Hardware")));
    assert.equal((await change(acc.id, { name: "x", archived: true })).status, 400, "one change per call");
  });

  test("rename: the new name is on the tickets, request types, automations, saved views and report filters; a timeline line keeps its words", async () => {
    const net = await make("Network", ["VPN"]);
    const t = await ticket("rename me");
    assert.equal((await patch("agent", t.number, { category: N("Network"), subcategory: "VPN" })).status, 200);
    const rt = await call(typesRoute.POST, req("/admin/request-types", P.admin.session, { title: `${STAMP} Net type`, slug: `${STAMP}-net`, category: N("network"), subcategory: "vpn", active: false }));
    assert.equal(rt.status, 201, JSON.stringify(rt.body));
    typeIds.push(rt.body.request_type.id);
    assert.equal(rt.body.request_type.category, N("Network"), "stored in the list's spelling");
    const rule = await call(automationsRoute.POST, req("/admin/automations", P.admin.session, {
      name: `${STAMP} net rule`,
      event: "ticket_created",
      active: 0,
      conditions: { categories: [N("network")], subcategories: [{ category: N("Network"), subcategory: "vpn" }], keywords: [`${STAMP}zz`] },
      actions: { category: N("Network"), subcategory: "VPN" },
    }));
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
    ruleIds.push(rule.body.automation.id);
    await pool().query("INSERT INTO hd_saved_views (name, owner_id, filters) VALUES ($1, $2, $3), ($4, $2, $5)", [
      `${STAMP} view`,
      P.agent.id,
      JSON.stringify({ view: "all", category: N("Network"), subcategory: "VPN" }),
      `${STAMP} drill`,
      JSON.stringify({ view: "all", subcategory: `${N("Network")} › VPN` }),
    ]);
    await pool().query("INSERT INTO hd_dashboards (name, owner_id, layout) VALUES ($1, $2, $3)", [
      `${STAMP} board`,
      P.admin.id,
      JSON.stringify({ widgets: [{ id: "w1", filters: { category: [N("Network"), "Something else"] } }], filters: { category: [N("Network")] }, range: { preset: "30d" }, compare: null }),
    ]);

    const taken = await change(net.id, { name: N("hardware") });
    assert.equal(taken.status, 409);
    assert.match(taken.body.error, /Use Merge into… to bring the two together\.$/);
    const r = await change(net.id, { name: N("Networking") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.renamed, { from: N("Network"), to: N("Networking"), tickets: 1 });
    assert.deepEqual(await pairOf(t.id), [N("Networking"), "VPN"]);
    const type = (await pool().query("SELECT category, subcategory FROM hd_request_types WHERE id = $1", [rt.body.request_type.id])).rows[0];
    assert.deepEqual([type.category, type.subcategory], [N("Networking"), "VPN"]);
    const stored = (await pool().query("SELECT conditions, actions FROM hd_automations WHERE id = $1", [rule.body.automation.id])).rows[0];
    assert.deepEqual(stored.conditions.categories, [N("Networking")]);
    assert.deepEqual(stored.conditions.subcategories, [{ category: N("Networking"), subcategory: "VPN" }]);
    assert.deepEqual(stored.conditions.keywords, [`${STAMP}zz`], "the rest of the rule is untouched");
    assert.deepEqual(stored.actions, { category: N("Networking"), subcategory: "VPN" });
    const views = (await pool().query("SELECT name, filters FROM hd_saved_views WHERE name LIKE $1 ORDER BY name", [`${STAMP}%`])).rows;
    assert.deepEqual(views.map((v) => v.filters), [{ view: "all", subcategory: `${N("Networking")} › VPN` }, { view: "all", category: N("Networking"), subcategory: "VPN" }]);
    const board = (await pool().query("SELECT layout FROM hd_dashboards WHERE name = $1", [`${STAMP} board`])).rows[0].layout;
    assert.deepEqual(board.filters.category, [N("Networking")]);
    assert.deepEqual(board.widgets[0].filters.category, [N("Networking"), "Something else"]);
    // History: the line written when the category was set still says what was set then.
    assert.ok((await lines(t.id)).some((l) => l.endsWith(`set the category to ${N("Network")} › VPN`)), JSON.stringify(await lines(t.id)));

    // A sub-category's rename reaches the same places.
    const sub = await change(net.subs.VPN, { name: "Remote access" });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.deepEqual(await pairOf(t.id), [N("Networking"), "Remote access"]);
    const stored2 = (await pool().query("SELECT conditions, actions FROM hd_automations WHERE id = $1", [rule.body.automation.id])).rows[0];
    assert.deepEqual(stored2.conditions.subcategories, [{ category: N("Networking"), subcategory: "Remote access" }]);
    assert.deepEqual(stored2.actions, { category: N("Networking"), subcategory: "Remote access" });
    const views2 = (await pool().query("SELECT filters FROM hd_saved_views WHERE name LIKE $1 ORDER BY name", [`${STAMP}%`])).rows.map((v) => v.filters);
    assert.deepEqual(views2, [{ view: "all", subcategory: `${N("Networking")} › Remote access` }, { view: "all", category: N("Networking"), subcategory: "Remote access" }]);
    assert.equal((await change(net.id, { name: N("Networking") })).status, 200, "the same name again changes nothing");
    const renamed = await auditRows("helpdesk.category.renamed");
    assert.deepEqual(renamed.map((x) => [x.details.kind, x.details.from, x.details.to, x.details.tickets]), [
      ["category", N("Network"), N("Networking"), 1],
      ["sub-category", "VPN", "Remote access", 1],
    ]);
    assert.equal((await change(2_000_000_000, { name: "x" })).status, 404);
  });

  test("archive: hidden from pickers and refused as a new value, kept on the tickets that have it; refused while a request type or an automation still sets it; restore", async () => {
    const net = (await find("Networking"))!;
    const held = await change(net.id, { archived: true });
    assert.equal(held.status, 409);
    assert.equal(held.body.error, `New tickets still get this category from the request type "${STAMP} Net type" and the automation "${STAMP} net rule". Change those first, then archive.`);
    const fax = await make("Fax", ["Paper"]);
    const t = await ticket("fax");
    assert.equal((await patch("agent", t.number, { category: N("Fax"), subcategory: "Paper" })).status, 200);
    const ok = await change(fax.id, { archived: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await find("Fax"))!.archived, true);
    const offered = (await call(listRoute.GET, req("/categories", P.agent.session))).body.categories as HdCategory[];
    assert.equal(offered.find((c) => c.name === N("Fax"))!.archived, true, "marked, so the ticket that has it can show it");
    assert.ok(!(await cats.activeCategories()).some((c) => c.name === N("Fax")));
    // The ticket keeps it through other changes, and may keep or drop its sub-category…
    assert.equal((await patch("agent", t.number, { priority: "high", category: N("Fax") })).status, 200);
    assert.deepEqual(await pairOf(t.id), [N("Fax"), "Paper"]);
    // …but no other ticket can be given it.
    const other = await ticket("no fax");
    const refused = await patch("agent", other.number, { category: N("Fax") });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "category_not_listed");
    assert.match(refused.body.error, new RegExp(`^"${N("Fax")}" is archived, so it can't be set on a ticket\\. Categories: `));
    assert.ok(!refused.body.allowed.includes(N("Fax")));
    assert.deepEqual(await pairOf(other.id), ["", ""]);
    // A sub-category is archived on its own.
    const hw = (await find("Hardware"))!;
    const monitor = hw.subcategories.find((s) => s.name === "Monitor")!;
    assert.equal((await change(monitor.id, { archived: true })).status, 200);
    const sub = await patch("agent", other.number, { category: N("Hardware"), subcategory: "Monitor" });
    assert.equal(sub.status, 400);
    assert.equal(sub.body.code, "subcategory_not_listed");
    assert.deepEqual(sub.body.allowed, ["Laptop"]);
    assert.equal((await change(monitor.id, { archived: false })).status, 200);
    assert.equal((await patch("agent", other.number, { category: N("Hardware"), subcategory: "Monitor" })).status, 200);
    assert.equal((await change(fax.id, { archived: false })).status, 200);
    assert.equal((await change(fax.id, { archived: "yes" })).status, 400);
    assert.deepEqual((await auditRows("helpdesk.category.archived")).map((x) => x.target_label), [N("Fax"), `${N("Hardware")} › Monitor`]);
    assert.deepEqual((await auditRows("helpdesk.category.restored")).map((x) => x.target_label), [`${N("Hardware")} › Monitor`, N("Fax")]);
  });

  test("delete: only what nothing uses; the refusal says what still uses it", async () => {
    const net = (await find("Networking"))!;
    const used = await del(net.id);
    assert.equal(used.status, 409);
    assert.equal(used.body.error, "This category is still used by 1 ticket, 1 request type, 1 automation. Merge it into another one to move them, or archive it to keep it on old tickets.");
    const sub = await del(net.subcategories[0].id);
    assert.equal(sub.status, 409);
    assert.match(sub.body.error, /^This sub-category is still used by 1 ticket, 1 request type, 1 automation\./);
    const spare = await make("Spare", ["One"]);
    assert.equal((await del(spare.subs.One)).status, 200);
    assert.equal((await del(spare.id)).status, 200);
    assert.equal((await del(spare.id)).status, 404);
    assert.equal(await find("Spare"), undefined);
    assert.deepEqual((await auditRows("helpdesk.category.deleted")).filter((x) => x.target_label.includes("Spare")).map((x) => x.details.kind), ["sub-category", "category"]);
  });

  test("merge a category into another: its tickets, request types and rules move; a sub-category both have becomes one, the others move across", async () => {
    const from = await make("Printing", ["Toner", "Paper jam"]);
    const into = await make("Printers", ["toner"]);
    const plain = await ticket("m1");
    const toner = await ticket("m2");
    const jam = await ticket("m3");
    assert.equal((await patch("agent", plain.number, { category: N("Printing") })).status, 200);
    assert.equal((await patch("agent", toner.number, { category: N("Printing"), subcategory: "Toner" })).status, 200);
    assert.equal((await patch("agent", jam.number, { category: N("Printing"), subcategory: "Paper jam" })).status, 200);
    const rule = await call(automationsRoute.POST, req("/admin/automations", P.admin.session, {
      name: `${STAMP} print rule`,
      event: "ticket_created",
      active: 0,
      conditions: { subcategories: [{ category: N("Printing"), subcategory: "Toner" }], keywords: [`${STAMP}zz`] },
      actions: { category: N("Printing"), subcategory: "Paper jam" },
    }));
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
    ruleIds.push(rule.body.automation.id);

    assert.equal((await mergeInto(from.id, from.id)).status, 400);
    assert.equal((await mergeInto(from.id, into.subs.toner)).body.error, "A category can only be merged into another category.");
    assert.equal((await mergeInto(from.id, 2_000_000_000)).status, 400);
    assert.equal((await change(into.id, { archived: true })).status, 200);
    const archived = await mergeInto(from.id, into.id);
    assert.equal(archived.status, 409);
    assert.equal(archived.body.error, `"${N("Printers")}" is archived. Restore it first, then merge into it.`);
    assert.equal((await change(into.id, { archived: false })).status, 200);

    const r = await mergeInto(from.id, into.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.merged, { from: N("Printing"), into: N("Printers"), tickets: 3, request_types: 0, moved_subcategories: ["Paper jam"] });
    assert.deepEqual(await pairOf(plain.id), [N("Printers"), ""]);
    assert.deepEqual(await pairOf(toner.id), [N("Printers"), "toner"], "the kept category's spelling");
    assert.deepEqual(await pairOf(jam.id), [N("Printers"), "Paper jam"]);
    assert.equal(await find("Printing"), undefined);
    assert.deepEqual((await find("Printers"))!.subcategories.map((s) => s.name), ["toner", "Paper jam"]);
    const stored = (await pool().query("SELECT conditions, actions FROM hd_automations WHERE id = $1", [rule.body.automation.id])).rows[0];
    assert.deepEqual(stored.conditions.subcategories, [{ category: N("Printers"), subcategory: "toner" }]);
    assert.deepEqual(stored.actions, { category: N("Printers"), subcategory: "Paper jam" });
    assert.ok((await lines(toner.id)).some((l) => l.endsWith(`set the category to ${N("Printing")} › Toner`)), "history keeps the old name");
    const said = (await auditRows("helpdesk.category.merged")).find((x) => x.details.from === N("Printing"))!;
    assert.deepEqual([said.target_label, said.details.kind, said.details.tickets, said.details.moved_subcategories], [N("Printers"), "category", 3, ["Paper jam"]]);
    assert.equal((await mergeInto(from.id, into.id)).status, 404, "it is gone");
  });

  test("merge a sub-category: into another sub-category (of any category), or into a category alone", async () => {
    const printers = (await find("Printers"))!;
    const jam = printers.subcategories.find((s) => s.name === "Paper jam")!;
    const hw = (await find("Hardware"))!;
    const laptop = hw.subcategories.find((s) => s.name === "Laptop")!;
    const t = (await pool().query("SELECT id FROM hd_tickets WHERE category = $1 AND subcategory = 'Paper jam'", [N("Printers")])).rows[0].id as number;
    const r = await mergeInto(jam.id, laptop.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.merged.from, r.body.merged.into, r.body.merged.tickets], [`${N("Printers")} › Paper jam`, `${N("Hardware")} › Laptop`, 1]);
    assert.deepEqual(await pairOf(t), [N("Hardware"), "Laptop"]);
    const rule = (await pool().query("SELECT actions FROM hd_automations WHERE name = $1", [`${STAMP} print rule`])).rows[0];
    assert.deepEqual(rule.actions, { category: N("Hardware"), subcategory: "Laptop" });
    // Into a category alone: the tickets take it and lose the sub-category.
    const toner = (await find("Printers"))!.subcategories.find((s) => s.name === "toner")!;
    const tt = (await pool().query("SELECT id FROM hd_tickets WHERE category = $1 AND subcategory = 'toner'", [N("Printers")])).rows[0].id as number;
    const alone = await mergeInto(toner.id, printers.id);
    assert.equal(alone.status, 200, JSON.stringify(alone.body));
    assert.deepEqual(await pairOf(tt), [N("Printers"), ""]);
    const cond = (await pool().query("SELECT conditions FROM hd_automations WHERE name = $1", [`${STAMP} print rule`])).rows[0].conditions;
    assert.deepEqual(cond.categories, [N("Printers")], "a rule that named the sub-category now names the category");
    assert.equal(cond.subcategories, undefined);
    assert.deepEqual((await find("Printers"))!.subcategories, []);
  });

  test("every list change has a label in the audit log", () => {
    for (const a of ["created", "renamed", "moved", "archived", "restored", "merged", "deleted", "adopted"]) assert.ok(labels.hasActionLabel(`helpdesk.category.${a}`), a);
    assert.equal(labels.actionLabel("helpdesk.category.merged"), "Merged a ticket category into another");
  });
});

describe("on a ticket", () => {
  test("the desk's PATCH: a pick from the list in its spelling; a sub-category belongs to the category; each change leaves one timeline line", async () => {
    const t = await ticket("pick");
    const a = await patch("agent", t.number, { category: N("hardware") });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.changed, ["category"]);
    assert.equal(a.body.ticket.category, N("Hardware"));
    assert.equal(a.body.ticket.subcategory, "");
    const b = await patch("agent", t.number, { subcategory: "laptop" });
    assert.deepEqual(b.body.changed, ["subcategory"]);
    assert.equal(b.body.ticket.subcategory, "Laptop");
    assert.deepEqual((await patch("agent", t.number, { subcategory: "Laptop" })).body.changed, [], "the same value again changes nothing");
    // Another category without a sub-category: the old sub-category goes with the old category.
    const c = await patch("agent", t.number, { category: N("Access") });
    assert.deepEqual(c.body.changed, ["category", "subcategory"]);
    assert.deepEqual(await pairOf(t.id), [N("Access"), ""]);
    // Both at once.
    const d = await patch("agent", t.number, { category: N("Hardware"), subcategory: "Monitor" });
    assert.deepEqual(await pairOf(t.id), [N("Hardware"), "Monitor"]);
    assert.equal(d.status, 200);
    assert.equal((await patch("agent", t.number, { subcategory: "" })).status, 200);
    assert.equal((await patch("agent", t.number, { subcategory: null })).status, 200);
    const e = await patch("agent", t.number, { category: "" });
    assert.deepEqual(e.body.changed, ["category"]);
    assert.deepEqual(await pairOf(t.id), ["", ""]);
    const said = (await lines(t.id)).map((l) => l.replace(P.agent.name, "Agent"));
    assert.deepEqual(said, [
      `Agent set the category to ${N("Hardware")}`,
      "Agent set the sub-category to Laptop",
      `Agent set the category to ${N("Access")}`,
      `Agent set the category to ${N("Hardware")} › Monitor`,
      "Agent cleared the sub-category",
      "Agent cleared the category",
    ]);
  });

  test("anything that is not on the list is refused with a 400 that names the allowed values; nothing is saved and nothing is added", async () => {
    const t = await ticket("refuse");
    const before = (await pool().query("SELECT count(*)::int AS n FROM hd_categories")).rows[0].n;
    const r = await patch("agent", t.number, { category: N("Made up"), priority: "high" });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "category_not_listed");
    assert.ok(r.body.error.startsWith(`"${N("Made up")}" is not a category on the list. Categories: `), r.body.error);
    assert.ok(r.body.allowed.includes(N("Hardware")) && r.body.allowed.includes(N("Access")));
    const row = await rowOf(t.id);
    assert.deepEqual([row.category, row.priority], ["", "normal"], "the whole change is refused, the priority too");
    const sub = await patch("agent", t.number, { category: N("Access"), subcategory: "Monitor" });
    assert.equal(sub.status, 400);
    assert.equal(sub.body.code, "subcategory_not_listed");
    assert.equal(sub.body.error, `"Monitor" is not a sub-category of ${N("Access")}. Sub-categories of ${N("Access")}: Laptop.`);
    const orphan = await patch("agent", t.number, { subcategory: "Laptop" });
    assert.equal(orphan.status, 400);
    assert.equal(orphan.body.error, "A sub-category needs a category. Send the category too.");
    assert.equal((await patch("agent", t.number, { category: "x".repeat(81) })).status, 400);
    assert.equal((await patch("agent", t.number, { subcategory: 7 })).status, 400);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_categories")).rows[0].n >= before, true);
    assert.ok(!(await mine()).some((c) => c.name === N("Made up")), "nothing invented a category");
    assert.deepEqual(await lines(t.id), []);
  });

  test("a new ticket: the agent's form is checked the same way; a request type's category and sub-category apply as before", async () => {
    const post = (body: Record<string, unknown>) => call(ticketsRoute.POST, req("/tickets", P.agent.session, { subject: `new ${STAMP}`, team_id: T.A, requester: { name: "Req", email: `${STAMP}-req@example.test` }, ...body }));
    const bad = await post({ category: N("Made up") });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, "category_not_listed");
    const ok = await post({ category: N("hardware"), subcategory: "laptop" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const made = ok.body.ticket ?? ok.body;
    ticketIds.push(made.id);
    assert.deepEqual(await pairOf(made.id), [N("Hardware"), "Laptop"]);
    // From a request type (the requester's form, an email): what the type says.
    const rt = (await pool().query("SELECT id FROM hd_request_types WHERE slug = $1", [`${STAMP}-net`])).rows[0].id as number;
    const fromType = await tickets.createTicket({ subject: `typed ${STAMP}`, requester: { id: P.req.id, name: "Req", email: `${STAMP}-req@example.test` }, request_type_id: rt, team_id: T.A }, { silent: true });
    ticketIds.push(fromType.id);
    assert.deepEqual([fromType.category, fromType.subcategory], [N("Networking"), "Remote access"]);
    const plain = await tickets.createTicket({ subject: `plain ${STAMP}`, requester: { id: P.req.id, name: "Req", email: `${STAMP}-req@example.test` }, team_id: T.A }, { silent: true });
    ticketIds.push(plain.id);
    assert.deepEqual([plain.category, plain.subcategory], ["", ""]);
  });

  test("the queue filters by category and sub-category; a report's drill-down carries both as one value", async () => {
    const a = await ticket("f1", { category: N("Hardware"), subcategory: "Laptop" });
    const b = await ticket("f2", { category: N("Hardware"), subcategory: "Monitor" });
    const c = await ticket("f3", { category: N("Access"), subcategory: "Laptop" });
    const nums = async (qs: string) =>
      ((await call(ticketsRoute.GET, req(`/tickets?view=all&team=${T.A}&limit=100&q=${encodeURIComponent(STAMP)}&${qs}`, P.agent.session))).body.tickets as { number: number; subject: string }[])
        .filter((t) => /^f\d /.test(t.subject))
        .map((t) => t.number)
        .sort();
    assert.deepEqual(await nums(`category=${encodeURIComponent(N("Hardware"))}`), [a.number, b.number].sort());
    assert.deepEqual(await nums(`category=${encodeURIComponent(N("Hardware"))}&subcategory=Monitor`), [b.number]);
    assert.deepEqual(await nums("subcategory=Laptop"), [a.number, c.number].sort());
    assert.deepEqual(await nums(`subcategory=${encodeURIComponent(`${N("Access")} › Laptop`)}`), [c.number]);
    const parsed = await ticketFilters.parseTicketFilters(new URLSearchParams({ subcategory: "none" }));
    assert.ok(parsed.ok && parsed.filters.subcategory === "");
    const list = (await call(ticketsRoute.GET, req(`/tickets?view=all&team=${T.A}&subcategory=Monitor&category=${encodeURIComponent(N("Hardware"))}&q=${encodeURIComponent(`f2 ${STAMP}`)}`, P.agent.session))).body.tickets;
    assert.equal(list[0].subcategory, "Monitor", "the list row carries it");
  });
});

describe("the REST API", () => {
  test("PATCH takes category and subcategory from the list, refuses anything else with the allowed values; GET /categories lists them; tickets carry subcategory", async () => {
    const made = await call(tokensRoute.POST, new Request("http://localhost/api/helpdesk/admin/api/tokens", {
      method: "POST",
      headers: { cookie: `compass_session=${P.admin.session}`, "content-type": "application/json" },
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

    const listed = await api(v1CategoriesRoute.GET, "/categories", "GET");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const hw = (listed.body.categories as { name: string; subcategories: string[] }[]).find((c) => c.name === N("Hardware"))!;
    assert.deepEqual(hw.subcategories, ["Laptop", "Monitor"]);

    const t = await ticket("api");
    const ok = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { category: N("hardware"), subcategory: "monitor" }, { number: String(t.number) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.ticket.category, ok.body.ticket.subcategory], [N("Hardware"), "Monitor"]);
    assert.deepEqual(ok.body.changed, ["category", "subcategory"]);
    assert.ok((await lines(t.id)).some((l) => l.endsWith(`set the category to ${N("Hardware")} › Monitor via API`)));
    const bad = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { category: N("Invented by a script") }, { number: String(t.number) });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, "category_not_listed");
    assert.ok(bad.body.error.includes("Categories: "));
    assert.ok(bad.body.allowed.includes(N("Hardware")));
    const badSub = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { subcategory: "Tablet" }, { number: String(t.number) });
    assert.equal(badSub.status, 400);
    assert.deepEqual([badSub.body.code, badSub.body.allowed], ["subcategory_not_listed", ["Laptop", "Monitor"]]);
    assert.deepEqual(await pairOf(t.id), [N("Hardware"), "Monitor"]);
    assert.ok(!(await mine()).some((c) => c.name === N("Invented by a script")));
    const got = await api(v1TicketRoute.GET, `/tickets/${t.number}`, "GET", undefined, { number: String(t.number) });
    assert.deepEqual([got.body.category, got.body.subcategory], [N("Hardware"), "Monitor"]);
    const cleared = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { subcategory: null }, { number: String(t.number) });
    assert.equal(cleared.body.ticket.subcategory, null, "none reads null, as category does");
    assert.equal((await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { subcategory: "Monitor" }, { number: String(t.number) })).status, 200);
    const filtered = await api(v1TicketsRoute.GET, `/tickets?view=all&category=${encodeURIComponent(N("Hardware"))}&subcategory=Monitor&q=${encodeURIComponent(`api ${STAMP}`)}`, "GET");
    assert.deepEqual(filtered.body.tickets.map((x: { number: number }) => x.number), [t.number]);
  });
});

describe("the Claude connector", () => {
  test("hd_read_ticket lists the ticket's pair and the list; hd_update_ticket sets one from it and is refused, by name, for anything else; hd_queue filters", async () => {
    claude.setClaudeLevelForTests("update");
    const t = await ticket("mcp");
    const user = (await getUserById(P.agent.id))!;
    const ctx = { origin: "http://localhost", ip: null };
    const set = await hdTools.callHelpdeskTool(user, "hd_update_ticket", { number: t.number, category: N("hardware"), subcategory: "Laptop" }, ctx);
    assert.equal(set.isError, false, set.content[0].text);
    assert.deepEqual(await pairOf(t.id), [N("Hardware"), "Laptop"]);
    assert.ok((await lines(t.id)).some((l) => l.endsWith(`set the category to ${N("Hardware")} › Laptop via Claude`)));
    const read = JSON.parse((await hdTools.callHelpdeskTool(user, "hd_read_ticket", { number: t.number }, ctx)).content[0].text);
    assert.deepEqual([read.category, read.subcategory], [N("Hardware"), "Laptop"]);
    assert.deepEqual(read.categories.find((c: { name: string }) => c.name === N("Hardware")).subcategories, ["Laptop", "Monitor"]);
    const bad = await hdTools.callHelpdeskTool(user, "hd_update_ticket", { number: t.number, category: N("Claude's idea") }, ctx);
    assert.equal(bad.isError, true);
    assert.ok(bad.content[0].text.startsWith(`"${N("Claude's idea")}" is not a category on the list. Categories: `), bad.content[0].text);
    assert.ok(bad.content[0].text.endsWith("(400) Nothing was changed. Only the desk admin adds categories (Desk settings, Categories)."));
    assert.deepEqual(await pairOf(t.id), [N("Hardware"), "Laptop"]);
    assert.ok(!(await mine()).some((c) => c.name === N("Claude's idea")));
    const queue = JSON.parse((await hdTools.callHelpdeskTool(user, "hd_queue", { view: "all", team: T.A, category: N("Hardware"), subcategory: "Laptop", query: `mcp ${STAMP}` }, ctx)).content[0].text);
    assert.deepEqual(queue.tickets.map((x: { number: number; category: string; subcategory: string }) => [x.number, x.category, x.subcategory]), [[t.number, N("Hardware"), "Laptop"]]);
    assert.ok(queue.categories.some((c: { name: string }) => c.name === N("Hardware")));
    const draft = await hdTools.callHelpdeskTool((await getUserById(P.admin.id))!, "hd_draft_request_type", { title: `${STAMP} drafted`, category: N("Not there") }, ctx);
    assert.equal(draft.isError, true);
    assert.ok(draft.content[0].text.includes("is not a category on the list"), draft.content[0].text);
  });
});

describe("automations and request types", () => {
  test("a rule names categories from the list (400 otherwise), is stored in the list's spelling, and sets the pair on a ticket", async () => {
    const post = (body: Record<string, unknown>) => call(automationsRoute.POST, req("/admin/automations", P.admin.session, { name: `${STAMP} rule ${ruleIds.length}`, event: "ticket_created", active: 0, ...body }));
    const badAction = await post({ actions: { category: N("Typed") } });
    assert.equal(badAction.status, 400);
    assert.ok(badAction.body.error.startsWith(`"${N("Typed")}" is not a category on the list. Categories: `), badAction.body.error);
    const badCond = await post({ conditions: { categories: [N("Typed")] }, actions: { priority: "high" } });
    assert.equal(badCond.status, 400);
    assert.ok(badCond.body.error.startsWith(`"${N("Typed")}" is not a category on the list.`));
    const badPair = await post({ conditions: { subcategories: [{ category: N("Hardware"), subcategory: "Tablet" }] }, actions: { priority: "high" } });
    assert.equal(badPair.body.error, `"Tablet" is not a sub-category of ${N("Hardware")}.`);
    assert.equal((await post({ actions: { subcategory: "Laptop" } })).body.error, "Choose the category the sub-category belongs to.");
    assert.equal((await post({ actions: { category: N("Hardware"), subcategory: "Tablet" } })).status, 400);
    const ok = await post({ conditions: { categories: [N("access")] }, actions: { category: N("hardware"), subcategory: "monitor" } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    ruleIds.push(ok.body.automation.id);
    assert.deepEqual(ok.body.automation.conditions.categories, [N("Access")]);
    assert.deepEqual(ok.body.automation.actions, { category: N("Hardware"), subcategory: "Monitor" });

    const t = await ticket("ruled", { category: N("Access") });
    const row = (await tickets.getTicketRow(t.id))!;
    assert.equal(await automations.applyRule(ok.body.automation, row), true);
    assert.deepEqual(await pairOf(t.id), [N("Hardware"), "Monitor"]);
    assert.ok((await lines(t.id)).some((l) => l.startsWith("Automation") && l.endsWith(`set the category to ${N("Hardware")} › Monitor`)), JSON.stringify(await lines(t.id)));
  });

  test("matching: a whole category, or one of its sub-categories; a rule that names only the category leaves a sub-category alone", () => {
    const base = { team_id: 1, priority: "normal" as const, request_type_id: null, source: "email" as const, subject: "", body: "" };
    const m = automations.automationMatches;
    assert.equal(m({ categories: ["Hardware"] }, { ...base, category: "hardware", subcategory: "Laptop" }), true);
    assert.equal(m({ subcategories: [{ category: "Hardware", subcategory: "Laptop" }] }, { ...base, category: "Hardware", subcategory: "laptop" }), true);
    assert.equal(m({ subcategories: [{ category: "Hardware", subcategory: "Laptop" }] }, { ...base, category: "Hardware", subcategory: "Monitor" }), false);
    assert.equal(m({ subcategories: [{ category: "Hardware", subcategory: "Laptop" }] }, { ...base, category: "Hardware" }), false);
    assert.equal(m({ categories: ["Access"], subcategories: [{ category: "Hardware", subcategory: "Laptop" }] }, { ...base, category: "Access", subcategory: "" }), true);
    assert.equal(m({ categories: ["Access"] }, { ...base, category: "Hardware", subcategory: "" }), false);
    const t = { team_id: 1, assignee_id: null, priority: "normal" as const, status: "open" as const, category: "Hardware", subcategory: "Laptop", tags: [] };
    assert.deepEqual(automations.effectivePatch({ category: "Hardware" }, t), {}, "already that category: its sub-category stays");
    assert.deepEqual(automations.effectivePatch({ category: "Hardware", subcategory: "Monitor" }, t), { category: "Hardware", subcategory: "Monitor" });
    assert.deepEqual(automations.effectivePatch({ category: "Access" }, t), { category: "Access" });
    assert.deepEqual(automations.effectivePatch({ category: "Hardware", subcategory: "Laptop" }, t), {});
  });

  test("a request type: its category is picked from the list; changing the category drops the old sub-category", async () => {
    const id = (await pool().query("SELECT id FROM hd_request_types WHERE slug = $1", [`${STAMP}-net`])).rows[0].id as number;
    const put = (body: Record<string, unknown>) => call(typeOneRoute.PATCH, req(`/admin/request-types/${id}`, P.admin.session, body, "PATCH"), { id: String(id) });
    const bad = await put({ category: N("Typed") });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.startsWith(`"${N("Typed")}" is not a category on the list.`), bad.body.error);
    assert.equal((await put({ subcategory: "Tablet" })).status, 400);
    const same = await put({ description: "Changed" });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.deepEqual([same.body.request_type.category, same.body.request_type.subcategory], [N("Networking"), "Remote access"], "a save that changes something else keeps both");
    const moved = await put({ category: N("hardware") });
    assert.deepEqual([moved.body.request_type.category, moved.body.request_type.subcategory], [N("Hardware"), ""]);
    const withSub = await put({ subcategory: "laptop" });
    assert.deepEqual([withSub.body.request_type.category, withSub.body.request_type.subcategory], [N("Hardware"), "Laptop"]);
    const cleared = await put({ category: "" });
    assert.deepEqual([cleared.body.request_type.category, cleared.body.request_type.subcategory], ["", ""]);
  });
});

describe("where a category is read", () => {
  test("webhooks, the printed ticket and the reports' options", async () => {
    const hook = await pool().query(
      "INSERT INTO hd_webhooks (name, url, events, team_ids, secret_sealed) VALUES ($1, 'https://hooks.example.test/c', '{ticket.updated}', $2, 'sealed') RETURNING id",
      [`${STAMP} hook`, [T.A]]
    );
    hookIds.push(hook.rows[0].id);
    const t = await ticket("read");
    assert.equal((await patch("agent", t.number, { category: N("Hardware"), subcategory: "Laptop" })).status, 200);
    const sent = (await pool().query("SELECT payload FROM hd_webhook_deliveries WHERE hook_id = $1 AND ticket_id = $2 ORDER BY id", [hook.rows[0].id, t.id])).rows;
    assert.ok(sent.length >= 1);
    assert.deepEqual([sent[0].payload.ticket.category, sent[0].payload.ticket.subcategory], [N("Hardware"), "Laptop"]);
    const plain = await ticket("read plain");
    await patch("agent", plain.number, { priority: "high" });
    const none = (await pool().query("SELECT payload FROM hd_webhook_deliveries WHERE hook_id = $1 AND ticket_id = $2", [hook.rows[0].id, plain.id])).rows[0];
    assert.deepEqual([none.payload.ticket.category, none.payload.ticket.subcategory], [null, null]);

    const full = (await tickets.getTicketById(t.id))!;
    const print = await share.ticketPrintView({ id: P.agent.id, role: "viewer" }, full, { details: true, notes: false, checklists: false, assets: false } as never);
    assert.deepEqual(print.details!.find((d) => d[0] === "Category"), ["Category", `${N("Hardware")} › Laptop`]);
    const printPlain = await share.ticketPrintView({ id: P.agent.id, role: "viewer" }, (await tickets.getTicketById(plain.id))!, { details: true, notes: false, checklists: false, assets: false } as never);
    assert.equal(printPlain.details!.find((d) => d[0] === "Category"), undefined, "no row for a ticket without one");

    const options = await call(optionsRoute.GET, req("/analytics/options", P.admin.session));
    assert.equal(options.status, 200, JSON.stringify(options.body));
    const names = (options.body.categories as string[]).filter((c) => c.includes(STAMP));
    assert.deepEqual(names, (await mine()).map((c) => c.name), "the list, in the admin's order, whatever is on tickets");
  });

  test("reports break down by sub-category: the summary, the Sub-category dimension and its drill-down, the time export's last column", async () => {
    await ticket("r1", { category: N("Hardware"), subcategory: "Laptop", created_at: "2025-06-03T10:00:00Z", status: "solved", solved_at: "2025-06-03T15:00:00Z" });
    await ticket("r2", { category: N("Hardware"), subcategory: "Laptop", created_at: "2025-06-04T10:00:00Z" });
    await ticket("r3", { category: N("Hardware"), subcategory: "Monitor", created_at: "2025-06-04T11:00:00Z" });
    await ticket("r4", { category: N("Hardware"), created_at: "2025-06-05T11:00:00Z" });
    const r = await reports.reportSummary({ from: "2025-06-01", to: "2025-06-30", team_id: T.A });
    assert.deepEqual(r.by_category, [{ category: N("Hardware"), created: 4, solved: 1 }]);
    assert.deepEqual(r.by_subcategory, [
      { category: N("Hardware"), subcategory: "Laptop", created: 2, solved: 1 },
      { category: N("Hardware"), subcategory: "Monitor", created: 1, solved: 0 },
    ]);
    const csv = reports.reportCsv(r);
    assert.ok(csv.includes(`Category,Sub-category,Created,Solved\r\n"${N("Hardware")}","Laptop","2","1"\r\n"${N("Hardware")}","Monitor","1","0"\r\n`), csv);
    const empty = await reports.reportSummary({ from: "2019-06-01", to: "2019-06-30", team_id: T.A });
    assert.ok(!reports.reportCsv(empty).includes("Sub-category"), "no block while no ticket has one");

    assert.ok(analytics.dimensionsFor("created").includes("subcategory"));
    assert.equal(analytics.HD_DIMENSIONS.subcategory.label, "Sub-category");
    const q = await engine.runQuery({ measure: "created", groupBy: ["subcategory"], range: { from: "2025-06-01", to: "2025-06-30" }, filters: { team: [T.A] } }, { id: P.admin.id, role: "viewer" }, { now: Date.parse("2025-07-01T12:00:00Z") });
    const rows = Object.fromEntries(q.rows.map((x) => [x.labels[0], x.value]));
    assert.deepEqual(rows, { [`${N("Hardware")} › Laptop`]: 2, [`${N("Hardware")} › Monitor`]: 1, "No sub-category": 1 });
    const href = analytics.drillHref("created", ["subcategory"], [`${N("Hardware")} › Laptop`], { team: [T.A] }, { from: "2025-06-01", to: "2025-06-30" })!;
    const params = new URL(href, "http://localhost").searchParams;
    assert.equal(params.get("subcategory"), `${N("Hardware")} › Laptop`);
    const parsed = await ticketFilters.parseTicketFilters(params);
    assert.ok(parsed.ok && parsed.filters.category === N("Hardware") && parsed.filters.subcategory === "Laptop");
    assert.equal(new URL(analytics.drillHref("created", ["subcategory"], [""], {}, { from: "2025-06-01", to: "2025-06-30" })!, "http://localhost").searchParams.get("subcategory"), "none");

    const t = await ticket("timed", { category: N("Hardware"), subcategory: "Monitor" });
    await time.logTime(P.agent.id, t.id, 15, "x");
    const out = await time.exportTimeCsv({ id: P.admin.id, role: "viewer" } as never, { team: [T.A] } as never, "UTC");
    const [head, ...body] = out.csv.trim().split("\r\n");
    assert.ok(head.endsWith('"Source","Sub-category"'), head);
    assert.ok(body.some((l) => l.includes(`"${N("Hardware")}"`) && l.endsWith('"Monitor"')), out.csv);
  });

  test("Before you solve: \"A sub-category\" is asked only while the ticket's category has some to pick", async () => {
    assert.deepEqual(srShared.SOLVE_TICKET_FIELDS.slice(2, 4), ["category", "subcategory"]);
    assert.equal(srShared.SOLVE_TICKET_FIELD_LABEL.subcategory, "A sub-category");
    const set = await sr.createSolveSet({ name: `${STAMP} set`, enabled: true, team_ids: [T.A], ticket_fields: ["category", "subcategory"] }, { id: P.admin.id });
    setIds.push(set.id);
    try {
      const t = await ticket("solve");
      const none = await patch("agent", t.number, { status: "solved" });
      assert.equal(none.status, 409);
      assert.equal(none.body.error, "Before you solve, this ticket needs: a category and a sub-category.");
      const half = await patch("agent", t.number, { status: "solved", category: N("Hardware") });
      assert.equal(half.status, 409);
      assert.equal(half.body.error, "Before you solve, this ticket needs: a sub-category.");
      assert.deepEqual(await pairOf(t.id), ["", ""], "a refused solve saves nothing");
      const done = await patch("agent", t.number, { status: "solved", category: N("Hardware"), subcategory: "Laptop" });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      // A category with no sub-categories has nothing to ask for.
      const bare = await ticket("solve bare");
      const ok = await patch("agent", bare.number, { status: "solved", category: N("Printers") });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    } finally {
      await sr.deleteSolveSet(set.id);
    }
  });
});
