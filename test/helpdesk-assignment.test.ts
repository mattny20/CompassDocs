// Helpdesk 1.19.0 ticket assignment (agent N): round robin (fairness,
// weights, skips for away/offline/paused/capacity/off-shift/newbie), load
// balancing and its ties, concurrency (parallel tickets never exceed
// capacity or go to two people), rules (order, stop, conditions including
// automated senders and business hours, min_role), sticky requester,
// unanswered and away reassignment with the cap of 3, on call (handover,
// DST, cover), nobody eligible → queued → assigned on the sweep, the
// created hook, the API gates, audit rows, the log and the notes.
//
// Route handlers are called directly with real sessions: next/headers
// resolves to a stub serving the request under test and lib/ee to a stub
// that grants "helpdesk".
//
// Parallel-safe: every team, account, calendar and ticket here is this
// file's own (STAMP); every assignment rule it creates is scoped to its own
// teams or to subjects carrying the STAMP, so other files' tickets never
// match. No global setting changes.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-assignment.test.ts

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-assignment.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-assignment.virtual.js");
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
const shared = require("../src/lib/helpdesk/assignment/shared") as typeof import("../src/lib/helpdesk/assignment/shared");
const engine = require("../src/lib/helpdesk/assignment/engine") as typeof import("../src/lib/helpdesk/assignment/engine");
const store = require("../src/lib/helpdesk/assignment/store") as typeof import("../src/lib/helpdesk/assignment/store");
const calendars = require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const push = require("../src/lib/helpdesk/push") as typeof import("../src/lib/helpdesk/push");
const overviewRoute = require("../src/app/api/helpdesk/admin/assignment/route") as typeof import("../src/app/api/helpdesk/admin/assignment/route");
const teamRoute = require("../src/app/api/helpdesk/admin/assignment/teams/[teamId]/route") as typeof import("../src/app/api/helpdesk/admin/assignment/teams/[teamId]/route");
const memberRoute = require("../src/app/api/helpdesk/admin/assignment/teams/[teamId]/members/[userId]/route") as typeof import("../src/app/api/helpdesk/admin/assignment/teams/[teamId]/members/[userId]/route");
const onCallRoute = require("../src/app/api/helpdesk/admin/assignment/teams/[teamId]/on-call/route") as typeof import("../src/app/api/helpdesk/admin/assignment/teams/[teamId]/on-call/route");
const overridesRoute = require("../src/app/api/helpdesk/admin/assignment/teams/[teamId]/on-call/overrides/route") as typeof import("../src/app/api/helpdesk/admin/assignment/teams/[teamId]/on-call/overrides/route");
const rulesRoute = require("../src/app/api/helpdesk/admin/assignment/rules/route") as typeof import("../src/app/api/helpdesk/admin/assignment/rules/route");
const ruleRoute = require("../src/app/api/helpdesk/admin/assignment/rules/[id]/route") as typeof import("../src/app/api/helpdesk/admin/assignment/rules/[id]/route");
const reorderRoute = require("../src/app/api/helpdesk/admin/assignment/rules/reorder/route") as typeof import("../src/app/api/helpdesk/admin/assignment/rules/reorder/route");
const testRoute = require("../src/app/api/helpdesk/admin/assignment/rules/test/route") as typeof import("../src/app/api/helpdesk/admin/assignment/rules/test/route");
const logRoute = require("../src/app/api/helpdesk/tickets/[number]/assignment-log/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/assignment-log/route");
const meRoute = require("../src/app/api/helpdesk/me/auto-assign/route") as typeof import("../src/app/api/helpdesk/me/auto-assign/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdAssignFacts, HdAssignmentRule, HdOnCallRotation } from "../src/lib/helpdesk/assignment/shared";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
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

const STAMP = `hdassign-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const teamIds: number[] = [];
const calendarIds: number[] = [];
const ruleIds: number[] = [];
const T: Record<string, number> = {};
const CAL: Record<string, number> = {};
const delivered: { userId: number; title: string }[] = [];

async function person(key: string, name: string, deskRole: string | null): Promise<Person> {
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
  return P[key];
}

async function team(key: string, calendar: string): Promise<number> {
  const r = await fixtureQuery("INSERT INTO hd_teams (name, position, calendar_id) VALUES ($1, 9100, $2) RETURNING id", [`${STAMP} ${key}`, CAL[calendar]]);
  T[key] = r.rows[0].id;
  teamIds.push(T[key]);
  return T[key];
}

async function member(teamKey: string, personKey: string, role: "agent" | "lead" = "agent") {
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [T[teamKey], P[personKey].id, role]);
}

async function calendar(key: string, schedule: unknown) {
  const r = await pool().query("INSERT INTO hd_calendars (name, timezone, schedule) VALUES ($1, 'UTC', $2) RETURNING id", [`${STAMP} ${key}`, JSON.stringify(schedule)]);
  CAL[key] = r.rows[0].id;
  calendarIds.push(CAL[key]);
}

async function settings(teamKey: string, patch: Record<string, unknown>) {
  const cur = await store.getTeamAssignment(T[teamKey]);
  const v = shared.validateTeamAssignment(patch, cur);
  assert.ok(v.ok, v.ok ? "" : v.error);
  await store.saveTeamAssignment(v.value, null);
}

async function availability(personKey: string, status: string, minutesAgo = 30) {
  await pool().query(
    `INSERT INTO hd_agent_prefs (user_id, availability, updated_at) VALUES ($1, $2, now() - make_interval(mins => $3))
     ON CONFLICT (user_id) DO UPDATE SET availability = EXCLUDED.availability, updated_at = EXCLUDED.updated_at`,
    [P[personKey].id, status, minutesAgo]
  );
}

let seq = 0;
async function ticket(o: {
  team: string | null;
  subject?: string;
  requester?: string;
  priority?: string;
  source?: string;
  automated?: boolean;
  answers?: Record<string, unknown>;
  assignee?: string;
  status?: string;
  solvedAt?: Date;
}): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, assignee_id, status, priority, source, form_answers, automated, solved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, number`,
    [
      `${o.subject ?? "Ticket"} ${STAMP} #${++seq}`,
      o.requester ? P[o.requester].id : null,
      o.requester ? P[o.requester].name : "Monitoring",
      o.requester ? `${STAMP}-${o.requester}@example.test` : "",
      o.team ? T[o.team] : null,
      o.assignee ? P[o.assignee].id : null,
      o.status ?? "new",
      o.priority ?? "normal",
      o.source ?? "portal",
      JSON.stringify(o.answers ?? {}),
      o.automated ? 1 : 0,
      o.solvedAt ?? null,
    ]
  );
  return r.rows[0];
}

const assigneeOf = async (id: number) => (await pool().query("SELECT assignee_id FROM hd_tickets WHERE id = $1", [id])).rows[0].assignee_id as number | null;
const notesOf = async (id: number) =>
  (await pool().query<{ body: string }>("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'internal' ORDER BY id", [id])).rows.map((r) => r.body);
const logOf = async (id: number) =>
  (await pool().query<{ method: string; to_user_id: number | null; from_user_id: number | null; rule_id: number | null }>(
    "SELECT method, to_user_id, from_user_id, rule_id FROM hd_assignment_log WHERE ticket_id = $1 ORDER BY id",
    [id]
  )).rows;
async function rule(input: Record<string, unknown>): Promise<HdAssignmentRule> {
  const v = shared.validateRuleInput(input);
  assert.ok(v.ok, v.ok ? "" : v.error);
  const r = await store.createRule(v.value as import("../src/lib/helpdesk/assignment/shared").HdAssignRuleInput, null);
  ruleIds.push(r.id);
  // Rules are global: run this file's ahead of anyone else's (keeping their order) so another file's rule can't stop the run first.
  await pool().query("UPDATE hd_assignment_rules SET position = -100000 + id WHERE id = $1", [r.id]);
  return (await store.getRule(r.id))!;
}
const stampCond = { field: "subject", op: "contains", value: [STAMP] };

const ALL_DAY = Array.from({ length: 7 }, () => [{ start: "00:00", end: "24:00" }]);
const CLOSED = Array.from({ length: 7 }, () => []);
const OFFICE = [[], ...Array.from({ length: 5 }, () => [{ start: "09:00", end: "17:00" }]), []];

before(async () => {
  await getSetting("__schema_bootstrap__");
  await store.assignmentReady();
  await calendar("open", ALL_DAY);
  await calendar("closed", CLOSED);
  await calendar("office", OFFICE);
  for (const [k, n, r] of [
    ["a1", "Ann One", "agent"],
    ["a2", "Ben Two", "agent"],
    ["a3", "Cat Three", "agent"],
    ["b1", "Dan Four", "agent"],
    ["b2", "Eve Five", "agent"],
    ["lead", "Lee Lead", "team_lead"],
    ["newbie", "Nia New", "newbie"],
    ["mgr", "Max Manager", "manager"],
    ["req", "Rae Requester", null],
    ["x", "Xan Outside", "agent"],
  ] as const) {
    await person(k, n, r);
  }
  await team("rr", "open");
  await team("lb", "open");
  await team("closed", "closed");
  await team("office", "office");
  await team("infra", "open");
  await team("other", "open");
  for (const k of ["a1", "a2", "a3", "newbie"]) await member("rr", k);
  await member("rr", "lead", "lead");
  for (const k of ["b1", "b2"]) await member("lb", k);
  for (const k of ["a1", "a2"]) await member("closed", k);
  for (const k of ["a1", "a2"]) await member("office", k);
  for (const k of ["a1", "a2", "a3"]) await member("infra", k);
  await member("other", "x");
  calendars.invalidateCalendarCache();
  email.setHelpdeskTransportForTests(async () => {});
  push.setPushTransportForTests(async () => ({ status: 201, headers: {} }) as never);
  notify.setAgentDeliverySpyForTests((userId, _e, payload) => {
    if (userIds.includes(userId)) delivered.push({ userId, title: payload.title });
  });
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  push.setPushTransportForTests(null);
  notify.setAgentDeliverySpyForTests(null);
  await pool().query("DELETE FROM hd_assignment_rules WHERE id = ANY($1)", [ruleIds]);
  await pool().query("DELETE FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR subject LIKE $3", [teamIds, userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [teamIds]);
  await pool().query("DELETE FROM hd_calendars WHERE id = ANY($1)", [calendarIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  calendars.invalidateCalendarCache();
  await pool().end();
});

// --- Pure arithmetic --------------------------------------------------------------------

describe("picks (pure)", () => {
  test("weighted round robin: turns in proportion to weight, in id order, wrapping", () => {
    const c = [
      { user_id: 1, weight: 1 },
      { user_id: 2, weight: 2 },
      { user_id: 3, weight: 1 },
    ];
    let cur = { last_user_id: null as number | null, streak: 0 };
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      const p = shared.pickRoundRobin(c, cur)!;
      seen.push(p.user_id);
      cur = { last_user_id: p.user_id, streak: p.streak };
    }
    assert.deepEqual(seen, [1, 2, 2, 3, 1, 2, 2, 3]);
  });

  test("round robin skips people who aren't candidates now and keeps the order", () => {
    assert.equal(shared.pickRoundRobin([{ user_id: 1, weight: 1 }, { user_id: 3, weight: 1 }], { last_user_id: 1, streak: 1 })!.user_id, 3);
    assert.equal(shared.pickRoundRobin([{ user_id: 1, weight: 1 }, { user_id: 3, weight: 1 }], { last_user_id: 2, streak: 1 })!.user_id, 3);
    assert.equal(shared.pickRoundRobin([{ user_id: 1, weight: 1 }], { last_user_id: 3, streak: 1 })!.user_id, 1);
    assert.equal(shared.pickRoundRobin([], { last_user_id: null, streak: 0 }), null);
  });

  test("least loaded: per unit of weight, ties to whoever waited longest, then lowest id", () => {
    const t0 = "2026-11-01T10:00:00Z";
    const t1 = "2026-11-02T10:00:00Z";
    assert.equal(shared.pickLeastLoaded([{ user_id: 1, weight: 1, open_count: 2, last_assigned_at: null }, { user_id: 2, weight: 1, open_count: 1, last_assigned_at: t1 }]), 2);
    assert.equal(shared.pickLeastLoaded([{ user_id: 1, weight: 1, open_count: 1, last_assigned_at: t1 }, { user_id: 2, weight: 1, open_count: 1, last_assigned_at: t0 }]), 2);
    assert.equal(shared.pickLeastLoaded([{ user_id: 5, weight: 1, open_count: 1, last_assigned_at: t0 }, { user_id: 4, weight: 1, open_count: 1, last_assigned_at: null }]), 4);
    assert.equal(shared.pickLeastLoaded([{ user_id: 1, weight: 1, open_count: 2, last_assigned_at: null }, { user_id: 2, weight: 3, open_count: 3, last_assigned_at: null }]), 2);
  });

  test("roles: included roles; min_role keeps seniors, newbies only when included", () => {
    assert.ok(shared.roleTakesTickets("agent", ["agent", "team_lead"], null));
    assert.ok(!shared.roleTakesTickets("newbie", ["agent", "team_lead"], null));
    assert.ok(shared.roleTakesTickets("newbie", ["newbie", "agent"], null));
    assert.ok(!shared.roleTakesTickets("agent", ["agent", "team_lead"], "team_lead"));
    assert.ok(shared.roleTakesTickets("manager", ["agent"], "team_lead"));
    assert.ok(!shared.roleTakesTickets(null, ["agent"], null));
  });
});

describe("conditions (pure)", () => {
  const base: HdAssignFacts = {
    source: "portal",
    automated: false,
    integration_id: null,
    request_type_id: 3,
    team_id: 7,
    priority: "normal",
    category: "Hardware",
    tags: ["laptop"],
    subject: "My VPN is down",
    body: "Since this morning",
    answers: { severity: "high", urgent_needed: "yes" },
    requester: { department: "Finance", office: "London", vip: false, vip_reason: "" },
    open: true,
  };
  const holds = (field: string, op: string, value?: string | string[], f: HdAssignFacts = base) =>
    shared.conditionHolds({ field, op: op as never, value }, f);

  test("text, choice and tag comparisons are case-insensitive", () => {
    assert.ok(holds("text", "contains", ["vpn", "wifi"]));
    assert.ok(!holds("subject", "not_contains", ["VPN"]));
    assert.ok(holds("category", "equals", "hardware"));
    assert.ok(holds("priority", "in", ["normal", "high"]));
    assert.ok(holds("tags", "in", ["LAPTOP"]));
    assert.ok(holds("request_type", "in", ["3"]));
    assert.ok(holds("answer:urgent_needed", "is_true"));
    assert.ok(holds("answer:missing", "is_empty"));
  });

  test("automated sender, source alert, integration", () => {
    const alert = { ...base, source: "alert", automated: true, integration_id: "12", requester: null };
    assert.ok(holds("automated", "is_true", undefined, alert));
    assert.ok(holds("source", "in", ["alert", "api"], alert));
    assert.ok(holds("integration", "in", ["12"], alert));
    assert.ok(!holds("automated", "is_true"));
  });

  test("requester conditions never match a ticket without a person, whatever the operator", () => {
    const alert = { ...base, requester: null };
    for (const [op, v] of [["equals", "Finance"], ["not_equals", "Finance"], ["is_empty", undefined], ["not_empty", undefined]] as const) {
      assert.ok(!holds("requester_department", op, v, alert), op);
    }
    assert.ok(!holds("requester_vip", "is_false", undefined, alert));
    assert.ok(holds("requester_office", "equals", "london"));
    assert.ok(holds("requester_vip", "is_true", undefined, { ...base, requester: { ...base.requester!, vip: true } }));
  });

  test("business hours open/closed; all vs any", () => {
    assert.ok(holds("hours", "equals", "open"));
    assert.ok(holds("hours", "equals", "closed", { ...base, open: false }));
    const c = { match: "all" as const, rules: [{ field: "priority", op: "in" as const, value: ["urgent"] }, { field: "text", op: "contains" as const, value: ["vpn"] }] };
    assert.ok(!shared.conditionsMatch(c, base));
    assert.ok(shared.conditionsMatch({ ...c, match: "any" }, base));
    assert.ok(shared.conditionsMatch({ match: "all", rules: [] }, base));
  });

  test("severity maps to a priority", () => {
    assert.equal(shared.priorityFromSeverity("Critical"), "urgent");
    assert.equal(shared.priorityFromSeverity("major"), "high");
    assert.equal(shared.priorityFromSeverity("warning"), "normal");
    assert.equal(shared.priorityFromSeverity("info"), "low");
    assert.equal(shared.priorityFromSeverity("??"), null);
  });

  test("evaluateRules: order, stop, tags add up, last assign wins, strictest min_role", () => {
    const mk = (id: number, over: Partial<HdAssignmentRule>): HdAssignmentRule => ({
      id,
      name: `R${id}`,
      position: id,
      enabled: 1,
      scope_team_id: null,
      conditions: { match: "all", rules: [] },
      action: { assign: "team_mode" },
      stop: 1,
      created_by: null,
      created_at: "",
      updated_at: "",
      ...over,
    });
    const rules = [
      mk(1, { enabled: 0, action: { assign: "leave_unassigned" } }),
      mk(2, { stop: 0, conditions: { match: "all", rules: [{ field: "text", op: "contains", value: ["vpn"] }] }, action: { assign: "team_mode", add_tags: ["network"], min_role: "agent" } }),
      mk(3, { scope_team_id: 99, action: { assign: "on_call" } }),
      mk(4, { action: { assign: "round_robin_in_team", team_id: 8, set_priority: "from_severity", min_role: "team_lead", add_tags: ["infra"] } }),
      mk(5, { action: { assign: "leave_unassigned" } }),
    ];
    const d = engine.evaluateRules(rules, base, { severity: "critical" });
    assert.deepEqual(d.matched.map((r) => r.id), [2, 4]);
    assert.equal(d.assign, "round_robin_in_team");
    assert.equal(d.rule?.id, 4);
    assert.equal(d.team_id, 8);
    assert.equal(d.priority, "urgent");
    assert.deepEqual(d.add_tags, ["network", "infra"]);
    assert.equal(d.min_role, "team_lead");
    assert.deepEqual(d.trace.map((t) => t.matched), [false, true, false, true, false]);
    assert.match(d.trace[0].reason, /Off/);
    assert.match(d.trace[2].reason, /Only for/);
    assert.match(d.trace[4].reason, /earlier rule stopped/);
  });

  test("validation refuses unknown fields, wrong operators and empty values", () => {
    assert.ok(!shared.validateConditions({ rules: [{ field: "nope", op: "equals", value: "x" }] }).ok);
    assert.ok(!shared.validateConditions({ rules: [{ field: "automated", op: "contains", value: "x" }] }).ok);
    assert.ok(!shared.validateConditions({ rules: [{ field: "subject", op: "contains", value: [] }] }).ok);
    assert.ok(shared.validateConditions({ match: "any", rules: [{ field: "answer:start_date", op: "not_empty" }] }).ok);
    assert.ok(!shared.validateAction({ assign: "user" }).ok);
    assert.ok(!shared.validateAction({ assign: "round_robin_in_team", min_role: "newbie" }).ok);
    assert.ok(shared.validateAction({ assign: "on_call", set_priority: "from_severity", add_tags: "a, B" }).ok);
    const ta = shared.validateTeamAssignment({ mode: "round_robin", include_roles: [], max_open_per_agent: 0 }, shared.defaultTeamAssignment(1));
    assert.ok(!ta.ok);
  });
});

describe("on-call rotation (pure)", () => {
  const rot: HdOnCallRotation = { team_id: 1, user_ids: [11, 22, 33], length_days: 7, handover_time: "09:00", timezone: "Europe/London", starts_on: "2026-10-19" };

  test("weekly handover at the same wall-clock time across the end of BST", () => {
    // 19 Oct is BST (09:00 = 08:00Z); 26 Oct is GMT (09:00 = 09:00Z): that week is 169 hours.
    assert.equal(new Date(shared.handoverAt(rot, 0)).toISOString(), "2026-10-19T08:00:00.000Z");
    assert.equal(new Date(shared.handoverAt(rot, 1)).toISOString(), "2026-10-26T09:00:00.000Z");
    assert.equal(shared.onCallAt(rot, [], Date.parse("2026-10-26T08:30:00Z"))?.user_id, 11);
    assert.equal(shared.onCallAt(rot, [], Date.parse("2026-10-26T09:00:00Z"))?.user_id, 22);
    assert.equal(shared.onCallAt(rot, [], Date.parse("2026-11-09T09:00:00Z"))?.user_id, 11, "wraps after three turns");
    assert.equal(shared.onCallAt(rot, [], Date.parse("2026-10-19T07:59:00Z")), null, "nobody before the first handover");
  });

  test("into BST: the March change keeps 09:00 local", () => {
    const spring = { ...rot, starts_on: "2027-03-22", length_days: 7 };
    assert.equal(new Date(shared.handoverAt(spring, 0)).toISOString(), "2027-03-22T09:00:00.000Z");
    assert.equal(new Date(shared.handoverAt(spring, 1)).toISOString(), "2027-03-29T08:00:00.000Z");
  });

  test("cover overrides the rotation while it lasts; the newest cover wins", () => {
    const o = [
      { id: 1, user_id: 44, starts_at: "2026-10-27T00:00:00Z", ends_at: "2026-10-28T00:00:00Z", source: "override" as const },
      { id: 2, user_id: 55, starts_at: "2026-10-27T12:00:00Z", ends_at: "2026-10-27T13:00:00Z", source: "override" as const },
    ];
    assert.equal(shared.onCallAt(rot, o, Date.parse("2026-10-27T10:00:00Z"))?.user_id, 44);
    assert.equal(shared.onCallAt(rot, o, Date.parse("2026-10-27T12:30:00Z"))?.user_id, 55);
    assert.equal(shared.onCallAt(rot, o, Date.parse("2026-10-28T00:00:00Z"))?.user_id, 22);
  });

  test("the strip splits days at handovers and covers", () => {
    const strip = shared.onCallStrip(rot, [], Date.parse("2026-10-25T12:00:00Z"), 3, "Europe/London");
    assert.deepEqual(strip.map((d) => d.date), ["2026-10-25", "2026-10-26", "2026-10-27"]);
    assert.deepEqual(strip[1].segments.map((s) => s.user_id), [11, 22]);
    assert.equal(strip[1].segments[1].starts_at, "2026-10-26T09:00:00.000Z");
    assert.equal(strip[2].segments.length, 1);
  });
});

// --- The engine against the database -----------------------------------------------------

describe("round robin", () => {
  test("fair turns with weights; newbie and lead not in turn by default; log, note and notice", async () => {
    await settings("rr", { mode: "round_robin", include_roles: ["agent"] });
    await store.setMember(T.rr, P.a2.id, { weight: 2 });
    const got: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t = await ticket({ team: "rr" });
      const r = await engine.assignTicket(t.id, { trigger: "created" });
      assert.equal(r.outcome, "assigned", r.reason);
      assert.equal(r.method, "round_robin");
      got.push(r.user_id!);
    }
    const [a1, a2, a3] = [P.a1.id, P.a2.id, P.a3.id];
    assert.deepEqual(got, [a1, a2, a2, a3, a1, a2, a2, a3]);
    const last = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = $1 ORDER BY id DESC LIMIT 1", [T.rr])).rows[0].id;
    assert.deepEqual(await notesOf(last), [`Assigned to ${P.a3.name} by round robin.`]);
    assert.deepEqual((await logOf(last)).map((l) => [l.method, l.to_user_id]), [["round_robin", a3]]);
    assert.ok(delivered.some((d) => d.userId === a3 && /^Round robin assigned you #/.test(d.title)));
    await store.setMember(T.rr, P.a2.id, { weight: 1 });
    // Close the round's tickets so capacity tests start from zero.
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE team_id = $1", [T.rr]);
  });

  test("skips away (Available only), offline, paused, at capacity; away counts with Available or away", async () => {
    await settings("rr", { mode: "round_robin", include_roles: ["agent"], eligible: "available", max_open_per_agent: 1 });
    await availability("a1", "away");
    await availability("a2", "available");
    await availability("a3", "offline");
    let t = await ticket({ team: "rr" });
    assert.equal((await engine.assignTicket(t.id, { trigger: "created" })).user_id, P.a2.id);
    // a2 is now at capacity (1 open); a1 away; a3 offline: nobody.
    t = await ticket({ team: "rr" });
    const r = await engine.assignTicket(t.id, { trigger: "created" });
    assert.equal(r.outcome, "queued");
    assert.match(r.reason, /Ann is away/);
    assert.match(r.reason, /Ben has 1 open tickets \(the limit is 1\)/);
    assert.match(r.reason, /Cat is offline/);
    assert.deepEqual(await notesOf(t.id), [`No one available; waiting in the queue. (${r.reason}.)`]);
    // Away counts now: a1 takes it on the sweep.
    await settings("rr", { eligible: "available_or_away" });
    const s = await engine.assignmentSweep(new Date(), { teamIds: [T.rr] });
    assert.ok(s.assigned >= 1);
    assert.equal(await assigneeOf(t.id), P.a1.id);
    assert.match((await notesOf(t.id))[1], /^Assigned to Ann One by round robin/);
    // Paused: a1 opted out; a2/a1 full; queued.
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE team_id = $1", [T.rr]);
    await store.setMember(T.rr, P.a1.id, { paused: 1 });
    await availability("a3", "available");
    t = await ticket({ team: "rr" });
    const r2 = await engine.assignTicket(t.id, { trigger: "created" });
    assert.notEqual(r2.user_id, P.a1.id);
    await store.setMember(T.rr, P.a1.id, { paused: 0 });
    await availability("a1", "available");
    await settings("rr", { max_open_per_agent: null, eligible: "available" });
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE team_id = $1", [T.rr]);
  });

  test("newbies only when included", async () => {
    await settings("rr", { include_roles: ["newbie"] });
    const t = await ticket({ team: "rr" });
    assert.equal((await engine.assignTicket(t.id, { trigger: "created" })).user_id, P.newbie.id);
    await settings("rr", { include_roles: ["agent"] });
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE team_id = $1", [T.rr]);
  });

  test("manual teams leave tickets in the queue, with no note", async () => {
    await settings("other", { mode: "manual" });
    const t = await ticket({ team: "other" });
    const r = await engine.assignTicket(t.id, { trigger: "created" });
    assert.equal(r.outcome, "left");
    assert.equal(await assigneeOf(t.id), null);
    assert.deepEqual(await notesOf(t.id), []);
  });
});

describe("off shift: queued, then assigned on the sweep", () => {
  test("a closed calendar with respect_shift queues; reopening hours lets the sweep assign it", async () => {
    await settings("closed", { mode: "round_robin" });
    const t = await ticket({ team: "closed" });
    const r = await engine.assignTicket(t.id, { trigger: "created" });
    assert.equal(r.outcome, "queued");
    assert.match(r.reason, /outside its office hours/);
    // A second attempt does not write a second note.
    await engine.assignTicket(t.id, { trigger: "retry" });
    assert.equal((await notesOf(t.id)).length, 1);
    const st = await store.getTicketState(t.id);
    assert.ok(st?.queued_since);
    await pool().query("UPDATE hd_teams SET calendar_id = $2 WHERE id = $1", [T.closed, CAL.open]);
    calendars.invalidateCalendarCache();
    const later = new Date(Date.now() + 15 * 60_000);
    await engine.assignmentSweep(later, { teamIds: [T.closed] });
    assert.ok([P.a1.id, P.a2.id].includes((await assigneeOf(t.id))!));
    assert.match((await notesOf(t.id))[1], /after waiting in the queue for 1[45]m\.$/);
    assert.equal((await store.getTicketState(t.id))?.queued_since, null);
    await pool().query("UPDATE hd_teams SET calendar_id = $2 WHERE id = $1", [T.closed, CAL.closed]);
    calendars.invalidateCalendarCache();
  });

  test("respect_shift off assigns outside hours", async () => {
    await settings("closed", { respect_shift: 0 });
    const t = await ticket({ team: "closed" });
    assert.equal((await engine.assignTicket(t.id, { trigger: "created" })).outcome, "assigned");
    await settings("closed", { respect_shift: 1 });
  });
});

describe("load balanced and concurrency", () => {
  test("ties go to whoever waited longest since their last assignment", async () => {
    await settings("lb", { mode: "load_balanced", max_open_per_agent: null });
    await store.insertLog({ ticket_id: (await ticket({ team: "lb", status: "solved" })).id, method: "manual", to_user_id: P.b1.id, at: new Date() });
    await store.insertLog({ ticket_id: (await ticket({ team: "lb", status: "solved" })).id, method: "manual", to_user_id: P.b2.id, at: new Date(Date.now() - 3_600_000) });
    const t = await ticket({ team: "lb" });
    const r = await engine.assignTicket(t.id, { trigger: "created" });
    assert.equal(r.method, "load_balanced");
    assert.equal(r.user_id, P.b2.id);
    // Now b2 has 1 open, b1 0: b1 next.
    const t2 = await ticket({ team: "lb" });
    assert.equal((await engine.assignTicket(t2.id, { trigger: "created" })).user_id, P.b1.id);
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE team_id = $1", [T.lb]);
  });

  test("parallel tickets never exceed capacity and never go to two people", async () => {
    await settings("lb", { mode: "load_balanced", max_open_per_agent: 2 });
    const ts = await Promise.all(Array.from({ length: 7 }, () => ticket({ team: "lb" })));
    const rs = await Promise.all(ts.map((t) => engine.assignTicket(t.id, { trigger: "created" })));
    assert.equal(rs.filter((r) => r.outcome === "assigned").length, 4, JSON.stringify(rs.map((r) => r.reason)));
    assert.equal(rs.filter((r) => r.outcome === "queued").length, 3);
    const counts = (await pool().query("SELECT assignee_id, count(*)::int AS n FROM hd_tickets WHERE team_id = $1 AND status = 'new' AND assignee_id IS NOT NULL GROUP BY 1", [T.lb])).rows;
    assert.deepEqual(counts.map((c) => c.n).sort(), [2, 2]);
    for (const t of ts) assert.ok((await logOf(t.id)).length <= 1, "one assignment per ticket");
    // A person in two teams is counted once: b1 joins rr; rr's round robin respects the lb capacity? No: capacity is per team setting,
    // but the count is every team's open tickets.
    await member("rr", "b1");
    await settings("rr", { max_open_per_agent: 2, include_roles: ["agent"] });
    await store.setMember(T.rr, P.a1.id, { paused: 1 });
    await store.setMember(T.rr, P.a2.id, { paused: 1 });
    await store.setMember(T.rr, P.a3.id, { paused: 1 });
    const t = await ticket({ team: "rr" });
    const r = await engine.assignTicket(t.id, { trigger: "created" });
    assert.equal(r.outcome, "queued");
    assert.match(r.reason, /Dan has 2 open tickets/);
    await pool().query("DELETE FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [T.rr, P.b1.id]);
    for (const k of ["a1", "a2", "a3"]) await store.setMember(T.rr, P[k].id, { paused: 0 });
    await settings("rr", { max_open_per_agent: null });
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE team_id = ANY($1)", [[T.lb, T.rr]]);
  });
});

describe("rules", () => {
  test("alerts from a monitoring sender go to Infra, round robin, priority from severity; the note names the rule", async () => {
    await settings("infra", { mode: "manual" });
    const r1 = await rule({
      name: `Alerts to Infra ${STAMP}`,
      conditions: { match: "all", rules: [stampCond, { field: "automated", op: "is_true" }, { field: "source", op: "in", value: ["alert"] }] },
      action: { team_id: T.infra, assign: "round_robin_in_team", set_priority: "from_severity", add_tags: ["alert"] },
    });
    const t = await ticket({ team: null, source: "alert", automated: true, answers: { severity: "critical" }, subject: "Disk full on db1" });
    const res = await engine.assignTicket(t.id, { trigger: "created" });
    assert.equal(res.outcome, "assigned", res.reason);
    assert.equal(res.rule_id, r1.id);
    const row = (await pool().query("SELECT team_id, priority, tags FROM hd_tickets WHERE id = $1", [t.id])).rows[0];
    assert.equal(row.team_id, T.infra);
    assert.equal(row.priority, "urgent");
    assert.deepEqual(row.tags, ["alert"]);
    const notes = await notesOf(t.id);
    assert.ok(notes.some((n) => n.startsWith("Assignment rule “") && /moved the ticket/.test(n)), notes.join(" | "));
    assert.match(notes[notes.length - 1], new RegExp(`by round robin \\(rule “Alerts to Infra ${STAMP}”\\)\\.$`));
    assert.equal((await logOf(t.id))[0].rule_id, r1.id);
    // A person's ticket does not match the automated rule.
    const p = await ticket({ team: "other", requester: "req", subject: "Disk full on my laptop" });
    const res2 = await engine.assignTicket(p.id, { trigger: "created" });
    assert.notEqual(res2.rule_id, r1.id);
    await store.updateRule(r1.id, { enabled: 0 });
  });

  test("order and stop: the first matching rule wins; a disabled rule is skipped; stop 0 carries on", async () => {
    const scope = { match: "all", rules: [stampCond, { field: "text", op: "contains", value: ["printer"] }] };
    const a = await rule({ name: `Tag printers ${STAMP}`, scope_team_id: T.other, stop: 0, conditions: scope, action: { assign: "team_mode", add_tags: ["printer"] } });
    const off = await rule({ name: `Off ${STAMP}`, scope_team_id: T.other, enabled: 0, conditions: scope, action: { assign: "user", user_id: P.a1.id } });
    const b = await rule({ name: `Printers to Xan ${STAMP}`, scope_team_id: T.other, conditions: scope, action: { assign: "user", user_id: P.x.id } });
    const c = await rule({ name: `Never reached ${STAMP}`, scope_team_id: T.other, conditions: scope, action: { assign: "leave_unassigned" } });
    const t = await ticket({ team: "other", requester: "req", subject: "Printer jam" });
    const r = await engine.assignTicket(t.id, { trigger: "created" });
    assert.equal(r.method, "rule");
    assert.equal(r.user_id, P.x.id);
    assert.equal(r.rule_id, b.id);
    assert.deepEqual((await pool().query("SELECT tags FROM hd_tickets WHERE id = $1", [t.id])).rows[0].tags, ["printer"]);
    assert.match((await notesOf(t.id)).at(-1)!, new RegExp(`^Assigned to Xan Outside by rule “Printers to Xan ${STAMP}”\\.`));
    // Reorder: c first → leave unassigned.
    const all = (await store.listRules()).map((x) => x.id);
    const order = [c.id, ...all.filter((id) => id !== c.id)];
    assert.ok(await store.reorderRules(order));
    const t2 = await ticket({ team: "other", requester: "req", subject: "Printer again" });
    const r2 = await engine.assignTicket(t2.id, { trigger: "created" });
    assert.equal(r2.outcome, "left");
    assert.equal(await assigneeOf(t2.id), null);
    assert.match((await notesOf(t2.id))[0], /left it in the queue/);
    for (const id of [a.id, off.id, b.id, c.id]) await store.updateRule(id, { enabled: 0 });
  });

  test("min_role: urgent tickets go to a team lead or above, even when leads aren't in the turn", async () => {
    await settings("rr", { mode: "round_robin", include_roles: ["agent"] });
    const r = await rule({
      name: `Urgent to seniors ${STAMP}`,
      scope_team_id: T.rr,
      conditions: { match: "all", rules: [stampCond, { field: "priority", op: "in", value: ["urgent"] }] },
      action: { assign: "round_robin_in_team", min_role: "team_lead" },
    });
    const t = await ticket({ team: "rr", priority: "urgent", requester: "req" });
    const res = await engine.assignTicket(t.id, { trigger: "created" });
    assert.equal(res.user_id, P.lead.id);
    // Lead away → queued with the decision kept; back → the sweep keeps min_role.
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE id = $1", [t.id]);
    await availability("lead", "offline");
    const t2 = await ticket({ team: "rr", priority: "urgent", requester: "req" });
    assert.equal((await engine.assignTicket(t2.id, { trigger: "created" })).outcome, "queued");
    await engine.assignmentSweep(new Date(), { teamIds: [T.rr] });
    assert.equal(await assigneeOf(t2.id), null, "agents never take it while the rule needs a lead");
    await availability("lead", "available");
    await engine.assignmentSweep(new Date(), { teamIds: [T.rr] });
    assert.equal(await assigneeOf(t2.id), P.lead.id);
    await store.updateRule(r.id, { enabled: 0 });
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE team_id = $1", [T.rr]);
  });

  test("business hours: closed → on call; the note says so", async () => {
    await settings("closed", { mode: "round_robin" });
    const rot = shared.validateRotation({ user_ids: [P.a2.id, P.a1.id], length_days: 1, handover_time: "00:00", timezone: "UTC", starts_on: "2026-01-01" }, T.closed);
    assert.ok(rot.ok);
    await store.saveRotation(rot.value, null);
    const r = await rule({
      name: `After hours on call ${STAMP}`,
      scope_team_id: T.closed,
      conditions: { match: "all", rules: [stampCond, { field: "hours", op: "equals", value: "closed" }] },
      action: { assign: "on_call" },
    });
    const now = new Date();
    const expected = (await engine.onCallNow(T.closed, now))!.user_id;
    const t = await ticket({ team: "closed", requester: "req" });
    const res = await engine.assignTicket(t.id, { trigger: "created", now });
    assert.equal(res.method, "on_call");
    assert.equal(res.user_id, expected);
    assert.match((await notesOf(t.id)).at(-1)!, /because they are on call \(rule “After hours on call/);
    // Cover beats the rotation.
    await store.addOverride(T.closed, P.a1.id === expected ? P.a2.id : P.a1.id, new Date(now.getTime() - 60_000), new Date(now.getTime() + 3_600_000), null);
    const t2 = await ticket({ team: "closed", requester: "req" });
    assert.notEqual((await engine.assignTicket(t2.id, { trigger: "created", now })).user_id, expected);
    await store.updateRule(r.id, { enabled: 0 });
  });

  test("a rule naming someone who can't work the team falls back to the team's setting", async () => {
    await settings("lb", { mode: "load_balanced", max_open_per_agent: null });
    const r = await rule({ name: `To an outsider ${STAMP}`, scope_team_id: T.lb, conditions: { match: "all", rules: [stampCond] }, action: { assign: "user", user_id: P.x.id } });
    const t = await ticket({ team: "lb", requester: "req" });
    const res = await engine.assignTicket(t.id, { trigger: "created" });
    assert.ok([P.b1.id, P.b2.id].includes(res.user_id!));
    assert.match((await notesOf(t.id)).at(-1)!, /The rule's person can't take this team's tickets/);
    await store.updateRule(r.id, { enabled: 0 });
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE team_id = $1", [T.lb]);
  });
});

describe("sticky requester", () => {
  test("prefers whoever last solved this requester's ticket, when eligible", async () => {
    await settings("rr", { mode: "round_robin", include_roles: ["agent"], sticky_requester: 1 });
    await ticket({ team: "rr", requester: "req", assignee: "a3", status: "solved", solvedAt: new Date() });
    const t = await ticket({ team: "rr", requester: "req" });
    const r = await engine.assignTicket(t.id, { trigger: "created" });
    assert.equal(r.method, "sticky");
    assert.equal(r.user_id, P.a3.id);
    assert.match((await notesOf(t.id))[0], /because they helped this requester last time/);
    // Not eligible (offline): normal round robin.
    await availability("a3", "offline");
    const t2 = await ticket({ team: "rr", requester: "req" });
    const r2 = await engine.assignTicket(t2.id, { trigger: "created" });
    assert.equal(r2.method, "round_robin");
    assert.notEqual(r2.user_id, P.a3.id);
    await availability("a3", "available");
    await settings("rr", { sticky_requester: 0 });
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE team_id = $1", [T.rr]);
  });
});

describe("reassignment", () => {
  test("unanswered: counted in business minutes; at most 3 automatic reassignments, then one note", async () => {
    await settings("office", { mode: "round_robin", unanswered_minutes: 30, respect_shift: 0 });
    // Friday 6 Nov 2026 16:50 UTC (office 09:00-17:00 Mon-Fri, UTC).
    const fri = new Date("2026-11-06T16:50:00Z");
    const t = await ticket({ team: "office", requester: "req" });
    const first = await engine.assignTicket(t.id, { trigger: "created", now: fri });
    assert.equal(first.outcome, "assigned");
    // Monday 09:15: 10 + 15 = 25 business minutes. Not yet.
    await engine.assignmentSweep(new Date("2026-11-09T09:15:00Z"), { teamIds: [T.office] });
    assert.equal(await assigneeOf(t.id), first.user_id);
    // 09:25: 35 business minutes.
    const s = await engine.assignmentSweep(new Date("2026-11-09T09:25:00Z"), { teamIds: [T.office] });
    assert.equal(s.reassignedUnanswered, 1);
    const second = await assigneeOf(t.id);
    assert.notEqual(second, first.user_id);
    assert.match((await notesOf(t.id)).at(-1)!, /^Reassigned from .+ to .+: no first reply within 30 business minutes\.$/);
    // A public reply by the owner stops it.
    await pool().query("INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at) VALUES ($1, $2, 'x', 'public', 'On it', 'desk', '2026-11-09T09:30:00Z')", [t.id, second]);
    await engine.assignmentSweep(new Date("2026-11-09T11:00:00Z"), { teamIds: [T.office] });
    assert.equal(await assigneeOf(t.id), second);
    // Two more reassignments on another ticket, then the cap.
    const u = await ticket({ team: "office", requester: "req" });
    await engine.assignTicket(u.id, { trigger: "created", now: new Date("2026-11-09T10:00:00Z") });
    const hours = ["11:00", "12:00", "13:00", "14:00", "15:00"];
    for (const h of hours) await engine.assignmentSweep(new Date(`2026-11-09T${h}:00Z`), { teamIds: [T.office] });
    const reassigns = (await logOf(u.id)).filter((l) => l.method === "reassign_unanswered");
    assert.equal(reassigns.length, 3);
    assert.equal((await store.getTicketState(u.id))?.auto_reassigns, 3);
    const capNotes = (await notesOf(u.id)).filter((n) => /Reassigned automatically 3 times already/.test(n));
    assert.equal(capNotes.length, 1);
    await settings("office", { unanswered_minutes: null });
  });

  test("away: tickets move once the owner has been away past the grace; not when reassign is off", async () => {
    await settings("rr", { mode: "round_robin", include_roles: ["agent"], reassign_when_away: 0, eligible: "available" });
    const t = await ticket({ team: "rr", requester: "req", assignee: "a1", status: "open" });
    await store.insertLog({ ticket_id: t.id, method: "manual", to_user_id: P.a1.id });
    await availability("a1", "away", 30);
    await engine.assignmentSweep(new Date(), { teamIds: [T.rr] });
    assert.equal(await assigneeOf(t.id), P.a1.id, "off by default");
    await settings("rr", { reassign_when_away: 1 });
    await availability("a1", "away", 2);
    await engine.assignmentSweep(new Date(), { teamIds: [T.rr] });
    assert.equal(await assigneeOf(t.id), P.a1.id, "within the grace");
    await availability("a1", "away", 30);
    const s = await engine.assignmentSweep(new Date(), { teamIds: [T.rr] });
    assert.equal(s.reassignedAway, 1);
    assert.notEqual(await assigneeOf(t.id), P.a1.id);
    const log = await logOf(t.id);
    assert.equal(log.at(-1)!.method, "reassign_away");
    assert.equal(log.at(-1)!.from_user_id, P.a1.id);
    assert.match((await notesOf(t.id)).at(-1)!, /^Reassigned from Ann One to .+: Ann is away or offline\.$/);
    await availability("a1", "available");
    await settings("rr", { reassign_when_away: 0 });
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE team_id = $1", [T.rr]);
  });
});

describe("hooks and manual assignments", () => {
  test("createTicket runs assignment before automations; team change and reopen find an owner", async () => {
    await settings("rr", { mode: "round_robin", include_roles: ["agent"] });
    const created = await tickets.createTicket(
      { subject: `Hooked ${STAMP}`, body: "Hello", requester: { id: P.req.id, name: P.req.name, email: `${STAMP}-req@example.test` }, team_id: T.rr },
      { silent: true }
    );
    assert.ok(created.assignee_id, "assigned by the created hook");
    assert.equal((await logOf(created.id))[0].method, "round_robin");
    // Moving an unassigned ticket to a round-robin team assigns it.
    const t = await ticket({ team: "other", requester: "req" });
    await tickets.updateTicket(t.id, { team_id: T.rr }, { id: P.mgr.id, name: P.mgr.name }, { silent: true });
    assert.ok(await assigneeOf(t.id), "team_changed");
  });

  test("recordManualAssignment logs by hand and takes the ticket out of the queue", async () => {
    const t = await ticket({ team: "closed", requester: "req" });
    await settings("closed", { mode: "round_robin", respect_shift: 1 });
    assert.equal((await engine.assignTicket(t.id, { trigger: "created" })).outcome, "queued");
    await pool().query("UPDATE hd_tickets SET assignee_id = $2 WHERE id = $1", [t.id, P.a1.id]);
    await engine.recordManualAssignment(t.id, { fromUserId: null, toUserId: P.a1.id, teamId: T.closed, actorId: P.mgr.id });
    assert.equal((await store.getTicketState(t.id))?.queued_since, null);
    assert.equal((await logOf(t.id)).at(-1)!.method, "manual");
  });
});

// --- API ---------------------------------------------------------------------------------

describe("API gates, audit and views", () => {
  const audits = async (action: string) =>
    (await pool().query<{ actor_id: number; target_id: string; details: any }>("SELECT actor_id, target_id, details FROM audit_log WHERE action = $1 AND actor_id = ANY($2) ORDER BY id", [action, userIds])).rows;

  test("team settings: the team's lead and a manager may; an agent and another team's lead may not", async () => {
    assert.equal((await call(teamRoute.GET, req(`/admin/assignment/teams/${T.rr}`, P.a1.session), { teamId: String(T.rr) })).status, 403);
    assert.equal((await call(teamRoute.GET, req(`/admin/assignment/teams/${T.lb}`, P.lead.session), { teamId: String(T.lb) })).status, 403);
    const ok = await call(teamRoute.GET, req(`/admin/assignment/teams/${T.rr}`, P.lead.session), { teamId: String(T.rr) });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.members.some((m: any) => m.user_id === P.newbie.id && /Newbie, not included/.test(m.skip_reason)));
    assert.ok(ok.body.next);
    const put = await call(teamRoute.PUT, req(`/admin/assignment/teams/${T.rr}`, P.lead.session, { mode: "load_balanced", max_open_per_agent: 5 }, "PUT"), { teamId: String(T.rr) });
    assert.equal(put.status, 200);
    assert.equal(put.body.settings.mode, "load_balanced");
    const a = (await audits("helpdesk.assignment.team_updated")).filter((r) => r.target_id === String(T.rr));
    assert.ok(a.some((r) => r.details.changed.mode.to === "load_balanced"));
    assert.equal((await call(teamRoute.PUT, req(`/admin/assignment/teams/${T.rr}`, P.lead.session, { mode: "nope" }, "PUT"), { teamId: String(T.rr) })).status, 400);
    assert.equal((await call(teamRoute.GET, req(`/admin/assignment/teams/999999999`, P.mgr.session), { teamId: "999999999" })).status, 404);
    const ov = await call(overviewRoute.GET, req(`/admin/assignment`, P.lead.session));
    assert.equal(ov.status, 200);
    assert.deepEqual(ov.body.teams.map((t: any) => t.id), [T.rr]);
    assert.equal(ov.body.can_manage_rules, false);
  });

  test("members: weight and pause by a lead; pausing is audited", async () => {
    const r = await call(memberRoute.PATCH, req(`/admin/assignment/teams/${T.rr}/members/${P.a2.id}`, P.lead.session, { paused: true }, "PATCH"), { teamId: String(T.rr), userId: String(P.a2.id) });
    assert.equal(r.status, 200);
    assert.equal(r.body.members.find((m: any) => m.user_id === P.a2.id).paused, 1);
    assert.ok((await audits("helpdesk.assignment.member_paused")).some((x) => x.target_id === String(P.a2.id) && x.details.paused === true));
    assert.equal((await call(memberRoute.PATCH, req(`/x`, P.lead.session, { weight: 11 }, "PATCH"), { teamId: String(T.rr), userId: String(P.a2.id) })).status, 400);
    assert.equal((await call(memberRoute.PATCH, req(`/x`, P.lead.session, { weight: 2 }, "PATCH"), { teamId: String(T.rr), userId: String(P.x.id) })).status, 404);
    await store.setMember(T.rr, P.a2.id, { paused: 0 });
  });

  test("me/auto-assign pauses and resumes in every team", async () => {
    const r = await call(meRoute.PATCH, req(`/me/auto-assign`, P.a1.session, { paused: true }, "PATCH"));
    assert.equal(r.status, 200);
    assert.equal(r.body.paused, true);
    assert.ok(r.body.teams.length >= 3 && r.body.teams.every((t: any) => t.paused === 1));
    assert.ok((await audits("helpdesk.assignment.member_paused")).some((x) => x.actor_id === P.a1.id && x.details.self === true));
    assert.equal((await call(meRoute.PATCH, req(`/me/auto-assign`, P.a1.session, { paused: false }, "PATCH"))).body.paused, false);
    assert.equal((await call(meRoute.PATCH, req(`/me/auto-assign`, P.req.session, { paused: true }, "PATCH"))).status, 403);
  });

  test("rules: automations.manage only; create, update, reorder, delete, test; audited", async () => {
    assert.equal((await call(rulesRoute.GET, req(`/admin/assignment/rules`, P.lead.session))).status, 403);
    const body = {
      name: `API rule ${STAMP}`,
      scope_team_id: T.other,
      conditions: { match: "all", rules: [stampCond, { field: "text", op: "contains", value: ["scanner"] }] },
      action: { assign: "user", user_id: P.x.id },
    };
    const c = await call(rulesRoute.POST, req(`/admin/assignment/rules`, P.mgr.session, body));
    assert.equal(c.status, 201, JSON.stringify(c.body));
    ruleIds.push(c.body.rule.id);
    assert.equal((await call(rulesRoute.POST, req(`/admin/assignment/rules`, P.mgr.session, { ...body, action: { assign: "user", user_id: 2 ** 30 } }))).status, 400);
    const u = await call(ruleRoute.PATCH, req(`/x`, P.mgr.session, { stop: false }, "PATCH"), { id: String(c.body.rule.id) });
    assert.equal(u.status, 200);
    assert.equal(u.body.rule.stop, 0);
    const list = await call(rulesRoute.GET, req(`/admin/assignment/rules`, P.mgr.session));
    const ids = list.body.rules.map((r: any) => r.id);
    const re = await call(reorderRoute.POST, req(`/x`, P.mgr.session, { ids: [...ids].reverse() }));
    assert.equal(re.status, 200);
    assert.equal((await call(reorderRoute.POST, req(`/x`, P.mgr.session, { ids: ids.slice(1) }))).status, 400);
    const sample = await call(testRoute.POST, req(`/x`, P.mgr.session, { sample: { subject: `Scanner broken ${STAMP}`, team_id: T.other } }));
    assert.equal(sample.status, 200);
    assert.equal(sample.body.matched?.id, c.body.rule.id);
    assert.match(sample.body.outcome, /goes to Xan Outside/);
    const miss = await call(testRoute.POST, req(`/x`, P.mgr.session, { sample: { subject: `Mouse ${STAMP}`, team_id: T.other } }));
    assert.ok(miss.body.trace.some((t: any) => t.rule_id === c.body.rule.id && /Not true: Subject or first message contains any of scanner/.test(t.reason)));
    const del = await call(ruleRoute.DELETE, req(`/x`, P.mgr.session, undefined, "DELETE"), { id: String(c.body.rule.id) });
    assert.equal(del.status, 200);
    for (const a of ["rule_created", "rule_updated", "rules_reordered", "rule_deleted"]) {
      assert.ok((await audits(`helpdesk.assignment.${a}`)).length >= 1, a);
    }
  });

  test("on call: rotation, cover, who's on call now; members only; audited", async () => {
    const put = await call(
      onCallRoute.PUT,
      req(`/x`, P.mgr.session, { user_ids: [P.a1.id, P.a2.id, P.a3.id], length_days: 7, handover_time: "09:00", timezone: "Europe/London", starts_on: "2026-10-19" }, "PUT"),
      { teamId: String(T.infra) }
    );
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.strip.length, 28);
    assert.ok(put.body.now);
    assert.equal((await call(onCallRoute.PUT, req(`/x`, P.mgr.session, { user_ids: [P.x.id], starts_on: "2026-10-19" }, "PUT"), { teamId: String(T.infra) })).status, 400);
    const cover = await call(
      overridesRoute.POST,
      req(`/x`, P.mgr.session, { user_id: P.a3.id, starts_at: new Date(Date.now() - 60_000).toISOString(), ends_at: new Date(Date.now() + 3_600_000).toISOString() }),
      { teamId: String(T.infra) }
    );
    assert.equal(cover.status, 201);
    assert.equal(cover.body.now.user_id, P.a3.id);
    assert.equal(cover.body.now.source, "override");
    assert.ok((await audits("helpdesk.assignment.on_call_updated")).length >= 2);
    assert.equal((await call(onCallRoute.GET, req(`/x`, P.a1.session), { teamId: String(T.infra) })).status, 403);
  });

  test("assignment log: agents who can work the ticket; not requesters", async () => {
    const t = (await pool().query("SELECT id, number FROM hd_tickets WHERE team_id = $1 AND id IN (SELECT ticket_id FROM hd_assignment_log) LIMIT 1", [T.lb])).rows[0];
    const ok = await call(logRoute.GET, req(`/tickets/${t.number}/assignment-log`, P.b1.session), { number: String(t.number) });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.entries.length >= 1);
    assert.ok(ok.body.entries[0].method);
    assert.equal((await call(logRoute.GET, req(`/x`, P.x.session), { number: String(t.number) })).status, 404);
    assert.equal((await call(logRoute.GET, req(`/x`, P.req.session), { number: String(t.number) })).status, 403);
  });

  test("unlicensed: 402", async () => {
    edition.features = [];
    try {
      assert.equal((await call(rulesRoute.GET, req(`/admin/assignment/rules`, P.mgr.session))).status, 402);
      assert.equal((await call(teamRoute.GET, req(`/x`, P.mgr.session), { teamId: String(T.rr) })).status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });
});
