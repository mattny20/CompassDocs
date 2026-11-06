// Helpdesk 1.19.1 time tracking (agent V8): one running timer per agent
// (starting elsewhere stops and logs the old one, two starts at once leave
// one timer), stop logs the elapsed minutes, manual entries and their
// limits, who sees and edits entries (own; a team lead the team's; other
// agents and requesters nothing), the ticket's total, the team's "ask for
// time when solving" setting, the report measures (Time logged, Time per
// ticket, split by agent, in each viewer's scope), and the CSV export (needs
// tickets.export, follows the queue scope, defuses formulas). Audit rows.
//
// Route handlers are called directly with real sessions (next/headers and
// lib/ee stubbed, as test/helpdesk-assignment does).
//
// Parallel-safe: teams, accounts and tickets are this file's own (STAMP);
// report and export assertions filter on this file's teams. The role
// matrix override is in-process only (setRoleMatrixForTests).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-time.test.ts

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-time.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-time.virtual.js");
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
const time = require("../src/lib/helpdesk/time") as typeof import("../src/lib/helpdesk/time");
const timeShared = require("../src/lib/helpdesk/time-shared") as typeof import("../src/lib/helpdesk/time-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const engine = require("../src/lib/helpdesk/analytics/engine") as typeof import("../src/lib/helpdesk/analytics/engine");
const analytics = require("../src/lib/helpdesk/analytics/shared") as typeof import("../src/lib/helpdesk/analytics/shared");
const ticketTimeRoute = require("../src/app/api/helpdesk/tickets/[number]/time/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/time/route");
const timerRoute = require("../src/app/api/helpdesk/tickets/[number]/time/timer/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/time/timer/route");
const entryRoute = require("../src/app/api/helpdesk/time/[id]/route") as typeof import("../src/app/api/helpdesk/time/[id]/route");
const myTimerRoute = require("../src/app/api/helpdesk/time/timer/route") as typeof import("../src/app/api/helpdesk/time/timer/route");
const exportRoute = require("../src/app/api/helpdesk/time/export/route") as typeof import("../src/app/api/helpdesk/time/export/route");
const teamTimeRoute = require("../src/app/api/helpdesk/admin/teams/[id]/time/route") as typeof import("../src/app/api/helpdesk/admin/teams/[id]/time/route");
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any; text: string }> {
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
    return { status: res.status, body, text };
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

const STAMP = `hdtime-${Date.now()}-${process.pid}`;
const P: Record<string, { id: number; session: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const K: Record<string, { id: number; number: number }> = {};

async function person(key: string, deskRole: string | null) {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    `${key} ${STAMP}`,
    `${STAMP}-${key}@example.test`,
  ]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[key] = { id, session };
}

async function ticket(key: string, team: string) {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source) VALUES ($1, $2, 'Req', $3, $4, 'open', 'portal') RETURNING id, number",
    [`${key} ${STAMP}`, P.req.id, `${STAMP}-req@example.test`, T[team]]
  );
  K[key] = r.rows[0];
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  for (const k of ["A", "B"]) {
    const r = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9400) RETURNING id", [`${STAMP} ${k}`]);
    T[k] = r.rows[0].id;
  }
  await person("agentA", "agent");
  await person("agentA2", "agent");
  await person("lead", "team_lead");
  await person("agentB", "agent");
  await person("mgr", "manager");
  await person("req", null);
  await pool().query(
    "INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($1, $4, 'lead'), ($5, $6, 'agent')",
    [T.A, P.agentA.id, P.agentA2.id, P.lead.id, T.B, P.agentB.id]
  );
  await ticket("a1", "A");
  await ticket("a2", "A");
  await ticket("b1", "B");
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  await pool().query("DELETE FROM hd_tickets WHERE team_id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

const n = (k: string) => String(K[k].number);
const minutesOn = async (k: string) => Number((await pool().query("SELECT COALESCE(sum(minutes), 0) AS m FROM hd_time_entries WHERE ticket_id = $1", [K[k].id])).rows[0].m);

describe("helpers (pure)", () => {
  test("durations read as 45m, 1h, 1h 25m; the clock as 00:12:40; typed durations parse", () => {
    assert.equal(timeShared.formatMinutes(45), "45m");
    assert.equal(timeShared.formatMinutes(60), "1h");
    assert.equal(timeShared.formatMinutes(85), "1h 25m");
    assert.equal(timeShared.formatClock(760_000), "00:12:40");
    assert.equal(timeShared.parseDuration("1h 30m"), 90);
    assert.equal(timeShared.parseDuration("1.5h"), 90);
    assert.equal(timeShared.parseDuration("45"), 45);
    assert.equal(timeShared.parseDuration("soon"), null);
  });
});

describe("time tracking (database)", () => {
  test("one timer per agent: starting on another ticket stops and logs the first; two starts at once leave one", async () => {
    const t0 = Date.now() - 20 * 60_000;
    const first = await time.startTimer(P.agentA.id, K.a1.id, t0);
    assert.equal(first.timer?.ticket_id, K.a1.id);
    assert.equal(first.logged, null);
    const again = await time.startTimer(P.agentA.id, K.a1.id, t0 + 60_000);
    assert.equal(again.logged, null, "already running there: unchanged");
    const moved = await time.startTimer(P.agentA.id, K.a2.id);
    assert.equal(moved.timer?.ticket_id, K.a2.id);
    assert.equal(moved.logged?.ticket_id, K.a1.id);
    assert.equal(moved.logged?.minutes, 20);
    assert.equal(moved.logged?.source, "timer");
    const rows = await pool().query("SELECT ticket_id FROM hd_timers WHERE user_id = $1", [P.agentA.id]);
    assert.deepEqual(rows.rows.map((r) => r.ticket_id), [K.a2.id]);

    await Promise.all([time.startTimer(P.agentA2.id, K.a1.id), time.startTimer(P.agentA2.id, K.a2.id)]);
    assert.equal((await pool().query("SELECT 1 FROM hd_timers WHERE user_id = $1", [P.agentA2.id])).rowCount, 1);
    await time.stopTimer(P.agentA2.id);
    await pool().query("DELETE FROM hd_time_entries WHERE user_id = $1", [P.agentA2.id]);

    const mine = await call(myTimerRoute.GET, req("/time/timer", P.agentA.session));
    assert.equal(mine.body.timer.ticket_number, K.a2.number);
  });

  test("stop logs the elapsed minutes (at least one) with a note; stopping where it doesn't run is refused", async () => {
    await pool().query("UPDATE hd_timers SET started_at = now() - interval '7 minutes 20 seconds' WHERE user_id = $1", [P.agentA.id]);
    const wrong = await call(timerRoute.DELETE, req(`/tickets/${n("a1")}/time/timer`, P.agentA.session, {}, "DELETE"), { number: n("a1") });
    assert.equal(wrong.status, 409);
    const r = await call(timerRoute.DELETE, req(`/tickets/${n("a2")}/time/timer`, P.agentA.session, { note: "investigation" }, "DELETE"), { number: n("a2") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.logged.minutes, 7);
    assert.equal(r.body.logged.note, "investigation");
    assert.equal(r.body.timer, null);
    const start = await call(timerRoute.POST, req(`/tickets/${n("a2")}/time/timer`, P.agentA.session, {}), { number: n("a2") });
    assert.equal(start.status, 200);
    const quick = await call(timerRoute.DELETE, req(`/tickets/${n("a2")}/time/timer`, P.agentA.session, {}, "DELETE"), { number: n("a2") });
    assert.equal(quick.body.logged.minutes, 1, "a few seconds count as a minute");
  });

  test("manual entries: limits, who can log and read; the ticket's total; requesters never see time", async () => {
    const bad = async (minutes: unknown) => (await call(ticketTimeRoute.POST, req(`/tickets/${n("a1")}/time`, P.agentA.session, { minutes }), { number: n("a1") })).status;
    assert.equal(await bad(0), 400);
    assert.equal(await bad(1441), 400);
    assert.equal(await bad(2.5), 400);
    const ok = await call(ticketTimeRoute.POST, req(`/tickets/${n("a1")}/time`, P.agentA2.session, { minutes: 25, note: "investigation" }), { number: n("a1") });
    assert.equal(ok.status, 201);
    assert.equal((await call(ticketTimeRoute.POST, req(`/tickets/${n("a1")}/time`, P.agentB.session, { minutes: 5 }), { number: n("a1") })).status, 404, "another team's agent");
    assert.equal((await call(ticketTimeRoute.GET, req(`/tickets/${n("a1")}/time`, P.agentB.session), { number: n("a1") })).status, 404);
    assert.equal((await call(ticketTimeRoute.GET, req(`/tickets/${n("a1")}/time`, P.req.session), { number: n("a1") })).status, 403, "the requester");
    const view = await call(ticketTimeRoute.GET, req(`/tickets/${n("a1")}/time`, P.agentA.session), { number: n("a1") });
    assert.equal(view.status, 200);
    assert.equal(view.body.total_minutes, await minutesOn("a1"));
    assert.equal(view.body.total_minutes, 45);
    assert.equal(view.body.entries.length, 2);
    assert.equal(view.body.entries.find((e: { user_id: number }) => e.user_id === P.agentA2.id).can_edit, false, "someone else's");
    assert.equal(view.body.entries.find((e: { user_id: number }) => e.user_id === P.agentA.id).can_edit, true, "your own");
    const leadView = await call(ticketTimeRoute.GET, req(`/tickets/${n("a1")}/time`, P.lead.session), { number: n("a1") });
    assert.ok(leadView.body.entries.every((e: { can_edit: boolean }) => e.can_edit), "the team's lead edits all");
  });

  test("edit and delete: your own, or the team's as its lead; nobody else's; audited", async () => {
    const theirs = (await pool().query("SELECT id FROM hd_time_entries WHERE ticket_id = $1 AND user_id = $2", [K.a1.id, P.agentA2.id])).rows[0].id as number;
    const own = (await pool().query("SELECT id FROM hd_time_entries WHERE ticket_id = $1 AND user_id = $2", [K.a1.id, P.agentA.id])).rows[0].id as number;
    const patch = (session: string, id: number, body: unknown) => call(entryRoute.PATCH, req(`/time/${id}`, session, body, "PATCH"), { id: String(id) });
    assert.equal((await patch(P.agentA.session, theirs, { minutes: 1 })).status, 404, "a teammate's entry");
    assert.equal((await patch(P.agentB.session, own, { minutes: 1 })).status, 404, "another team");
    const byLead = await patch(P.lead.session, theirs, { minutes: 30, note: "investigation and fix" });
    assert.equal(byLead.status, 200);
    assert.equal(byLead.body.entry.minutes, 30);
    assert.equal((await patch(P.agentA.session, own, { minutes: 1500 })).status, 400);
    assert.equal((await patch(P.agentA.session, own, { minutes: 18 })).status, 200);
    assert.equal(await minutesOn("a1"), 48);
    assert.equal((await call(entryRoute.DELETE, req(`/time/${own}`, P.agentB.session, undefined, "DELETE"), { id: String(own) })).status, 404);
    const extra = await time.logTime(P.agentA.id, K.a1.id, 3, "");
    assert.equal((await call(entryRoute.DELETE, req(`/time/${extra.id}`, P.agentA.session, undefined, "DELETE"), { id: String(extra.id) })).status, 200);
    const actions = (await pool().query("SELECT action FROM audit_log WHERE actor_id = ANY($1) AND action LIKE 'helpdesk.time.%'", [userIds])).rows.map((r) => r.action);
    for (const a of ["helpdesk.time.logged", "helpdesk.time.edited", "helpdesk.time.deleted"]) assert.ok(actions.includes(a), a);
  });

  test("the team's ask-for-time-on-solve setting: its lead turns it on; the ticket says so", async () => {
    const patch = (session: string, team: number, on: boolean) => call(teamTimeRoute.PATCH, req(`/admin/teams/${team}/time`, session, { ask_time_on_solve: on }, "PATCH"), { id: String(team) });
    assert.equal((await patch(P.agentA.session, T.A, true)).status, 403);
    assert.equal((await patch(P.lead.session, T.B, true)).status, 403, "not their team");
    assert.equal((await patch(P.lead.session, T.A, true)).status, 200);
    const view = await call(ticketTimeRoute.GET, req(`/tickets/${n("a1")}/time`, P.agentA.session), { number: n("a1") });
    assert.equal(view.body.ask_on_solve, true);
    const other = await call(ticketTimeRoute.GET, req(`/tickets/${n("b1")}/time`, P.agentB.session), { number: n("b1") });
    assert.equal(other.body.ask_on_solve, false);
    assert.equal((await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.team.time_setting_changed' AND actor_id = $1", [P.lead.id])).rowCount, 1);
  });

  test("report measures: Time logged (sum) and Time per ticket (average), by agent, in each viewer's scope", async () => {
    await time.logTime(P.agentB.id, K.b1.id, 40, "");
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE id = ANY($1)", [[K.a1.id, K.a2.id]]);
    const filters = { team: [T.A, T.B] };
    const q = (viewer: string, measure: "time_logged" | "time_per_ticket", groupBy: ("assignee" | "team")[] = []) =>
      engine.runQuery({ measure, filters, range: { preset: "today" }, groupBy }, { id: P[viewer].id, role: "viewer" }, { fresh: true });
    const a = (await minutesOn("a1")) + (await minutesOn("a2"));
    const b = await minutesOn("b1");
    assert.equal((await q("mgr", "time_logged")).total.value, a + b);
    const byAgent = await q("mgr", "time_logged", ["assignee"]);
    const agentRow = byAgent.rows.find((r) => r.keys[0] === P.agentB.id);
    assert.equal(agentRow?.value, 40);
    assert.equal(byAgent.unit, "minutes");
    const byTeam = await q("mgr", "time_logged", ["team"]);
    assert.equal(byTeam.rows.find((r) => r.keys[0] === T.A)?.value, a);
    // A lead reads their teams; an agent their own entries.
    assert.equal((await q("lead", "time_logged")).total.value, a);
    const own = await pool().query("SELECT COALESCE(sum(minutes), 0) AS m FROM hd_time_entries WHERE user_id = $1", [P.agentA.id]);
    assert.equal((await q("agentA", "time_logged")).total.value, Number(own.rows[0].m));
    // Time per ticket: tickets solved today with time on them (a1 and a2; b1 is still open).
    const per = await q("mgr", "time_per_ticket");
    assert.equal(per.total.value, a / 2);
    assert.equal(per.total.n, 2);
    assert.ok(analytics.dimensionsFor("time_logged").includes("assignee"));
    assert.ok(analytics.dimensionsFor("time_logged").includes("request_type"));
    assert.ok(analytics.dimensionsFor("time_per_ticket").includes("category"));
  });

  test("CSV export: needs tickets.export, follows the queue scope, defuses formulas; audited", async () => {
    await time.logTime(P.agentA.id, K.a2.id, 12, "=HYPERLINK(\"x\")");
    const get = (viewer: string, qs = "") => call(exportRoute.GET, req(`/time/export?team=${T.A},${T.B}${qs}`, P[viewer].session));
    assert.equal((await get("agentA")).status, 403, "agents can't export by default");
    const all = await get("mgr");
    assert.equal(all.status, 200);
    const lines = all.text.trim().split("\r\n");
    assert.equal(lines[0], "\"Logged\",\"Ticket\",\"Subject\",\"Team\",\"Request type\",\"Category\",\"Agent\",\"Minutes\",\"Hours\",\"Note\",\"Source\"");
    const count = Number((await pool().query("SELECT count(*) AS c FROM hd_time_entries WHERE ticket_id = ANY($1)", [[K.a1.id, K.a2.id, K.b1.id]])).rows[0].c);
    assert.equal(lines.length - 1, count);
    assert.ok(all.text.includes("\"'=HYPERLINK(\"\"x\"\")\""), "a formula is defused");
    assert.ok(all.text.includes(`b1 ${STAMP}`));
    const agentOnly = await get("mgr", `&agent=${P.agentB.id}`);
    assert.equal(agentOnly.text.trim().split("\r\n").length - 1, 1);
    assert.equal((await get("mgr", "&from=2026-13-01")).status, 400);
    // A team lead given Export tickets sees their team's entries, not another team's.
    const m = await roles.getRoleMatrix();
    roles.setRoleMatrixForTests({ ...m, team_lead: [...m.team_lead, "tickets.export"] });
    try {
      const lead = await get("lead");
      assert.equal(lead.status, 200);
      assert.ok(lead.text.includes(`a1 ${STAMP}`));
      assert.ok(!lead.text.includes(`b1 ${STAMP}`));
    } finally {
      roles.setRoleMatrixForTests(null);
    }
    assert.ok((await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.time.exported' AND actor_id = $1", [P.mgr.id])).rowCount! >= 1);
  });

  test("a deleted ticket takes its time and timers with it", async () => {
    await time.startTimer(P.agentB.id, K.b1.id);
    await pool().query("DELETE FROM hd_tickets WHERE id = $1", [K.b1.id]);
    assert.equal((await pool().query("SELECT 1 FROM hd_time_entries WHERE ticket_id = $1", [K.b1.id])).rowCount, 0);
    assert.equal((await pool().query("SELECT 1 FROM hd_timers WHERE user_id = $1", [P.agentB.id])).rowCount, 0);
  });
});
