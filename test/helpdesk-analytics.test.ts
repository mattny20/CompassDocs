// Helpdesk 1.19.0 reports (agent K): the metrics engine, its scope, the
// dashboards, the schedules and the exports.
//
// Tickets, messages, approvals and workflow runs are inserted with exact
// timestamps (October 2026, Europe/London, which leaves summer time on
// Sunday 25 October), so every expected number below is worked out by hand
// in its test. The business hours are the engine's test hook (Mon–Fri
// 09:00–17:30, no holidays): no global setting is written.
//
// Parallel-safe: every team, account, ticket, workflow and dashboard is
// this file's own (STAMP); queries are filtered to this file's teams, and
// a team-scoped viewer only belongs to this file's teams.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-analytics.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next ----------------------------------------------

let currentRequest: Request | null = null;
function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-analytics.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-analytics.virtual.js");
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
  const orig = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return orig.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const engine = require("../src/lib/helpdesk/analytics/engine") as typeof import("../src/lib/helpdesk/analytics/engine");
const shared = require("../src/lib/helpdesk/analytics/shared") as typeof import("../src/lib/helpdesk/analytics/shared");
const hours = require("../src/lib/helpdesk/analytics/hours") as typeof import("../src/lib/helpdesk/analytics/hours");
const clock = require("../src/lib/helpdesk/analytics/business-time") as typeof import("../src/lib/helpdesk/analytics/business-time");
const store = require("../src/lib/helpdesk/analytics/store") as typeof import("../src/lib/helpdesk/analytics/store");
const builtins = require("../src/lib/helpdesk/analytics/builtins") as typeof import("../src/lib/helpdesk/analytics/builtins");
const stime = require("../src/lib/helpdesk/analytics/schedule-time") as typeof import("../src/lib/helpdesk/analytics/schedule-time");
const schedules = require("../src/lib/helpdesk/analytics/schedules") as typeof import("../src/lib/helpdesk/analytics/schedules");
const urlState = require("../src/lib/helpdesk/analytics/url-state") as typeof import("../src/lib/helpdesk/analytics/url-state");
const sla = require("../src/lib/helpdesk/sla") as typeof import("../src/lib/helpdesk/sla");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const queryRoute = require("../src/app/api/helpdesk/analytics/query/route") as typeof import("../src/app/api/helpdesk/analytics/query/route");
const dashRoute = require("../src/app/api/helpdesk/analytics/dashboards/route") as typeof import("../src/app/api/helpdesk/analytics/dashboards/route");
const dashIdRoute = require("../src/app/api/helpdesk/analytics/dashboards/[id]/route") as typeof import("../src/app/api/helpdesk/analytics/dashboards/[id]/route");
const dupRoute = require("../src/app/api/helpdesk/analytics/dashboards/[id]/duplicate/route") as typeof import("../src/app/api/helpdesk/analytics/dashboards/[id]/duplicate/route");
const exportRoute = require("../src/app/api/helpdesk/analytics/dashboards/[id]/export/route") as typeof import("../src/app/api/helpdesk/analytics/dashboards/[id]/export/route");
const schedRoute = require("../src/app/api/helpdesk/analytics/schedules/route") as typeof import("../src/app/api/helpdesk/analytics/schedules/route");
const optionsRoute = require("../src/app/api/helpdesk/analytics/options/route") as typeof import("../src/app/api/helpdesk/analytics/options/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdAnalyticsQuery, HdQueryResult } from "../src/lib/helpdesk/analytics/shared";
import type { HdBusinessHours } from "../src/lib/helpdesk/types";

type Handler = (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(h: Handler, req: Request, id?: number): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  currentRequest = req;
  try {
    const res = id === undefined ? await h(req) : await h(req, { params: Promise.resolve({ id: String(id) }) });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, text, headers: res.headers };
  } finally {
    currentRequest = null;
  }
}
function req(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`http://localhost/api/helpdesk/analytics${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------------

const STAMP = `hdan-${Date.now()}-${process.pid}`;
const HOURS: HdBusinessHours = { timezone: "Europe/London", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", holidays: [] };
const NOW = Date.parse("2026-11-06T12:00:00Z");
const OCT = { from: "2026-10-01", to: "2026-10-31" };

interface Person {
  id: number;
  session: string;
  name: string;
}
const P: Record<string, Person> = {};
let teamA = 0;
let teamB = 0;
let wfId = 0;
const userIds: number[] = [];
const ticketIds: number[] = [];
const dashboardIds: number[] = [];

async function person(key: string, name: string, role: string | null): Promise<Person> {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    `${STAMP}-${key}@example.test`,
  ]);
  const id = r.rows[0].id as number;
  if (role) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2)", [id, role]);
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  P[key] = { id, session, name };
  return P[key];
}

const z = (iso: string) => new Date(iso).toISOString();

interface T {
  team?: number;
  assignee?: number | null;
  requester?: number | null;
  created: string;
  status?: string;
  priority?: string;
  category?: string;
  tags?: string[];
  source?: string;
  first_replied_at?: string | null;
  solved_at?: string | null;
  first_reply_due?: string | null;
  resolve_due?: string | null;
  paused_ms?: number;
  paused_at?: string | null;
  csat?: number | null;
  csat_at?: string | null;
  parent?: number | null;
}

async function ticket(t: T): Promise<number> {
  const r = await pool().query(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, team_id, assignee_id, status, priority, category, tags, source,
        created_at, updated_at, first_replied_at, solved_at, first_reply_due, resolve_due, sla_paused_ms, sla_paused_at, csat_score, csat_at, parent_ticket_id)
     VALUES ($1, $2, 'Req', $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
    [
      `${STAMP} ticket`,
      t.requester ?? P.req.id,
      t.team ?? teamA,
      t.assignee ?? null,
      t.status ?? (t.solved_at ? "solved" : "open"),
      t.priority ?? "normal",
      t.category ?? "",
      t.tags ?? [],
      t.source ?? "portal",
      z(t.created),
      t.first_replied_at ? z(t.first_replied_at) : null,
      t.solved_at ? z(t.solved_at) : null,
      t.first_reply_due ? z(t.first_reply_due) : null,
      t.resolve_due ? z(t.resolve_due) : null,
      t.paused_ms ?? 0,
      t.paused_at ? z(t.paused_at) : null,
      t.csat ?? null,
      t.csat_at ? z(t.csat_at) : null,
      t.parent ?? null,
    ]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function message(ticketId: number, author: number | null, at: string, opts: { kind?: string; via?: string; body?: string; review?: string; reviewed_at?: string } = {}) {
  await pool().query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at, review_state, reviewed_at) VALUES ($1, $2, 'x', $3, $4, $5, $6, $7, $8)`,
    [ticketId, author, opts.kind ?? "public", opts.body ?? "Reply", opts.via ?? "desk", z(at), opts.review ?? null, opts.reviewed_at ? z(opts.reviewed_at) : null]
  );
}

const manager = () => ({ id: P.mgr.id, role: "viewer" as const });
const lead = () => ({ id: P.lead.id, role: "viewer" as const });
const agent = () => ({ id: P.agentA.id, role: "viewer" as const });
const mine = (): HdAnalyticsQuery["filters"] => ({ team: [teamA, teamB] });

async function q(viewer: { id: number; role: "viewer" }, query: Partial<HdAnalyticsQuery> & { measure: HdAnalyticsQuery["measure"] }): Promise<HdQueryResult> {
  return engine.runQuery({ range: OCT, filters: mine(), ...query } as HdAnalyticsQuery, viewer, { now: NOW });
}

// The ticket ids worked out in the fixtures, by role.
const F: Record<string, number> = {};

before(async () => {
  await getSetting("__schema_bootstrap__");
  await store.ensureAnalyticsSchema();
  hours.setReportHoursForTests(HOURS);
  await person("mgr", "Mina Manager", "manager");
  await person("lead", "Lee Lead", "team_lead");
  await person("agentA", "Ada Agent", "agent");
  await person("agentB", "Bo Agent", "agent");
  await person("newbie", "Nia Newbie", "newbie");
  await person("req", "Rae Requester", null);
  await person("none", "Ned Nobody", null);
  teamA = (await pool().query("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} A`])).rows[0].id;
  teamB = (await pool().query("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} B`])).rows[0].id;
  for (const [t, u, r] of [
    [teamA, P.lead.id, "lead"],
    [teamA, P.agentA.id, "agent"],
    [teamA, P.newbie.id, "agent"],
    [teamB, P.agentB.id, "agent"],
  ] as const) {
    await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3)", [t, u, r]);
  }

  // Team A, October (London, BST = UTC+1 until 25 October).
  // a1: Fri 2 Oct 16:30 BST → first reply Mon 5 Oct 09:30 BST = 60 + 30 = 90 business minutes.
  F.a1 = await ticket({
    assignee: P.agentA.id,
    created: "2026-10-02T15:30:00Z",
    first_replied_at: "2026-10-05T08:30:00Z",
    first_reply_due: "2026-10-05T08:00:00Z", // missed (replied 08:30)
    solved_at: "2026-10-06T09:00:00Z", // Tue 10:00 BST: Fri 60 + Mon 510 + Tue 60 = 630
    resolve_due: "2026-10-07T09:00:00Z", // met
    priority: "high",
    tags: ["vpn", "network"],
    csat: 5,
    csat_at: "2026-10-06T12:00:00Z",
  });
  // a2: Mon 5 Oct 10:00 → reply 10:20 = 20; solved 12:00 with 60 of its 120 minutes paused → 120 × 0.5 = 60.
  F.a2 = await ticket({
    assignee: P.agentA.id,
    created: "2026-10-05T09:00:00Z",
    first_replied_at: "2026-10-05T09:20:00Z",
    first_reply_due: "2026-10-05T10:00:00Z", // met
    solved_at: "2026-10-05T11:00:00Z",
    paused_ms: 60 * 60_000,
    tags: ["vpn"],
    csat: 2,
    csat_at: "2026-10-05T12:00:00Z",
  });
  // a3: Mon 5 Oct 08:00 BST (before opening) → reply 09:45 = 45; unassigned, still open; resolve target past due → breach.
  F.a3 = await ticket({
    assignee: null,
    created: "2026-10-05T07:00:00Z",
    first_replied_at: "2026-10-05T08:45:00Z",
    resolve_due: "2026-10-09T16:00:00Z",
    priority: "urgent",
    category: "Hardware",
  });
  // a4: 00:30 BST on Fri 2 Oct is still Thursday 1 Oct in UTC: it belongs to 2 October.
  F.a4 = await ticket({ assignee: P.lead.id, created: "2026-10-01T23:30:00Z", source: "email", status: "pending", paused_at: "2026-10-02T09:00:00Z" });
  // Team B: one ticket, so a team-scoped viewer of A must never count it.
  F.b1 = await ticket({ team: teamB, assignee: P.agentB.id, created: "2026-10-05T10:00:00Z", solved_at: "2026-10-05T14:00:00Z", source: "desk", csat: 4, csat_at: "2026-10-05T15:00:00Z" });
  // September: the comparison period for previous_period (1–30 Sep) holds two of team A's.
  F.s1 = await ticket({ assignee: P.agentA.id, created: "2026-09-10T10:00:00Z" });
  F.s2 = await ticket({ assignee: P.agentA.id, created: "2026-09-20T10:00:00Z", solved_at: "2026-09-21T10:00:00Z" });

  // Replies: a1 got two agent replies, a2 one (one-touch), b1 one; plus requester messages that never count.
  await message(F.a1, P.agentA.id, "2026-10-05T08:30:00Z");
  await message(F.a1, P.req.id, "2026-10-05T09:00:00Z", { via: "portal" });
  await message(F.a1, P.agentA.id, "2026-10-06T08:00:00Z");
  await message(F.a1, P.agentA.id, "2026-10-06T08:10:00Z", { kind: "internal", body: "secret internal note" });
  await message(F.a2, P.agentA.id, "2026-10-05T09:20:00Z");
  await message(F.b1, P.agentB.id, "2026-10-05T11:00:00Z");
  // A newbie's reply held for review, then returned: never sent, so it is not a reply.
  await message(F.a2, P.newbie.id, "2026-10-05T09:10:00Z", { review: "returned", reviewed_at: "2026-10-05T09:30:00Z" });
  await message(F.a1, P.newbie.id, "2026-10-05T09:40:00Z", { review: "approved", reviewed_at: "2026-10-05T10:00:00Z" });
  // a1 was reopened once (and solved again), on 7 October.
  await message(F.a1, P.req.id, "2026-10-07T10:00:00Z", { kind: "system", via: "system", body: "Rae Requester changed the status from Solved to Open" });

  // A workflow: a run on a2 started 1 Oct 09:00 BST, finished 2 Oct 09:00 BST (24h calendar).
  wfId = (await pool().query(
    `INSERT INTO hd_workflows (slug, title, definition) VALUES ($1, $2, $3) RETURNING id`,
    [`${STAMP}-wf`, `${STAMP} Onboarding`, JSON.stringify({ trigger: {}, steps: [{ key: "t1", kind: "task", title: "Laptop", team_id: teamA }] })]
  )).rows[0].id;
  const run = (await pool().query(
    `INSERT INTO hd_workflow_runs (workflow_id, ticket_id, state, started_at, finished_at) VALUES ($1, $2, 'done', $3, $4) RETURNING id`,
    [wfId, F.a2, z("2026-10-01T08:00:00Z"), z("2026-10-02T08:00:00Z")]
  )).rows[0].id;
  // The task: started with team B Thu 1 Oct 10:00 BST, handed to team A at 15:00 BST, done Fri 2 Oct 11:00 BST.
  // Team B held it 5h = 300 business minutes; team A 15:00–17:30 + 09:00–11:00 = 150 + 120 = 270.
  const task = await ticket({ team: teamA, assignee: P.agentA.id, created: "2026-10-01T09:00:00Z", source: "workflow", parent: F.a2, solved_at: "2026-10-02T10:00:00Z" });
  F.task = task;
  const step = (await pool().query(
    `INSERT INTO hd_workflow_steps (run_id, step_key, kind, state, task_ticket_id, started_at, finished_at, result) VALUES ($1, 't1', 'task', 'done', $2, $3, $4, $5) RETURNING id`,
    [
      run,
      task,
      z("2026-10-01T09:00:00Z"),
      z("2026-10-02T10:00:00Z"),
      JSON.stringify({ team_id: teamA, started_team_id: teamB, outcome: "done", transfers: [{ from_team_id: teamB, to_team_id: teamA, at: "2026-10-01T14:00:00Z" }] }),
    ]
  )).rows[0].id;
  // An approval asked 1 Oct 09:00 BST, approved 1 Oct 11:30 BST: 150 calendar minutes. Another still pending.
  await pool().query(
    `INSERT INTO hd_approvals (run_id, step_id, ticket_id, approver_kind, decision, created_at, decided_at) VALUES ($1, $2, $3, 'user', 'approved', $4, $5), ($1, $2, $3, 'user', 'pending', $4, NULL)`,
    [run, step, F.a2, z("2026-10-01T08:00:00Z"), z("2026-10-01T10:30:00Z")]
  );
  // The pending one belongs to a finished run, so it is not waiting on anyone: none is pending.
});

after(async () => {
  hours.setReportHoursForTests(null);
  email.setHelpdeskTransportForTests(null);
  await pool().query("DELETE FROM hd_dashboards WHERE id = ANY($1) OR owner_id = ANY($2)", [dashboardIds, userIds]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE workflow_id = $1", [wfId]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ticketIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = $1", [wfId]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[teamA, teamB]]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]).catch(() => {});
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Pure parts ----------------------------------------------------------------------------

describe("business time", () => {
  test("the memoised clock agrees with sla.businessMinutesBetween (DST, holidays, weekends)", () => {
    const h: HdBusinessHours = { ...HOURS, holidays: ["2026-10-26", "2026-12-25"] };
    const c = new clock.BusinessClock(h);
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const base = Date.parse("2026-10-15T00:00:00Z");
    for (let i = 0; i < 400; i++) {
      const a = base + Math.floor(rnd() * 30 * 86_400_000);
      const b = a + Math.floor(rnd() * 12 * 86_400_000);
      assert.equal(Math.round(c.minutesBetween(a, b) * 1000), Math.round(sla.businessMinutesBetween(a, b, h) * 1000), `${new Date(a).toISOString()} → ${new Date(b).toISOString()}`);
    }
    // Over the clocks going back (Sun 25 Oct): Fri 23 Oct 17:00 BST → Mon 26 Oct (holiday) → Tue 27 Oct 09:30 GMT = 30 + 30.
    assert.equal(c.minutesBetween(Date.parse("2026-10-23T16:00:00Z"), Date.parse("2026-10-27T09:30:00Z")), 60);
  });

  test("presets and comparisons are calendar arithmetic in the zone", () => {
    assert.deepEqual(shared.presetDates("last_7", "2026-11-06"), { from: "2026-10-31", to: "2026-11-06" });
    assert.deepEqual(shared.presetDates("last_month", "2026-03-15"), { from: "2026-02-01", to: "2026-02-28" });
    assert.deepEqual(shared.presetDates("this_week", "2026-11-06"), { from: "2026-11-02", to: "2026-11-06" });
    assert.deepEqual(shared.compareDates(OCT, "previous_period"), { from: "2026-08-31", to: "2026-09-30" });
    assert.deepEqual(shared.compareDates({ from: "2028-02-29", to: "2028-03-01" }, "previous_year"), { from: "2027-02-28", to: "2027-03-01" });
  });

  test("the view in the address round-trips over the dashboard's defaults", () => {
    const d = urlState.defaultState({ filters: { team: [3] }, range: { preset: "last_30" }, compare: "previous_period", automated: false });
    const v = { ...d, range: { from: "2026-10-01", to: "2026-10-31" }, compare: null, filters: { team: [3], tag: ["a,b", "c"] }, automated: true };
    const p = urlState.stateToParams(v, d);
    assert.equal(p.get("range"), null);
    assert.equal(p.get("cmp"), "none");
    assert.deepEqual(urlState.stateFromParams(p, d), v);
    // Junk is ignored, never fatal.
    assert.deepEqual(urlState.stateFromParams(new URLSearchParams("range=forever&team=x;drop&cmp=1"), d), d);
  });
});

describe("whitelists", () => {
  test("parseQuery refuses anything outside the registry", () => {
    for (const bad of [
      { measure: "created; DROP TABLE hd_tickets" },
      { measure: "created", groupBy: ["team", "assignee", "priority"] },
      { measure: "created", groupBy: ["t.requester_email"] },
      { measure: "created", filters: { "team_id = 1 OR 1=1 --": [1] } },
      { measure: "created", filters: { team: ["1 OR 1=1"] } },
      { measure: "created", filters: { priority: ["high'"] } },
      { measure: "open_now", groupBy: ["day"] },
      { measure: "created", groupBy: ["day", "week"] },
      { measure: "created", range: { from: "2026-10-31", to: "2026-10-01" }, limit: 0 },
    ]) {
      assert.equal(shared.parseQuery(bad).ok, false, JSON.stringify(bad));
    }
    assert.equal(shared.parseQuery({ measure: "created", groupBy: ["weekday", "hour"] }).ok, true);
  });

  test("a hostile tag is a bound value: no match, no error", async () => {
    const r = await q(manager(), { measure: "created", filters: { team: [teamA], tag: ["x' OR '1'='1"] } });
    assert.equal(r.total.value, 0);
  });

  test("every built-in widget is valid and the seed is idempotent", async () => {
    for (const b of builtins.HD_BUILTIN_DASHBOARDS) {
      const parsed = shared.parseLayout(b.layout);
      assert.ok(parsed.ok, `${b.key}: ${!parsed.ok ? parsed.error : ""}`);
    }
    await store.seedBuiltinDashboards(true);
    await store.seedBuiltinDashboards(true);
    const rows = (await pool().query("SELECT builtin, count(*)::int AS n FROM hd_dashboards WHERE builtin IS NOT NULL GROUP BY builtin")).rows;
    assert.equal(rows.length, builtins.HD_BUILTIN_DASHBOARDS.length);
    assert.ok(rows.every((r) => r.n === 1));
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_dashboards WHERE is_default = 1")).rows[0].n, 1);
  });
});

// --- Measures ------------------------------------------------------------------------------

describe("measures (hand-computed, team A + B, October 2026)", () => {
  test("volume: created, solved, reopened, the day boundary in London", async () => {
    // Created in October: a1 a2 a3 a4 b1 + the workflow task (1 Oct) = 6.
    assert.equal((await q(manager(), { measure: "created" })).total.value, 6);
    assert.equal((await q(manager(), { measure: "solved" })).total.value, 4); // a1 a2 b1 task
    assert.equal((await q(manager(), { measure: "reopened" })).total.value, 1);
    // a4 was created at 23:30 UTC on 1 October, which is 2 October in London.
    const oct2 = await q(manager(), { measure: "created", range: { from: "2026-10-02", to: "2026-10-02" } });
    assert.equal(oct2.total.value, 2); // a1 (16:30 BST) and a4 (00:30 BST)
    const byDay = await q(manager(), { measure: "created", groupBy: ["day"] });
    assert.equal(byDay.rows.length, 31, "every day is there, zero-filled");
    assert.equal(byDay.rows.find((r) => r.keys[0] === "2026-10-01")!.value, 1); // the task only
    assert.equal(byDay.rows.find((r) => r.keys[0] === "2026-10-05")!.value, 3);
  });

  test("backlog and unassigned at the end of the period", async () => {
    // Open at 1 Nov 00:00: a3, a4 and September's s1 (a1, a2, b1 and the task are solved).
    assert.equal((await q(manager(), { measure: "backlog" })).total.value, 3);
    assert.equal((await q(manager(), { measure: "unassigned" })).total.value, 1); // a3 (s1 is Ada's)
    const daily = await q(manager(), { measure: "backlog", groupBy: ["day"], range: { from: "2026-10-04", to: "2026-10-06" } });
    // 4 Oct: s1 a1 a4 task? (task solved 2 Oct) → s1 a1 a4 = 3. 5 Oct end: s1 a1 a3 a4 = 4 (a2 and b1 solved that day). 6 Oct: s1 a3 a4 = 3.
    assert.deepEqual(daily.rows.map((r) => r.value), [3, 4, 3]);
  });

  test("first reply time in business hours: median and 90th percentile", async () => {
    // a1 90, a2 20, a3 45 (b1 had no first_replied_at) → median 45, p90 (nearest rank) 90.
    const m = await q(manager(), { measure: "first_reply_median" });
    assert.equal(m.total.value, 45);
    assert.equal(m.total.n, 3);
    assert.equal((await q(manager(), { measure: "first_reply_p90" })).total.value, 90);
  });

  test("resolution time, less the time paused", async () => {
    // a1 630, a2 60, b1 240 (11:00–15:00 BST), the task Thu 1 Oct 10:00 BST → Fri 2 Oct 11:00 BST = 450 + 120 = 570.
    // Sorted 60, 240, 570, 630 → median (240 + 570) / 2 = 405.
    assert.equal((await q(manager(), { measure: "resolution_median" })).total.value, 405);
  });

  test("SLA attainment and breaches", async () => {
    // First reply targets due in October and decided: a1 (missed), a2 (met) → 50%.
    assert.equal((await q(manager(), { measure: "sla_first_reply_pct" })).total.value, 50);
    // Resolution targets: a1 met, a3 missed (still open, past due) → 50%.
    assert.equal((await q(manager(), { measure: "sla_resolution_pct" })).total.value, 50);
    // Breaches: a1's first reply and a3's resolution.
    const br = await q(manager(), { measure: "sla_breaches", groupBy: ["priority"] });
    assert.equal(br.total.value, 2);
    assert.deepEqual(Object.fromEntries(br.rows.map((r) => [r.keys[0], r.value])), { high: 1, urgent: 1 });
  });

  test("satisfaction: score, ratings, response rate", async () => {
    // Ratings in October: a1 5, a2 2, b1 4 → 2 of 3 good = 66.7%.
    const c = await q(manager(), { measure: "csat_pct" });
    assert.equal(c.total.value, 66.7);
    assert.equal(c.low_sample, true);
    assert.equal((await q(manager(), { measure: "csat_responses" })).total.value, 3);
    // Requests solved in October (not workflow tasks): a1 a2 b1, all rated → 100%.
    assert.equal((await q(manager(), { measure: "csat_response_rate" })).total.value, 100);
  });

  test("replies per ticket and one-touch resolution count only sent agent replies", async () => {
    // Solved: a1 3 (two of Ada's + the newbie's approved one), a2 1 (the returned one never went), b1 1, task 0 → 5 / 4 = 1.25.
    assert.equal((await q(manager(), { measure: "replies_per_ticket" })).total.value, 1.25);
    // One-touch among those with a reply: a2 and b1 of a1, a2, b1 → 66.7%.
    assert.equal((await q(manager(), { measure: "one_touch_pct" })).total.value, 66.7);
  });

  test("workflows and approvals", async () => {
    const wf = { team: [teamA, teamB], workflow: [wfId] };
    assert.equal((await q(manager(), { measure: "workflow_started", filters: wf })).total.value, 1);
    assert.equal((await q(manager(), { measure: "workflow_finished", filters: wf })).total.value, 1);
    assert.equal((await q(manager(), { measure: "workflow_duration_median", filters: wf })).total.value, 24 * 60);
    assert.equal((await q(manager(), { measure: "approval_decision_median", filters: wf })).total.value, 150);
    assert.equal((await q(manager(), { measure: "approvals_pending", filters: wf })).total.value, 0);
    // Time by team: B held the task 300 business minutes, A 270, each in its own calendar.
    const byTeam = await q(manager(), { measure: "workflow_team_time_median", groupBy: ["team"], filters: wf });
    assert.deepEqual(Object.fromEntries(byTeam.rows.map((r) => [r.keys[0], r.value])), { [teamA]: 270, [teamB]: 300 });
    const byStep = await q(manager(), { measure: "workflow_team_time_median", groupBy: ["workflow_step", "team"], filters: wf });
    assert.ok(byStep.rows.every((r) => r.labels[0] === `${STAMP} Onboarding · Laptop`));
    assert.equal((await q(manager(), { measure: "task_cant_do_pct", filters: wf })).total.value, 0);
    assert.equal((await q(manager(), { measure: "steps_skipped", filters: wf })).total.value, 0);
  });

  test("live tiles: open now, unassigned now, breaching now, workload", async () => {
    assert.equal((await q(manager(), { measure: "open_now" })).total.value, 3); // a3 a4 s1
    assert.equal((await q(manager(), { measure: "unassigned_now" })).total.value, 1); // a3
    // a3 is past its resolution target; a4 is paused (pending), s1 has no targets.
    assert.equal((await q(manager(), { measure: "breaching_now" })).total.value, 1);
    const load = await q(manager(), { measure: "agent_workload", groupBy: ["assignee"] });
    assert.deepEqual(Object.fromEntries(load.rows.map((r) => [r.labels[0], r.value])), { "Lee Lead": 1, "Ada Agent": 1 });
  });

  test("newbie review measures", async () => {
    assert.equal((await q(manager(), { measure: "reviews_done" })).total.value, 2);
    assert.equal((await q(manager(), { measure: "reviews_returned" })).total.value, 1);
  });

  test("splits: tags count a ticket under each tag; channels fold the page triggers", async () => {
    const tags = await q(manager(), { measure: "created", groupBy: ["tag"] });
    const by = Object.fromEntries(tags.rows.map((r) => [r.labels[0], r.value]));
    assert.equal(by.vpn, 2);
    assert.equal(by.network, 1);
    assert.equal(tags.total.value, 6, "the total is still tickets, not tag rows");
    const ch = await q(manager(), { measure: "created", groupBy: ["channel"] });
    assert.deepEqual(Object.fromEntries(ch.rows.map((r) => [r.keys[0], r.value])), { portal: 3, email: 1, desk: 1, workflow: 1 });
    // VIP is today's list (agent O's contact cards); nobody here is one.
    assert.equal((await q(manager(), { measure: "created", filters: { team: [teamA, teamB], vip: ["no"] } })).total.value, 6);
    assert.equal((await q(manager(), { measure: "created", filters: { team: [teamA, teamB], vip: ["yes"] } })).total.value, 0);
    const vip = await q(manager(), { measure: "created", groupBy: ["vip"] });
    assert.deepEqual(vip.rows.map((r) => [r.keys[0], r.labels[0], r.value]), [["no", "Not a VIP", 6]]);
  });

  test("comparison with the previous period", async () => {
    const r = await q(manager(), { measure: "created", compare: "previous_period" });
    assert.equal(r.compare!.total.value, 2); // s1 s2 (31 Aug–30 Sep)
    assert.equal(r.compare!.delta, 4);
    assert.equal(r.compare!.delta_pct, 200);
    const series = await q(manager(), { measure: "created", groupBy: ["week"], compare: "previous_period" });
    assert.ok(series.compare!.rows!.length >= 4);
  });

  test("automated tickets (alerts, API) count only when asked, and never in satisfaction", async () => {
    const id = await ticket({ assignee: P.agentA.id, created: "2026-10-12T10:00:00Z", source: "alert", solved_at: "2026-10-12T11:00:00Z", csat: 1, csat_at: "2026-10-12T12:00:00Z" });
    await pool().query("UPDATE hd_tickets SET automated = 1 WHERE id = $1", [id]);
    try {
      assert.equal((await q(manager(), { measure: "created" })).total.value, 6, "people-raised by default");
      assert.equal((await q(manager(), { measure: "created", automated: true })).total.value, 7);
      const origin = await q(manager(), { measure: "created", groupBy: ["origin"] });
      assert.deepEqual(Object.fromEntries(origin.rows.map((r) => [r.keys[0], r.value])), { people: 6, automated: 1 });
      assert.equal((await q(manager(), { measure: "csat_pct", automated: true })).total.value, 66.7, "its rating of 1 never counts");
      assert.equal(shared.dimensionsFor("csat_pct").includes("origin"), false);
      const ch = await q(manager(), { measure: "created", groupBy: ["channel"], automated: true });
      assert.equal(ch.rows.find((r) => r.keys[0] === "alert")?.value, 1);
    } finally {
      await pool().query("DELETE FROM hd_tickets WHERE id = $1", [id]);
    }
  });

  test("customer portal tickets are their own channel, as a split and a filter", async () => {
    const id = await ticket({ assignee: P.agentA.id, created: "2026-10-13T10:00:00Z", source: "portal_external" as never });
    try {
      assert.ok((shared.HD_CHANNELS as readonly string[]).includes("portal_external"));
      assert.equal(shared.HD_CHANNEL_LABEL.portal_external, "Customer portal");
      const ch = await q(manager(), { measure: "created", groupBy: ["channel"] });
      const row = ch.rows.find((r) => r.keys[0] === "portal_external");
      assert.equal(row?.value, 1);
      assert.equal(row?.labels[0], "Customer portal");
      assert.equal(ch.rows.find((r) => r.keys[0] === "portal")?.value, 3, "Get help is still its own channel");
      assert.equal((await q(manager(), { measure: "created", filters: { channel: ["portal_external"] } })).total.value, 1);
      assert.deepEqual(shared.parseFilters({ channel: ["portal_external"] }), { ok: true, value: { channel: ["portal_external"] } });
    } finally {
      await pool().query("DELETE FROM hd_tickets WHERE id = $1", [id]);
    }
  });

  test("heatmap: day of the week by hour, in local time", async () => {
    const h = await q(manager(), { measure: "created", groupBy: ["weekday", "hour"] });
    assert.equal(h.rows.length, 7 * 24);
    // a1 Friday 16:30 BST; a4 Friday 00:30 BST.
    assert.equal(h.rows.find((r) => r.keys[0] === 5 && r.keys[1] === 16)!.value, 1);
    assert.equal(h.rows.find((r) => r.keys[0] === 5 && r.keys[1] === 0)!.value, 1);
  });
});

// --- Scope -------------------------------------------------------------------------------------

describe("scope is SQL", () => {
  test("a team lead sees their teams only, whatever the filters or the split", async () => {
    const all = await q(lead(), { measure: "created" });
    assert.equal(all.total.value, 5, "team A's five (a1 a2 a3 a4 task), never b1");
    const onlyB = await q(lead(), { measure: "created", filters: { team: [teamB] } });
    assert.equal(onlyB.total.value, 0);
    const split = await q(lead(), { measure: "created", groupBy: ["team"] });
    assert.deepEqual(split.rows.map((r) => r.keys[0]), [teamA]);
    const byAgent = await q(lead(), { measure: "solved", groupBy: ["assignee"] });
    assert.ok(!byAgent.rows.some((r) => r.keys[0] === P.agentB.id));
  });

  test("an agent with reports.own sees only tickets assigned to them", async () => {
    const r = await q(agent(), { measure: "created" });
    assert.equal(r.total.value, 3); // a1 a2 task
    const s = await engine.reportScope(agent());
    assert.deepEqual(s, { kind: "own", userId: P.agentA.id });
  });

  test("no report capability: no scope, and the API answers 403", async () => {
    assert.equal(await engine.reportScope({ id: P.none.id, role: "viewer" }), null);
    const res = await call(queryRoute.POST as Handler, req("/query", P.none.session, { measure: "created", range: OCT }));
    assert.equal(res.status, 403);
  });

  test("the licence gate answers 402", async () => {
    edition.features = [];
    try {
      const res = await call(queryRoute.POST as Handler, req("/query", P.mgr.session, { measure: "created", range: OCT }));
      assert.equal(res.status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });

  test("the query route returns the viewer's numbers, and CSV needs tickets.export", async () => {
    const ok = await call(queryRoute.POST as Handler, req("/query", P.lead.session, { measure: "created", range: OCT, filters: { team: [teamA, teamB] } }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.result.total.value, 5);
    const csvLead = await call(queryRoute.POST as Handler, req("/query", P.lead.session, { measure: "created", range: OCT, format: "csv" }));
    assert.equal(csvLead.status, 403);
    const csv = await call(queryRoute.POST as Handler, req("/query", P.mgr.session, { measure: "created", groupBy: ["team"], range: OCT, filters: { team: [teamA, teamB] }, format: "csv", title: "By team" }));
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(csv.text, new RegExp(`"${STAMP} A",5,5`));
    assert.match(csv.text, /"Total",6,6/);
    assert.doesNotMatch(csv.text, /secret internal note/);
    const audit = await pool().query("SELECT details FROM audit_log WHERE actor_id = $1 AND action = 'helpdesk.report.exported' ORDER BY id DESC LIMIT 1", [P.mgr.id]);
    assert.equal(audit.rows[0]?.details?.measure, "created");
  });

  test("options offer the viewer's own teams", async () => {
    const r = await call(optionsRoute.GET as Handler, req("/options", P.lead.session));
    assert.equal(r.status, 200);
    const ids = r.body.teams.map((t: { id: number }) => t.id);
    assert.ok(ids.includes(teamA) && !ids.includes(teamB));
    assert.equal(r.body.can.export, false);
  });
});

// --- Dashboards ------------------------------------------------------------------------------------

describe("dashboards", () => {
  const layout = { widgets: [{ type: "kpi", title: "Created", measure: "created", groupBy: [], filters: {}, size: 1 }], filters: { team: [0] }, range: { preset: "last_30" }, compare: null };

  test("create, see, share, edit and delete under the rules", async () => {
    const l = { ...layout, filters: { team: [teamA] } };
    const made = await call(dashRoute.POST as Handler, req("/dashboards", P.agentA.session, { name: `${STAMP} Mine`, layout: l }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.dashboard.id as number;
    dashboardIds.push(id);
    assert.equal(made.body.dashboard.visibility, "private");
    // The lead can't see a private one.
    assert.equal((await call(dashIdRoute.GET as Handler, req(`/dashboards/${id}`, P.lead.session), id)).status, 404);
    // Agents can't share with everyone (no reports.team); they can share with their team.
    assert.equal((await call(dashIdRoute.PATCH as Handler, req(`/dashboards/${id}`, P.agentA.session, { visibility: "everyone" }, "PATCH"), id)).status, 403);
    assert.equal((await call(dashIdRoute.PATCH as Handler, req(`/dashboards/${id}`, P.agentA.session, { visibility: "team", team_id: teamB }, "PATCH"), id)).status, 403);
    const shared = await call(dashIdRoute.PATCH as Handler, req(`/dashboards/${id}`, P.agentA.session, { visibility: "team", team_id: teamA }, "PATCH"), id);
    assert.equal(shared.status, 200);
    const seen = await call(dashIdRoute.GET as Handler, req(`/dashboards/${id}`, P.lead.session), id);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.dashboard.can_edit, false, "a team lead is not a Manager");
    assert.equal((await call(dashIdRoute.PATCH as Handler, req(`/dashboards/${id}`, P.lead.session, { name: "Taken" }, "PATCH"), id)).status, 403);
    assert.equal((await call(dashIdRoute.GET as Handler, req(`/dashboards/${id}`, P.agentB.session), id)).status, 404);
    // A Manager (reports.all) may edit a shared one.
    const renamed = await call(dashIdRoute.PATCH as Handler, req(`/dashboards/${id}`, P.mgr.session, { name: `${STAMP} Renamed` }, "PATCH"), id);
    assert.equal(renamed.status, 200);
    // A bad widget is refused with a sentence.
    const bad = await call(dashIdRoute.PATCH as Handler, req(`/dashboards/${id}`, P.agentA.session, { layout: { widgets: [{ type: "line", measure: "created", groupBy: [], size: 2 }] } }, "PATCH"), id);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /over time/);
    const del = await call(dashIdRoute.DELETE as Handler, req(`/dashboards/${id}`, P.agentA.session, undefined, "DELETE"), id);
    assert.equal(del.status, 200);
    const actions = (await pool().query("SELECT action FROM audit_log WHERE target_type = 'helpdesk_dashboard' AND target_id = $1 ORDER BY id", [String(id)])).rows.map((r) => r.action);
    assert.deepEqual(actions, ["helpdesk.dashboard.created", "helpdesk.dashboard.updated", "helpdesk.dashboard.updated", "helpdesk.dashboard.deleted"]);
  });

  test("built-ins are read-only and duplicate into a private copy", async () => {
    const list = await call(dashRoute.GET as Handler, req("/dashboards", P.agentA.session));
    const overview = list.body.dashboards.find((d: { builtin: string }) => d.builtin === "overview");
    assert.ok(overview);
    assert.equal(overview.can_edit, false);
    assert.equal((await call(dashIdRoute.PATCH as Handler, req(`/dashboards/${overview.id}`, P.mgr.session, { name: "Mine now" }, "PATCH"), overview.id)).status, 403);
    assert.equal((await call(dashIdRoute.DELETE as Handler, req(`/dashboards/${overview.id}`, P.mgr.session, undefined, "DELETE"), overview.id)).status, 403);
    const dup = await call(dupRoute.POST as Handler, req(`/dashboards/${overview.id}/duplicate`, P.agentA.session, {}), overview.id);
    assert.equal(dup.status, 201);
    dashboardIds.push(dup.body.dashboard.id);
    assert.equal(dup.body.dashboard.name, "Overview (copy)");
    assert.equal(dup.body.dashboard.can_edit, true);
    assert.equal(dup.body.dashboard.layout.widgets.length, overview.layout.widgets.length);
  });

  test("the dashboard export: CSV in the viewer's scope, audited; PDF renders; no export capability is 403", async () => {
    const d = await store.createDashboard(manager(), {
      name: `${STAMP} Export`,
      layout: {
        widgets: [
          { type: "kpi", title: "Created", measure: "created", groupBy: [], filters: {}, size: 1 },
          { type: "bar", title: "By team", measure: "created", groupBy: ["team"], filters: {}, size: 2 },
        ],
        filters: { team: [teamA, teamB] },
        range: { from: OCT.from, to: OCT.to },
        compare: "previous_period",
      },
    });
    dashboardIds.push(d.id);
    const csv = await call(exportRoute.GET as Handler, req(`/dashboards/${d.id}/export?format=csv`, P.mgr.session), d.id);
    assert.equal(csv.status, 200);
    assert.match(csv.text, /"Dashboard",".*Export"/);
    assert.match(csv.text, /"Created","2026-10-01","2026-10-31",6,6,2,4,200/);
    assert.match(csv.text, new RegExp(`"${STAMP} B",1,1`));
    // @react-pdf/renderer is ESM-only and node:test loads this file as CommonJS, so the PDF itself is
    // checked where it can load (the PDF smoke script in the report); here the route and its audit.
    let pdfLoads = true;
    try {
      require("@react-pdf/renderer");
    } catch {
      pdfLoads = false;
    }
    const pdf = await call(exportRoute.GET as Handler, req(`/dashboards/${d.id}/export?format=pdf&team=${teamA}`, P.mgr.session), d.id);
    if (pdfLoads) {
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get("content-type"), "application/pdf");
    }
    const audits = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.report.exported' AND target_type = 'helpdesk_dashboard' AND target_id = $1 ORDER BY id", [String(d.id)]);
    // Audited once the file exists.
    assert.deepEqual(audits.rows.map((r) => r.details.format), pdfLoads ? ["csv", "pdf"] : ["csv"]);
    if (pdfLoads) assert.deepEqual(audits.rows[1].details.filters.team, [teamA]);
    // Shared with everyone, the lead may open it, but not export it.
    await store.updateDashboard(d.id, manager(), { visibility: "everyone" });
    assert.equal((await call(exportRoute.GET as Handler, req(`/dashboards/${d.id}/export?format=csv`, P.lead.session), d.id)).status, 403);
  });
});

// --- Schedules ------------------------------------------------------------------------------------

describe("schedules", () => {
  test("due times: weekly Monday 08:00 London across the clock change", () => {
    const s = { frequency: "weekly" as const, weekday: 1, hour: 8 };
    const tz = "Europe/London";
    // Wed 28 Oct 2026 (GMT): the latest slot is Mon 26 Oct 08:00 GMT, the next Mon 2 Nov 08:00 GMT.
    const now = Date.parse("2026-10-28T12:00:00Z");
    assert.equal(new Date(stime.latestSlot(s, tz, now)).toISOString(), "2026-10-26T08:00:00.000Z");
    assert.equal(new Date(stime.nextSlot(s, tz, now)).toISOString(), "2026-11-02T08:00:00.000Z");
    // Mon 19 Oct (BST): 08:00 BST is 07:00 UTC.
    assert.equal(new Date(stime.latestSlot(s, tz, Date.parse("2026-10-19T07:30:00Z"))).toISOString(), "2026-10-19T07:00:00.000Z");
    assert.equal(new Date(stime.latestSlot(s, tz, Date.parse("2026-10-19T06:59:00Z"))).toISOString(), "2026-10-12T07:00:00.000Z");
    const row = { ...s, enabled: 1, created_at: "2026-10-20T00:00:00Z", last_sent_at: null };
    assert.equal(stime.isDue(row, tz, now), true);
    assert.equal(stime.isDue({ ...row, last_sent_at: "2026-10-26T08:00:05Z" }, tz, now), false);
    assert.deepEqual(stime.digestPeriod(s, tz, Date.parse("2026-10-26T08:00:00Z")), { from: "2026-10-19", to: "2026-10-25" });
    const m = { frequency: "monthly" as const, weekday: 1, hour: 7 };
    assert.equal(new Date(stime.latestSlot(m, tz, Date.parse("2026-11-01T06:30:00Z"))).toISOString(), "2026-10-01T06:00:00.000Z");
    assert.deepEqual(stime.digestPeriod(m, tz, Date.parse("2026-11-01T07:00:00Z")), { from: "2026-10-01", to: "2026-10-31" });
    const d = { frequency: "daily" as const, weekday: 1, hour: 23 };
    assert.equal(new Date(stime.nextSlot(d, tz, Date.parse("2026-10-24T23:30:00Z"))).toISOString(), "2026-10-25T23:00:00.000Z");
  });

  test("a due schedule sends each recipient their own numbers once", async () => {
    const d = await store.createDashboard(manager(), {
      name: `${STAMP} Digest`,
      visibility: "everyone",
      layout: { widgets: [{ type: "kpi", title: "Created [click](https://evil.example)", measure: "created", groupBy: [], filters: {}, size: 1 }], filters: { team: [teamA, teamB] }, range: { preset: "last_30" }, compare: null },
    });
    dashboardIds.push(d.id);
    // An agent may schedule to themselves only.
    const self = await call(schedRoute.POST as Handler, req("/schedules", P.agentA.session, { dashboard_id: d.id, recipients: { users: [P.lead.id] }, frequency: "weekly", weekday: 1, hour: 8 }));
    assert.equal(self.status, 403);
    const made = await call(schedRoute.POST as Handler, req("/schedules", P.mgr.session, { dashboard_id: d.id, recipients: { users: [P.lead.id, P.none.id], teams: [] }, frequency: "monthly", hour: 7, format: "csv" }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const sid = made.body.schedule.id as number;
    await pool().query("UPDATE hd_report_schedules SET created_at = '2026-10-15T00:00:00Z' WHERE id = $1", [sid]);
    const sent: { to: string; subject: string; text: string }[] = [];
    email.setHelpdeskTransportForTests(async (m) => {
      sent.push({ to: m.to, subject: m.subject, text: m.text });
    });
    const now = new Date("2026-11-01T09:00:00Z");
    const r1 = await schedules.sendDueReportSchedules(now, { only: [sid] });
    assert.equal(r1.due, 1);
    assert.equal(sent.length, 1, "Ned has no report capability: nothing for him");
    assert.equal(sent[0].to, `${STAMP}-lead@example.test`);
    assert.match(sent[0].subject, /Digest: 1 October to 31 October/);
    // The lead's October: team A's five; the typed title cannot become a link.
    assert.match(sent[0].text, /\| 5 \|/);
    assert.doesNotMatch(sent[0].text, /\]\(https:\/\/evil/);
    assert.match(sent[0].text, /export\?format=csv&from=2026-10-01&to=2026-10-31/);
    const r2 = await schedules.sendDueReportSchedules(new Date("2026-11-01T09:01:00Z"), { only: [sid] });
    assert.equal(r2.due, 0);
    assert.equal(sent.length, 1);
    const audit = await pool().query("SELECT action FROM audit_log WHERE target_type = 'helpdesk_report_schedule' AND target_id = $1", [String(sid)]);
    assert.deepEqual(audit.rows.map((x) => x.action), ["helpdesk.report_schedule.created"]);
  });
});
