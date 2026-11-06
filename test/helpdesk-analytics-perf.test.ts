// Helpdesk 1.19.0 reports (agent K): the main report queries stay quick on
// a busy desk. Seeds 20,000 tickets (and 60,000 replies) across 2025 in
// this file's own two teams, then times each dashboard query, warm, through
// runQuery with the cache off. Target: under 300 ms each on the shared CI
// database (the business-time measures included: one memoised clock pass).
//
// Every row is created closed and dated 2025, so no other file's queue
// views ("open", "this week") ever see them; all of it is deleted after.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-analytics-perf.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, getSetting } from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import { runQuery, type ReportScope } from "../src/lib/helpdesk/analytics/engine";
import { ensureAnalyticsSchema } from "../src/lib/helpdesk/analytics/store";
import { setReportHoursForTests } from "../src/lib/helpdesk/analytics/hours";
import type { HdAnalyticsQuery } from "../src/lib/helpdesk/analytics/shared";

const STAMP = `hdanp-${Date.now()}-${process.pid}`;
const N = 20_000;
const LIMIT_MS = Number(process.env.HD_REPORT_PERF_MS || 300);
let teams: number[] = [];
let agents: number[] = [];

before(async () => {
  await getSetting("__schema_bootstrap__");
  await ensureAnalyticsSchema();
  setReportHoursForTests({ timezone: "Europe/London", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", holidays: ["2025-12-25", "2025-12-26"] });
  for (const k of ["a", "b", "c", "d", "e", "f"]) {
    const r = await fixtureQuery("INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id", [`${STAMP}-${k}`, `Perf ${k}`, `${STAMP}-${k}@example.test`]);
    agents.push(r.rows[0].id);
  }
  for (const k of ["IT", "HR"]) teams.push((await pool().query("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} ${k}`])).rows[0].id);
  const t0 = Date.now();
  // 20,000 tickets over 2025: created during the working day, first reply within hours, solved within days.
  await pool().query(
    `INSERT INTO hd_tickets (subject, requester_name, team_id, assignee_id, status, priority, category, tags, source, created_at, updated_at,
                             first_replied_at, solved_at, closed_at, first_reply_due, resolve_due, csat_score, csat_at)
     SELECT 'perf', 'x', ($1::int[])[1 + (g % 2)], ($2::int[])[1 + (g % 6)], 'closed',
            (ARRAY['low','normal','normal','high','urgent'])[1 + (g % 5)], (ARRAY['Hardware','Access','Network',''])[1 + (g % 4)],
            CASE WHEN g % 3 = 0 THEN ARRAY['vpn'] ELSE '{}' END, (ARRAY['portal','portal','email','desk','doc'])[1 + (g % 5)],
            c, c, c + make_interval(mins => 5 + (g * 37) % 600), c + make_interval(hours => 1 + (g * 13) % 120), c + make_interval(hours => 2 + (g * 13) % 120),
            c + interval '4 hours', c + interval '2 days',
            CASE WHEN g % 4 = 0 THEN 1 + (g % 5) END, CASE WHEN g % 4 = 0 THEN c + interval '3 days' END
       FROM generate_series(1, $3::int) g,
            LATERAL (SELECT timestamptz '2025-01-01 08:00:00+00' + make_interval(days => (g * 7919) % 364, mins => (g * 31) % 540) AS c) cc`,
    [teams, agents, N]
  );
  await pool().query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at)
     SELECT t.id, t.assignee_id, 'x', CASE WHEN k = 3 THEN 'internal' ELSE 'public' END, 'r', 'desk', t.first_replied_at + make_interval(mins => k * 30)
       FROM hd_tickets t CROSS JOIN generate_series(1, 3) k
      WHERE t.team_id = ANY($1::int[])`,
    [teams]
  );
  await pool().query("ANALYZE hd_tickets");
  await pool().query("ANALYZE hd_messages");
  console.log(`seeded ${N} tickets in ${Date.now() - t0} ms`);
});

after(async () => {
  setReportHoursForTests(null);
  await pool().query("DELETE FROM hd_tickets WHERE team_id = ANY($1::int[])", [teams]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1::int[])", [teams]);
  await pool().query("DELETE FROM users WHERE id = ANY($1::int[])", [agents]);
  await pool().end();
});

const YEAR = { from: "2025-01-01", to: "2025-12-31" };
const QUARTER = { from: "2025-10-01", to: "2025-12-31" };

const CASES: [string, Omit<HdAnalyticsQuery, "filters">][] = [
  ["created by day, a quarter, vs previous", { measure: "created", groupBy: ["day"], range: QUARTER, compare: "previous_period" }],
  ["created by week × team, a year", { measure: "created", groupBy: ["week", "team"], range: YEAR }],
  ["solved by assignee", { measure: "solved", groupBy: ["assignee"], range: YEAR }],
  ["first reply median by team (business time)", { measure: "first_reply_median", groupBy: ["team"], range: YEAR }],
  ["resolution p90, a year (business time)", { measure: "resolution_p90", range: YEAR, compare: "previous_period" }],
  ["first reply median by week (business time)", { measure: "first_reply_median", groupBy: ["week"], range: QUARTER }],
  ["SLA first reply % by priority", { measure: "sla_first_reply_pct", groupBy: ["priority"], range: YEAR }],
  ["SLA breaches by team", { measure: "sla_breaches", groupBy: ["team"], range: YEAR }],
  ["CSAT % by assignee", { measure: "csat_pct", groupBy: ["assignee"], range: YEAR }],
  ["replies per ticket by team", { measure: "replies_per_ticket", groupBy: ["team"], range: QUARTER }],
  ["one-touch %", { measure: "one_touch_pct", range: YEAR }],
  ["backlog by week, a quarter", { measure: "backlog", groupBy: ["week"], range: QUARTER }],
  ["heatmap", { measure: "created", groupBy: ["weekday", "hour"], range: YEAR }],
  ["tickets by tag", { measure: "created", groupBy: ["tag"], range: YEAR }],
  ["open now by assignee", { measure: "open_now", groupBy: ["assignee"], range: { preset: "today" } }],
];

const all: ReportScope = { kind: "all", userId: 0 };
const viewer = { id: 0, role: "viewer" as const };

test(`the dashboard queries stay under ${LIMIT_MS} ms on ${N} tickets`, async () => {
  const slow: string[] = [];
  const now = Date.parse("2026-01-15T12:00:00Z");
  for (const [name, q] of CASES) {
    const query = { ...q, filters: { team: teams } } as HdAnalyticsQuery;
    await runQuery(query, viewer, { scope: all, now, fresh: true }); // warm
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = await runQuery(query, viewer, { scope: all, now, fresh: true });
      times.push(performance.now() - t0);
      if (i === 0 && !q.measure.endsWith("_now")) assert.ok(r.total.n > 0, `${name} found rows`);
    }
    const best = Math.min(...times);
    console.log(`${best.toFixed(0).padStart(5)} ms  ${name}`);
    if (best > LIMIT_MS) slow.push(`${name}: ${best.toFixed(0)} ms`);
  }
  // A team-scoped viewer's query (scope + filter), the most common shape.
  const t0 = performance.now();
  await runQuery({ measure: "first_reply_median", groupBy: ["day"], range: QUARTER, filters: {} }, viewer, { scope: { kind: "teams", userId: 0, teams: [teams[0]], own: false }, now, fresh: true });
  console.log(`${(performance.now() - t0).toFixed(0).padStart(5)} ms  team scope: first reply by day`);
  assert.deepEqual(slow, [], `slower than ${LIMIT_MS} ms:\n${slow.join("\n")}`);
});
