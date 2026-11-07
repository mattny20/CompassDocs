// Helpdesk 1.19.0 reports (agent K): the metrics engine. One entry point,
// runQuery({ measure, groupBy, filters, range, compare }, viewer), answers
// every chart, tile and table on /desk/reports, the Explore page, the
// exports and the scheduled digests.
//
// How a query runs:
//   1. The measure and dimensions come from the whitelists in ./shared;
//      their SQL fragments are constants in this file. Values (dates, ids,
//      the time zone, the viewer) are bound parameters, never spliced.
//   2. The viewer's scope is SQL: reports.all sees everything,
//      reports.team the teams they belong to (plus their own tickets with
//      reports.own), reports.own only tickets assigned to them. Filters
//      and splits are ANDed on top, so neither can widen it.
//   3. Counts, percentages and averages are aggregated in SQL. Durations
//      come back one row per ticket (capped) and are measured in TS: in
//      business time with each ticket's team calendar (./hours, the
//      memoised ./business-time clock), or in calendar time for approvals
//      and workflow runs; then median / 90th percentile per group.
//   4. One read-only transaction with a statement_timeout per query, at
//      most three report transactions at once (the pool has five
//      connections), and a short in-memory cache keyed by the query and
//      the viewer's scope.
//
// Aggregates never read message bodies or internal notes: replies are
// counted, never shown. Requester names never appear (there is no
// requester dimension); agent names do, for the assignee split.
//
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { hdCan } from "../roles";
import { memberTeamIds } from "../access";
import { parseReportRange, median } from "../reports";
import { wallClock, zonedInstant } from "../sla";
import { withTx } from "../db-core";
import { HD_OPEN_STATUSES, HD_STATUS_LABEL } from "../types";
import type { Role } from "../../types";
import {
  HD_CHANNEL_SOURCES,
  HD_DIMENSIONS,
  HD_MEASURES,
  addDays,
  codeLabel,
  compareDates,
  daysBetween,
  presetDates,
  rangeLabel,
  type HdAnalyticsQuery,
  type HdDimension,
  type HdFilters,
  type HdKey,
  type HdMeasureDef,
  type HdMeasureKey,
  type HdQueryResult,
  type HdResultRow,
} from "./shared";
import { clocksForTeams, reportTimezone, vipsAmong } from "./hours";

export type Viewer = { id: number; role: Role };

// --- Scope ------------------------------------------------------------------------------

export type ReportScope =
  | { kind: "all"; userId: number }
  | { kind: "teams"; userId: number; teams: number[]; own: boolean }
  | { kind: "own"; userId: number };

/** What this person may report on, or null (no report capability). */
export async function reportScope(viewer: Viewer): Promise<ReportScope | null> {
  if (await hdCan(viewer, "reports.all")) return { kind: "all", userId: viewer.id };
  const own = await hdCan(viewer, "reports.own");
  if (await hdCan(viewer, "reports.team")) {
    const teams = await memberTeamIds(viewer.id);
    return { kind: "teams", userId: viewer.id, teams, own };
  }
  if (own) return { kind: "own", userId: viewer.id };
  return null;
}

export function scopeKey(s: ReportScope): string {
  if (s.kind === "all") return "all";
  if (s.kind === "own") return `own:${s.userId}`;
  return `teams:${s.teams.join(",")}${s.own ? `+own:${s.userId}` : ""}`;
}

// --- Measures as SQL ----------------------------------------------------------------------

type Agg =
  | { kind: "count" }
  | { kind: "pct"; num: string }
  | { kind: "avg"; expr: string }
  | { kind: "sum"; expr: string }
  | { kind: "durations"; a: string; b: string; business: boolean; paused?: string; stat: "median" | "p90" };

interface Src {
  /** FROM … with the ticket as `t` (LEFT JOINed where a row may have none). */
  from: string;
  /** Event time (event measures); snapshots and live measures have none. */
  ts?: string;
  /** Snapshot: the condition for "open at $at" (b.at). */
  openAt?: string;
  where: string[];
  agg: Agg;
  /** The team and the person scope and the team/assignee split use. */
  team: string;
  person: string;
  /** The workflow (id) a row belongs to, for the workflow filter and split. */
  workflow: string;
}

/** Parameters the fragments below may name, bound in this order. */
const P = { tz: "$1", now: "$2", lo: "$3", hi: "$4" } as const;
const FIXED_PARAMS = 4;

const OPEN = `t.status IN (${HD_OPEN_STATUSES.map((s) => `'${s}'`).join(", ")})`;
const TICKET_WORKFLOW = `(SELECT r0.workflow_id FROM hd_workflow_runs r0 WHERE r0.id = t.workflow_run_id)`;
const T = { from: "hd_tickets t", team: "t.team_id", person: "t.assignee_id", workflow: TICKET_WORKFLOW };
// 1.19.1 (merge): a ticket merged into another is closed with solved_at
// stamped, but it was never solved; its work goes on in the kept ticket.
// Every measure over solved tickets (counts, resolution times, the
// resolution SLA and the per-solved-ticket averages) leaves it out.
const SOLVED = "t.solved_at IS NOT NULL AND t.merged_into IS NULL";

// Replies an agent sent to the requester (a newbie's reply held for review, or returned, was never sent).
const AGENT_REPLIES = `LEFT JOIN LATERAL (
    SELECT count(*)::int AS n FROM hd_messages m
     WHERE m.ticket_id = t.id AND m.kind = 'public' AND m.via <> 'system'
       AND m.author_id IS DISTINCT FROM t.requester_id
       AND (m.review_state IS NULL OR m.review_state = 'approved')
  ) rc ON true`;

// A status change out of Solved or Closed (lib/helpdesk/tickets.updateTicket's timeline line).
const REOPEN_LINE = (status: "solved" | "closed") => `%changed the status from ${HD_STATUS_LABEL[status]} to %`;

// Workflow task steps (agent B): result.team_id is the team holding the
// task now, result.started_team_id the team it started with,
// result.transfers [{from_team_id, to_team_id, at}] each hand-over, and
// result.outcome 'done' | 'cant_do'. Older steps without them fall back to
// the task ticket's team and the step's state.
const STEP_TEAM = `COALESCE(NULLIF(s.result ->> 'team_id', '')::int, t.team_id)`;
const STEP_OUTCOME = `COALESCE(NULLIF(s.result ->> 'outcome', ''), CASE s.state WHEN 'done' THEN 'done' WHEN 'skipped' THEN 'skipped' WHEN 'failed' THEN 'cant_do' ELSE s.state END)`;
// The time each team held a task: started_at → each transfer → finished_at, one segment per holder.
const STEP_SEGMENTS = `CROSS JOIN LATERAL (
    SELECT pts.team_id, pts.at AS a, lead(pts.at, 1, s.finished_at) OVER (ORDER BY pts.ord) AS b
      FROM (
        SELECT 0::bigint AS ord,
               COALESCE(NULLIF(s.result ->> 'started_team_id', '')::int, NULLIF(s.result ->> 'team_id', '')::int, t.team_id) AS team_id,
               s.started_at AS at
        UNION ALL
        SELECT x.ord, NULLIF(x.e ->> 'to_team_id', '')::int, (x.e ->> 'at')::timestamptz
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.result -> 'transfers') = 'array' THEN s.result -> 'transfers' ELSE '[]'::jsonb END)
               WITH ORDINALITY AS x(e, ord)
         WHERE x.e ->> 'at' IS NOT NULL
      ) pts
  ) sg`;
const STEP_FROM = `hd_workflow_steps s JOIN hd_workflow_runs r ON r.id = s.run_id LEFT JOIN hd_tickets t ON t.id = s.task_ticket_id`;
const STEP = { from: STEP_FROM, team: STEP_TEAM, person: "t.assignee_id", workflow: "r.workflow_id" };
// When someone first took a task: the first assignment line, else (assigned when it was created) its creation.
const PICKUP_AT = `COALESCE(
    (SELECT min(pm.created_at) FROM hd_messages pm
      WHERE pm.ticket_id = t.id AND pm.kind = 'internal' AND pm.via = 'system'
        AND (pm.body LIKE '% took the ticket' OR pm.body LIKE '% assigned the ticket to %')),
    CASE WHEN t.assignee_id IS NOT NULL THEN t.created_at END)`;

function measureSrc(m: HdMeasureKey, extra: unknown[]): Src {
  const bind = (v: unknown) => {
    extra.push(v);
    return `$${FIXED_PARAMS + extra.length}`;
  };
  switch (m) {
    case "created":
      return { ...T, ts: "t.created_at", where: [], agg: { kind: "count" } };
    case "solved":
      return { ...T, ts: "t.solved_at", where: [SOLVED], agg: { kind: "count" } };
    case "reopened":
      return {
        ...T,
        from: "hd_messages rm JOIN hd_tickets t ON t.id = rm.ticket_id",
        ts: "rm.created_at",
        where: [`rm.kind = 'system' AND rm.via = 'system' AND (rm.body LIKE ${bind(REOPEN_LINE("solved"))} OR rm.body LIKE ${bind(REOPEN_LINE("closed"))})`],
        agg: { kind: "count" },
      };
    case "backlog":
      return {
        ...T,
        openAt: "t.created_at < b.at AND (t.solved_at IS NULL OR t.solved_at >= b.at) AND (t.closed_at IS NULL OR t.closed_at >= b.at)",
        where: [],
        agg: { kind: "count" },
      };
    case "unassigned":
      return {
        ...T,
        openAt: "t.created_at < b.at AND (t.solved_at IS NULL OR t.solved_at >= b.at) AND (t.closed_at IS NULL OR t.closed_at >= b.at)",
        where: ["t.assignee_id IS NULL"],
        agg: { kind: "count" },
      };
    case "first_reply_median":
    case "first_reply_p90":
      return {
        ...T,
        ts: "t.created_at",
        where: ["t.first_replied_at IS NOT NULL"],
        agg: { kind: "durations", a: "t.created_at", b: "t.first_replied_at", business: true, stat: m.endsWith("p90") ? "p90" : "median" },
      };
    case "resolution_median":
    case "resolution_p90":
      return {
        ...T,
        ts: "t.solved_at",
        where: [SOLVED],
        agg: { kind: "durations", a: "t.created_at", b: "t.solved_at", business: true, paused: "t.sla_paused_ms", stat: m.endsWith("p90") ? "p90" : "median" },
      };
    case "sla_first_reply_pct":
      // Decided targets: replied, or past due and not paused.
      return {
        ...T,
        ts: "t.first_reply_due",
        where: [`t.first_reply_due IS NOT NULL AND (t.first_replied_at IS NOT NULL OR (t.first_reply_due < ${P.now} AND t.sla_paused_at IS NULL))`],
        agg: { kind: "pct", num: "t.first_replied_at IS NOT NULL AND t.first_replied_at <= t.first_reply_due" },
      };
    case "sla_resolution_pct":
      return {
        ...T,
        ts: "t.resolve_due",
        where: [`t.resolve_due IS NOT NULL AND t.merged_into IS NULL AND (t.solved_at IS NOT NULL OR (t.resolve_due < ${P.now} AND t.sla_paused_at IS NULL))`],
        agg: { kind: "pct", num: "t.solved_at IS NOT NULL AND t.solved_at <= t.resolve_due" },
      };
    case "sla_breaches":
      // One event per missed target, at the time it fell due.
      return {
        ...T,
        from: `hd_tickets t CROSS JOIN LATERAL (VALUES
            (CASE WHEN t.first_reply_due IS NOT NULL AND COALESCE(t.first_replied_at, ${P.now}) > t.first_reply_due
                   AND NOT (t.first_replied_at IS NULL AND t.sla_paused_at IS NOT NULL) THEN t.first_reply_due END),
            (CASE WHEN t.resolve_due IS NOT NULL AND COALESCE(t.solved_at, ${P.now}) > t.resolve_due
                   AND NOT (t.solved_at IS NULL AND t.sla_paused_at IS NOT NULL) THEN t.resolve_due END)
          ) AS br(at)`,
        ts: "br.at",
        where: [`br.at IS NOT NULL AND br.at < ${P.now}`],
        agg: { kind: "count" },
      };
    case "csat_pct":
      return { ...T, ts: "t.csat_at", where: ["t.csat_score IS NOT NULL"], agg: { kind: "pct", num: "t.csat_score >= 4" } };
    case "csat_responses":
      return { ...T, ts: "t.csat_at", where: ["t.csat_score IS NOT NULL"], agg: { kind: "count" } };
    case "csat_response_rate":
      return {
        ...T,
        ts: "t.solved_at",
        where: [`${SOLVED} AND t.parent_ticket_id IS NULL AND t.source <> 'workflow'`],
        agg: { kind: "pct", num: "t.csat_score IS NOT NULL" },
      };
    case "replies_per_ticket":
      return { ...T, from: `hd_tickets t ${AGENT_REPLIES}`, ts: "t.solved_at", where: [SOLVED], agg: { kind: "avg", expr: "rc.n" } };
    case "one_touch_pct":
      return { ...T, from: `hd_tickets t ${AGENT_REPLIES}`, ts: "t.solved_at", where: [`${SOLVED} AND rc.n >= 1`], agg: { kind: "pct", num: "rc.n = 1" } };
    case "approvals_pending":
      return {
        from: "hd_approvals a JOIN hd_tickets t ON t.id = a.ticket_id JOIN hd_workflow_runs r ON r.id = a.run_id",
        team: "t.team_id",
        person: "t.assignee_id",
        workflow: "r.workflow_id",
        openAt: "a.created_at < b.at AND (a.decided_at IS NULL OR a.decided_at >= b.at)",
        where: ["NOT (a.decision = 'pending' AND r.state NOT IN ('running', 'waiting'))"],
        agg: { kind: "count" },
      };
    case "approval_decision_median":
      return {
        from: "hd_approvals a JOIN hd_tickets t ON t.id = a.ticket_id JOIN hd_workflow_runs r ON r.id = a.run_id",
        team: "t.team_id",
        person: "t.assignee_id",
        workflow: "r.workflow_id",
        ts: "a.decided_at",
        where: ["a.decided_at IS NOT NULL AND a.decision IN ('approved', 'declined')"],
        agg: { kind: "durations", a: "a.created_at", b: "a.decided_at", business: false, stat: "median" },
      };
    case "workflow_started":
    case "workflow_finished":
    case "workflow_duration_median": {
      const base = { from: "hd_workflow_runs r JOIN hd_tickets t ON t.id = r.ticket_id", team: "t.team_id", person: "t.assignee_id", workflow: "r.workflow_id" };
      if (m === "workflow_started") return { ...base, ts: "r.started_at", where: [], agg: { kind: "count" } };
      if (m === "workflow_finished") return { ...base, ts: "r.finished_at", where: ["r.finished_at IS NOT NULL AND r.state = 'done'"], agg: { kind: "count" } };
      return {
        ...base,
        ts: "r.finished_at",
        where: ["r.finished_at IS NOT NULL AND r.state = 'done'"],
        agg: { kind: "durations", a: "r.started_at", b: "r.finished_at", business: false, stat: "median" },
      };
    }
    case "workflow_team_time_median":
    case "workflow_team_time_p90":
      // One row per team segment, measured in that team's calendar.
      return {
        ...STEP,
        from: `${STEP_FROM} ${STEP_SEGMENTS}`,
        team: "sg.team_id",
        ts: "s.finished_at",
        where: [`s.kind = 'task' AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL AND ${STEP_OUTCOME} IN ('done', 'cant_do') AND sg.b > sg.a`],
        agg: { kind: "durations", a: "sg.a", b: "sg.b", business: true, stat: m.endsWith("p90") ? "p90" : "median" },
      };
    case "task_pickup_median":
      return {
        ...STEP,
        from: `${STEP_FROM} CROSS JOIN LATERAL (SELECT ${PICKUP_AT} AS at) pk`,
        ts: "s.started_at",
        where: ["s.kind = 'task' AND s.started_at IS NOT NULL AND t.id IS NOT NULL AND pk.at IS NOT NULL"],
        agg: { kind: "durations", a: "s.started_at", b: "GREATEST(pk.at, s.started_at)", business: true, stat: "median" },
      };
    case "task_cant_do_pct":
      return {
        ...STEP,
        ts: "s.finished_at",
        where: [`s.kind = 'task' AND s.finished_at IS NOT NULL AND ${STEP_OUTCOME} IN ('done', 'cant_do')`],
        agg: { kind: "pct", num: `${STEP_OUTCOME} = 'cant_do'` },
      };
    case "steps_skipped":
      return { ...STEP, ts: "COALESCE(s.finished_at, s.started_at)", where: [`${STEP_OUTCOME} = 'skipped'`], agg: { kind: "count" } };
    case "agent_workload":
      return { ...T, where: [OPEN, "t.assignee_id IS NOT NULL"], agg: { kind: "count" } };
    case "open_now":
      return { ...T, where: [OPEN], agg: { kind: "count" } };
    case "unassigned_now":
      return { ...T, where: [OPEN, "t.assignee_id IS NULL"], agg: { kind: "count" } };
    case "breaching_now":
      return {
        ...T,
        where: [OPEN, `t.sla_paused_at IS NULL AND ((t.first_replied_at IS NULL AND t.first_reply_due < ${P.now}) OR t.resolve_due < ${P.now})`],
        agg: { kind: "count" },
      };
    case "reviews_done":
    case "reviews_returned":
      return {
        from: "hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id",
        team: "t.team_id",
        person: "m.author_id",
        workflow: TICKET_WORKFLOW,
        ts: "m.reviewed_at",
        where: [m === "reviews_done" ? "m.review_state IN ('approved', 'returned') AND m.reviewed_at IS NOT NULL" : "m.review_state = 'returned' AND m.reviewed_at IS NOT NULL"],
        agg: { kind: "count" },
      };
    // Time tracking (1.19.1, agent V8): one row per entry, at the time it was logged, split by who logged it.
    case "time_logged":
      return {
        from: "hd_time_entries te JOIN hd_tickets t ON t.id = te.ticket_id",
        team: "t.team_id",
        person: "te.user_id",
        workflow: TICKET_WORKFLOW,
        ts: "te.logged_at",
        where: [],
        agg: { kind: "sum", expr: "te.minutes" },
      };
    // One row per solved ticket with time on it: its total.
    case "time_per_ticket":
      return {
        ...T,
        from: "hd_tickets t JOIN LATERAL (SELECT sum(x.minutes)::int AS m FROM hd_time_entries x WHERE x.ticket_id = t.id) tt ON tt.m > 0",
        ts: "t.solved_at",
        where: [SOLVED],
        agg: { kind: "avg", expr: "tt.m" },
      };
  }
}

// --- Columns that land with other agents' work ------------------------------------------------
//
// hd_tickets.automated / integration_id (agent P: machine tickets from
// alerts and the API) and hd_integrations are read only once they exist,
// so the reports run before and after that schema lands. Looked up once a
// minute.

interface Optional {
  automated: boolean;
  integration: boolean;
  integrations: boolean;
}
let optional: { at: number; value: Optional } | null = null;

async function optionalColumns(c: PoolClient): Promise<Optional> {
  if (optional && Date.now() - optional.at < 60_000) return optional.value;
  const r = await c.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'hd_tickets' AND column_name = 'automated') AS automated,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'hd_tickets' AND column_name = 'integration_id') AS integration,
            to_regclass('hd_integrations') IS NOT NULL AS integrations`
  );
  const value = { automated: Boolean(r.rows[0].automated), integration: Boolean(r.rows[0].integration), integrations: Boolean(r.rows[0].integrations) };
  optional = { at: Date.now(), value };
  return value;
}

// VIP requesters (agent O's contact cards: vipMap, today's list, not
// history). Resolved once a minute to the ids on the list, then bound as
// an array, so the split and the filter stay SQL.
let vipCache: { at: number; ids: number[] } | null = null;
async function vipIds(c: PoolClient): Promise<number[]> {
  if (vipCache && Date.now() - vipCache.at < 60_000) return vipCache.ids;
  const res = await c.query("SELECT DISTINCT requester_id AS id FROM hd_tickets WHERE requester_id IS NOT NULL LIMIT 50000");
  const ids = await vipsAmong(res.rows.map((r) => Number(r.id)));
  vipCache = { at: Date.now(), ids };
  return ids;
}

const automatedSql = (o: Optional) => (o.automated ? "COALESCE(t.automated, 0) = 1" : "false");

// --- Dimensions as SQL -----------------------------------------------------------------------

const DIRECTORY_JOIN = `LEFT JOIN users ru ON ru.id = t.requester_id
  LEFT JOIN directory_people dp ON dp.id = ru.directory_person_id AND dp.hidden = 0`;

// A ticket's channel, from HD_CHANNEL_SOURCES (so a split and a channel
// filter always agree): a channel covering several sources (the triggers)
// maps them to its key; a channel named after its one source (recurring,
// 1.19.1 portal_external "Customer portal") is the source itself.
const CHANNEL_SQL = `CASE ${Object.entries(HD_CHANNEL_SOURCES)
  .filter(([key, sources]) => !(sources.length === 1 && sources[0] === key))
  .map(([key, sources]) => `WHEN t.source IN (${sources.map((x) => `'${x}'`).join(", ")}) THEN '${key}'`)
  .join(" ")} ELSE t.source END`;

/** The SQL for one dimension's key, and any join it needs. `at` is the time the row buckets on. */
function dimSql(d: HdDimension, src: Src, at: string, o: Optional, vip: string): { expr: string; join?: string; lateral?: string } {
  switch (d) {
    case "vip":
      return { expr: `CASE WHEN t.requester_id = ANY(${vip}::int[]) THEN 'yes' ELSE 'no' END` };
    case "origin":
      return { expr: `CASE WHEN ${automatedSql(o)} THEN 'automated' ELSE 'people' END` };
    case "integration":
      return { expr: o.integration ? "t.integration_id" : "NULL::int" };
    case "day":
      return { expr: `to_char(${at} AT TIME ZONE ${P.tz}, 'YYYY-MM-DD')` };
    case "week":
      return { expr: `to_char(date_trunc('week', ${at} AT TIME ZONE ${P.tz}), 'YYYY-MM-DD')` };
    case "month":
      return { expr: `to_char(${at} AT TIME ZONE ${P.tz}, 'YYYY-MM')` };
    case "weekday":
      return { expr: `extract(isodow from ${at} AT TIME ZONE ${P.tz})::int` };
    case "hour":
      return { expr: `extract(hour from ${at} AT TIME ZONE ${P.tz})::int` };
    case "team":
      return { expr: src.team };
    case "assignee":
      return { expr: src.person };
    case "request_type":
      return { expr: "t.request_type_id" };
    case "category":
      return { expr: "COALESCE(t.category, '')" };
    case "priority":
      return { expr: "t.priority" };
    case "channel":
      return { expr: CHANNEL_SQL };
    case "status":
      return { expr: "t.status" };
    case "department":
      return { expr: "COALESCE(dp.department, '')", join: DIRECTORY_JOIN };
    case "office":
      return { expr: "COALESCE(dp.office, '')", join: DIRECTORY_JOIN };
    case "tag":
      return { expr: "tg.tag", lateral: "CROSS JOIN LATERAL unnest(CASE WHEN cardinality(COALESCE(t.tags, '{}')) = 0 THEN ARRAY[''] ELSE t.tags END) AS tg(tag)" };
    case "workflow":
      return { expr: src.workflow };
    case "workflow_step":
      return { expr: "(r.workflow_id::text || ':' || s.step_key)" };
  }
}

// --- Filters and scope as SQL ---------------------------------------------------------------------

function filterSql(f: HdFilters, src: Src, bind: (v: unknown) => string, vip: () => string): string[] {
  const out: string[] = [];
  if (f.vip?.length === 1) out.push(f.vip[0] === "yes" ? `t.requester_id = ANY(${vip()}::int[])` : `(t.requester_id IS NULL OR NOT (t.requester_id = ANY(${vip()}::int[])))`);
  if (f.team?.length) out.push(`${src.team} = ANY(${bind(f.team)}::int[])`);
  if (f.assignee?.length) {
    const ids = f.assignee.filter((x): x is number => x !== "none");
    const parts: string[] = [];
    if (ids.length) parts.push(`${src.person} = ANY(${bind(ids)}::int[])`);
    if (f.assignee.includes("none")) parts.push(`${src.person} IS NULL`);
    out.push(`(${parts.join(" OR ")})`);
  }
  if (f.request_type?.length) out.push(`t.request_type_id = ANY(${bind(f.request_type)}::int[])`);
  if (f.priority?.length) out.push(`t.priority = ANY(${bind(f.priority)}::text[])`);
  if (f.status?.length) out.push(`t.status = ANY(${bind(f.status)}::text[])`);
  if (f.channel?.length) out.push(`t.source = ANY(${bind(f.channel.flatMap((c) => HD_CHANNEL_SOURCES[c]))}::text[])`);
  if (f.category?.length) out.push(`COALESCE(t.category, '') = ANY(${bind(f.category)}::text[])`);
  if (f.tag?.length) out.push(`t.tags && ${bind(f.tag)}::text[]`);
  if (f.workflow?.length) out.push(`${src.workflow} = ANY(${bind(f.workflow)}::int[])`);
  return out;
}

function scopeSql(s: ReportScope, src: Src, bind: (v: unknown) => string): string | null {
  if (s.kind === "all") return null;
  if (s.kind === "own") return `${src.person} = ${bind(s.userId)}::int`;
  const team = `${src.team} = ANY(${bind(s.teams)}::int[])`;
  return s.own ? `(${team} OR ${src.person} = ${bind(s.userId)}::int)` : team;
}

// --- Ranges ------------------------------------------------------------------------------------------

export interface ResolvedRange {
  from: string;
  to: string;
  tz: string;
  /** [lo, hi) instants (ms). */
  lo: number;
  hi: number;
  label: string;
}

function ymdIn(t: number, tz: string): string {
  const w = wallClock(t, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}
function dayStart(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return zonedInstant(y, m, d, 0, 0, tz);
}

/** A range input to dates and instants in the helpdesk's zone; errors are 400 sentences (C's parseReportRange rules). */
export function resolveRange(input: HdAnalyticsQuery["range"], tz: string, now: number): { ok: true; range: ResolvedRange } | { ok: false; error: string } {
  const today = ymdIn(now, tz);
  const dates = "preset" in input ? presetDates(input.preset, today) : input;
  const parsed = parseReportRange(new URLSearchParams({ from: dates.from, to: dates.to }), tz, now);
  if (!parsed.ok) return parsed;
  return { ok: true, range: fromDates(parsed.range.from, parsed.range.to, tz, rangeLabel(input)) };
}

function fromDates(from: string, to: string, tz: string, label: string): ResolvedRange {
  return { from, to, tz, lo: dayStart(from, tz), hi: dayStart(addDays(to, 1), tz), label };
}

/** The bucket keys of a time dimension across a range (what SQL's to_char gives), in order. */
export function timeKeys(d: "day" | "week" | "month", from: string, to: string): string[] {
  const out: string[] = [];
  if (d === "day") {
    for (let x = from; x <= to; x = addDays(x, 1)) out.push(x);
  } else if (d === "week") {
    const dow = new Date(`${from}T00:00:00Z`).getUTCDay() || 7;
    for (let x = addDays(from, 1 - dow); x <= to; x = addDays(x, 7)) out.push(x);
  } else {
    let [y, m] = from.split("-").map(Number);
    const end = to.slice(0, 7);
    for (;;) {
      const k = `${y}-${String(m).padStart(2, "0")}`;
      if (k > end) break;
      out.push(k);
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  }
  return out;
}

/** Snapshot buckets: each key and the instant it is measured at (its end, or now). */
function snapshotBuckets(d: HdDimension | undefined, r: ResolvedRange, now: number): { keys: string[]; at: Date[] } {
  const end = Math.min(r.hi, now);
  if (!d || HD_DIMENSIONS[d].kind !== "time") return { keys: [""], at: [new Date(end)] };
  const keys: string[] = [];
  const at: Date[] = [];
  for (const k of timeKeys(d as "day" | "week" | "month", r.from, r.to)) {
    const start = k.length === 7 ? `${k}-01` : k;
    let next: string;
    if (d === "day") next = addDays(k, 1);
    else if (d === "week") next = addDays(k, 7);
    else {
      const [y, m] = k.split("-").map(Number);
      next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    }
    const s = Math.max(dayStart(start, r.tz), r.lo);
    if (s > now) break;
    keys.push(k);
    at.push(new Date(Math.min(dayStart(next, r.tz), end)));
  }
  return { keys, at };
}

// --- Running -----------------------------------------------------------------------------------------

export const ENGINE_LIMITS = { statementMs: 8000, durationRows: 200_000, groupRows: 5000, cacheTtlMs: 30_000, liveTtlMs: 15_000, cacheEntries: 400, concurrent: 3 } as const;

interface RawRow {
  keys: HdKey[];
  v: number | null;
  n: number;
}

interface RunOpts {
  now?: number;
  tz?: string;
  /** Skip the cache (tests, exports that must be fresh). */
  fresh?: boolean;
}

// At most ENGINE_LIMITS.concurrent report transactions at once: the pool
// has five connections and the desk's own queries must not wait on a
// dashboard of twenty widgets.
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= ENGINE_LIMITS.concurrent) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

async function readOnly<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return slot(() =>
    withTx(async (c) => {
      await c.query("SET TRANSACTION READ ONLY");
      await c.query(`SET LOCAL statement_timeout = ${ENGINE_LIMITS.statementMs}`);
      return fn(c);
    })
  );
}

const quantile = (sorted: number[], q: number): number | null => {
  if (!sorted.length) return null;
  // Nearest-rank: the smallest value at or above q of the sample.
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round(sorted[i]);
};

function statOf(values: number[], stat: "median" | "p90"): number | null {
  if (stat === "median") return median(values);
  return quantile([...values].sort((a, b) => a - b), 0.9);
}

/** One measure × dimensions over one range: the grouped rows and the total. */
async function compute(
  c: PoolClient,
  measure: HdMeasureKey,
  dims: HdDimension[],
  filters: HdFilters,
  scope: ReportScope,
  range: ResolvedRange,
  now: number,
  wantRows: boolean,
  automated: boolean
): Promise<{ rows: RawRow[]; total: { value: number | null; n: number }; truncated: boolean }> {
  const def: HdMeasureDef = HD_MEASURES[measure];
  const opt = await optionalColumns(c);
  const extra: unknown[] = [];
  const bind = (v: unknown) => {
    extra.push(v);
    return `$${FIXED_PARAMS + extra.length}`;
  };
  const src = measureSrc(measure, extra);
  // Every fixed parameter typed once, whether or not the fragments use it.
  // The VIP list, bound once when the split or the filter needs it.
  let vipParam = "";
  const needVip = dims.includes("vip") || Boolean(filters.vip?.length === 1);
  const vipList = needVip ? await vipIds(c) : [];
  const vip = () => (vipParam ||= bind(vipList));
  const where = [`num_nonnulls(${P.tz}::text, ${P.now}::timestamptz, ${P.lo}::timestamptz, ${P.hi}::timestamptz) = 4`, ...src.where, ...filterSql(filters, src, bind, vip)];
  const sc = scopeSql(scope, src, bind);
  if (sc) where.push(sc);
  // 1.19.4 (C7): a ticket in the recycle bin counts in no report (every source names its ticket `t`; a step without one has none).
  where.push("(t.id IS NULL OR t.deleted_at IS NULL)");
  // A workflow step, approval or run belongs to its run's request (r.ticket_id) too: a binned request's steps count nowhere.
  if (/\bhd_workflow_runs r\b/.test(src.from)) where.push("NOT EXISTS (SELECT 1 FROM hd_tickets rq WHERE rq.id = r.ticket_id AND rq.deleted_at IS NOT NULL)");
  // Automated tickets (alerts, API) count only when asked for, and never for the people measures.
  const subject = def.subject ?? "ticket";
  if (opt.automated && (subject === "ticket" || subject === "review") && (def.peopleOnly || !automated)) where.push(`NOT (${automatedSql(opt)})`);

  let from = src.from;
  let bucketSql = "";
  let at = src.ts ?? P.now;
  if (def.basis === "event") {
    where.push(`${src.ts} >= ${P.lo} AND ${src.ts} < ${P.hi}`);
  } else if (def.basis === "snapshot") {
    const timeDim = dims.find((d) => HD_DIMENSIONS[d].kind === "time");
    const b = snapshotBuckets(wantRows ? timeDim : undefined, range, now);
    bucketSql = `(SELECT * FROM unnest(${bind(b.keys)}::text[], ${bind(b.at)}::timestamptz[]) AS bb(key, at)) b`;
    from = `${bucketSql} CROSS JOIN ${from}`;
    where.push(`(${src.openAt})`);
    at = "b.at";
  }

  const params = (): unknown[] => [range.tz, new Date(now), new Date(range.lo), new Date(range.hi), ...extra];

  const useDims = wantRows ? dims : [];
  const joins = new Set<string>();
  const laterals = new Set<string>();
  const keyExprs = useDims.map((d) => {
    if (def.basis === "snapshot" && HD_DIMENSIONS[d].kind === "time") return "b.key";
    const s = dimSql(d, src, at, opt, d === "vip" ? vip() : "");
    if (s.join) joins.add(s.join);
    if (s.lateral) laterals.add(s.lateral);
    return s.expr;
  });
  const fromSql = `${from} ${[...joins].join(" ")} ${[...laterals].join(" ")}`;
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const keyCols = keyExprs.map((e, i) => `${e} AS k${i}`);
  const groupSql = keyExprs.length ? `GROUP BY ${keyExprs.map((_, i) => i + 1).join(", ")}` : "";

  if (src.agg.kind === "durations") {
    const agg = src.agg;
    const sql = `SELECT ${[...keyCols, `${src.team} AS team_id`, `(extract(epoch FROM ${agg.a}) * 1000)::float8 AS a`, `(extract(epoch FROM ${agg.b}) * 1000)::float8 AS b`, agg.paused ? `${agg.paused} AS paused` : "0 AS paused"].join(", ")}
                   FROM ${fromSql} ${whereSql} LIMIT ${ENGINE_LIMITS.durationRows + 1}`;
    const res = await c.query(sql, params());
    const truncated = res.rows.length > ENGINE_LIMITS.durationRows;
    const list = res.rows.slice(0, ENGINE_LIMITS.durationRows);
    const clockFor = agg.business ? await clocksForTeams(new Set(list.map((r) => (r.team_id as number | null) ?? null))) : null;
    const minutesOf = (r: Record<string, unknown>): number => {
      // Epoch milliseconds from SQL: no Date parsing for 20,000 rows.
      const a = Number(r.a);
      const b = Number(r.b);
      if (!(b > a)) return 0;
      if (!clockFor) return (b - a) / 60_000;
      const business = clockFor((r.team_id as number | null) ?? null).minutesBetween(a, b);
      const paused = Math.min(b - a, Number(r.paused) || 0);
      return Math.max(0, business * (1 - paused / Math.max(1, b - a)));
    };
    const groups = new Map<string, { keys: HdKey[]; values: number[] }>();
    const all: number[] = [];
    for (const r of list) {
      const v = minutesOf(r);
      all.push(v);
      if (!useDims.length) continue;
      const keys = useDims.map((_, i) => normKey(r[`k${i}`]));
      const k = JSON.stringify(keys);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { keys, values: [] }));
      g.values.push(v);
    }
    return {
      rows: [...groups.values()].map((g) => ({ keys: g.keys, v: statOf(g.values, agg.stat), n: g.values.length })),
      total: { value: statOf(all, agg.stat), n: all.length },
      truncated,
    };
  }

  let valueSql: string;
  if (src.agg.kind === "count") valueSql = "count(*)::float8";
  else if (src.agg.kind === "pct") valueSql = `round((100.0 * count(*) FILTER (WHERE ${src.agg.num}) / NULLIF(count(*), 0))::numeric, 1)::float8`;
  else if (src.agg.kind === "sum") valueSql = `COALESCE(sum(${src.agg.expr}), 0)::float8`;
  else valueSql = `round(avg(${src.agg.expr})::numeric, 2)::float8`;
  const sql = `SELECT ${[...keyCols, `${valueSql} AS v`, "count(*)::int AS n"].join(", ")} FROM ${fromSql} ${whereSql} ${groupSql} LIMIT ${ENGINE_LIMITS.groupRows + 1}`;
  const res = await c.query(sql, params());
  const truncated = res.rows.length > ENGINE_LIMITS.groupRows;
  const rows: RawRow[] = res.rows.slice(0, ENGINE_LIMITS.groupRows).map((r) => ({
    keys: useDims.map((_, i) => normKey(r[`k${i}`])),
    v: r.v === null ? null : Number(r.v),
    n: Number(r.n),
  }));
  if (!useDims.length) {
    const r = rows[0];
    const n = r?.n ?? 0;
    return { rows: [], total: { value: src.agg.kind === "count" ? n : r?.v ?? null, n }, truncated };
  }
  // A total over the same filter without the split (tags would double count; percentages don't add).
  let total: { value: number | null; n: number };
  if (src.agg.kind === "count" && !useDims.includes("tag") && def.basis !== "snapshot") {
    const n = rows.reduce((s, r) => s + r.n, 0);
    total = { value: n, n };
  } else {
    const t = await compute(c, measure, [], filters, scope, range, now, false, automated);
    total = t.total;
  }
  return { rows, total, truncated };
}

function normKey(v: unknown): HdKey {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// --- Labels -------------------------------------------------------------------------------------------

async function labelMaps(c: PoolClient, dims: HdDimension[], rows: RawRow[]): Promise<((key: HdKey) => string)[]> {
  return Promise.all(
    dims.map(async (d, i) => {
      const keys = [...new Set(rows.map((r) => r.keys[i]).filter((k): k is number | string => k !== null && k !== ""))];
      let map = new Map<string, string>();
      if (keys.length && d === "integration") {
        const ids = keys.map(Number).filter((n) => Number.isSafeInteger(n));
        if ((await optionalColumns(c)).integrations) {
          const res = await c.query("SELECT id, to_jsonb(i) ->> 'name' AS label FROM hd_integrations i WHERE id = ANY($1::int[])", [ids]);
          map = new Map(res.rows.filter((r) => r.label).map((r) => [String(r.id), String(r.label)]));
        }
      } else if (keys.length && (d === "team" || d === "assignee" || d === "request_type" || d === "workflow")) {
        const ids = keys.map(Number).filter((n) => Number.isSafeInteger(n));
        const sql =
          d === "team"
            ? "SELECT id, name AS label FROM hd_teams WHERE id = ANY($1::int[])"
            : d === "assignee"
              ? "SELECT id, COALESCE(NULLIF(name, ''), username) AS label FROM users WHERE id = ANY($1::int[])"
              : d === "request_type"
                ? "SELECT id, title AS label FROM hd_request_types WHERE id = ANY($1::int[])"
                : "SELECT id, title AS label FROM hd_workflows WHERE id = ANY($1::int[])";
        const res = await c.query(sql, [ids]);
        map = new Map(res.rows.map((r) => [String(r.id), String(r.label)]));
      } else if (keys.length && d === "workflow_step") {
        const ids = [...new Set(keys.map((k) => Number(String(k).split(":")[0])).filter((n) => Number.isSafeInteger(n)))];
        const res = await c.query("SELECT id, title, definition FROM hd_workflows WHERE id = ANY($1::int[])", [ids]);
        for (const w of res.rows) {
          const walk = (steps: unknown) => {
            if (!Array.isArray(steps)) return;
            for (const s of steps as { key?: string; title?: string; steps?: unknown }[]) {
              if (s?.key) map.set(`${w.id}:${s.key}`, `${w.title} · ${s.title || s.key}`);
              walk(s?.steps);
            }
          };
          walk((w.definition as { steps?: unknown })?.steps);
        }
      }
      return (key: HdKey) => {
        if (key === null || key === "") return codeLabel(d, key);
        const hit = map.get(String(key));
        if (hit) return hit;
        if (d === "team" || d === "assignee" || d === "request_type" || d === "workflow") return d === "assignee" ? "Former agent" : `Deleted (${key})`;
        if (d === "workflow_step") return String(key).split(":").slice(1).join(":");
        if (d === "integration") return `Integration ${key}`;
        return codeLabel(d, key);
      };
    })
  );
}

// --- Shaping --------------------------------------------------------------------------------------------

const OTHER = "__other__";

function shapeRows(
  measure: HdMeasureKey,
  dims: HdDimension[],
  raw: RawRow[],
  range: ResolvedRange,
  limit: number,
  now: number
): { rows: RawRow[]; truncated: boolean } {
  const def: HdMeasureDef = HD_MEASURES[measure];
  const isCount = def.unit === "count";
  let rows = raw;
  let truncated = false;
  const cat = (i: number) => HD_DIMENSIONS[dims[i]].kind === "category";

  // Fold the long tail of a categorical split into "Other" (counts) or cut it (others).
  const foldDim = (i: number, keep: number) => {
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(JSON.stringify(r.keys[i]), (totals.get(JSON.stringify(r.keys[i])) ?? 0) + (isCount ? r.v ?? 0 : r.n));
    if (totals.size <= keep) return;
    truncated = true;
    const kept = new Set([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, keep).map(([k]) => k));
    if (!isCount) {
      rows = rows.filter((r) => kept.has(JSON.stringify(r.keys[i])));
      return;
    }
    const merged = new Map<string, RawRow>();
    for (const r of rows) {
      const keys = [...r.keys];
      if (!kept.has(JSON.stringify(keys[i]))) keys[i] = OTHER;
      const k = JSON.stringify(keys);
      const m = merged.get(k);
      if (m) {
        m.v = (m.v ?? 0) + (r.v ?? 0);
        m.n += r.n;
      } else merged.set(k, { keys, v: r.v, n: r.n });
    }
    rows = [...merged.values()];
  };
  if (dims.length === 2 && cat(1)) foldDim(1, 7);
  if (dims.length >= 1 && cat(0)) foldDim(0, limit);

  // Zero-fill time and cycle buckets so a chart has every point.
  const fillKeys = (i: number): HdKey[] | null => {
    const d = dims[i];
    if (d === "day" || d === "week" || d === "month") {
      let keys: HdKey[] = timeKeys(d, range.from, range.to);
      if (def.basis === "snapshot") keys = keys.filter((k) => dayStart(String(k).length === 7 ? `${k}-01` : String(k), range.tz) <= Math.max(now, range.lo));
      return keys;
    }
    if (d === "weekday") return [1, 2, 3, 4, 5, 6, 7];
    if (d === "hour") return Array.from({ length: 24 }, (_, h) => h);
    return null;
  };
  const f0 = dims.length ? fillKeys(0) : null;
  const f1 = dims.length === 2 ? fillKeys(1) : null;
  if (f0 || f1) {
    const have = new Map(rows.map((r) => [JSON.stringify(r.keys), r]));
    const first = f0 ?? [...new Set(rows.map((r) => r.keys[0]))];
    const second = dims.length === 2 ? f1 ?? [...new Set(rows.map((r) => r.keys[1]))] : [undefined];
    const filled: RawRow[] = [];
    for (const a of first) {
      for (const b of second) {
        const keys = b === undefined ? [a] : [a, b];
        filled.push(have.get(JSON.stringify(keys)) ?? { keys, v: isCount ? 0 : null, n: 0 });
      }
    }
    // Keep rows whose time key fell outside the filled set (a week straddling the start) out.
    rows = filled;
  }

  // Order: time and cycles ascending; categories largest first, "Other" last.
  const timeLike = (i: number) => !cat(i);
  rows.sort((x, y) => {
    for (let i = 0; i < dims.length; i++) {
      if (timeLike(i)) {
        const a = x.keys[i];
        const b = y.keys[i];
        if (a !== b) return String(a).localeCompare(String(b), undefined, { numeric: true });
      }
    }
    if (x.keys.includes(OTHER) !== y.keys.includes(OTHER)) return x.keys.includes(OTHER) ? 1 : -1;
    return (y.v ?? -Infinity) - (x.v ?? -Infinity);
  });
  return { rows, truncated };
}

// --- Cache ------------------------------------------------------------------------------------------------

const cache = new Map<string, { at: number; ttl: number; value: HdQueryResult }>();

/** Forget cached results (tests; after a bulk import). */
export function clearAnalyticsCache(): void {
  cache.clear();
}

// --- The query API -----------------------------------------------------------------------------------------

export class AnalyticsError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Run one report query for a viewer. Throws AnalyticsError (400 for a bad
 * range, 403 for no report capability). `opts.scope` lets a caller that has
 * already resolved it (a dashboard of many widgets, a digest) skip the
 * capability lookups.
 */
export async function runQuery(
  q: HdAnalyticsQuery,
  viewer: Viewer,
  opts: RunOpts & { scope?: ReportScope } = {}
): Promise<HdQueryResult> {
  const scope = opts.scope ?? (await reportScope(viewer));
  if (!scope) throw new AnalyticsError("You don't have permission to read reports.", 403);
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? (await reportTimezone());
  const def: HdMeasureDef = HD_MEASURES[q.measure];
  const dims = q.groupBy ?? [];
  const filters = q.filters ?? {};
  const limit = q.limit ?? 50;
  const compare = def.basis === "live" ? null : q.compare ?? null;
  // Splitting by origin or integration only makes sense with the automated tickets in.
  const automated = q.automated === true || dims.includes("origin") || dims.includes("integration");

  const resolved = resolveRange(q.range, tz, now);
  if (!resolved.ok) throw new AnalyticsError(resolved.error);
  const range = resolved.range;

  const key = JSON.stringify([q.measure, dims, filters, range.from, range.to, tz, compare, limit, automated, scopeKey(scope)]);
  const hit = cache.get(key);
  if (!opts.fresh && opts.now === undefined && hit && now - hit.at < hit.ttl) return { ...hit.value, cached: true };

  const result = await readOnly(async (c) => {
    const main = await compute(c, q.measure, dims, filters, scope, range, now, true, automated);
    const shaped = shapeRows(q.measure, dims, main.rows, range, limit, now);
    const labels = await labelMaps(c, dims, shaped.rows);
    const label = (r: RawRow): HdResultRow => ({
      keys: r.keys,
      labels: r.keys.map((k, i) => (k === OTHER ? "Other" : labels[i](k))),
      value: r.v,
      n: r.n,
    });
    const out: HdQueryResult = {
      measure: q.measure,
      unit: def.unit,
      groupBy: dims,
      range: { from: range.from, to: range.to, timezone: tz, label: range.label },
      rows: shaped.rows.map(label),
      total: main.total,
      truncated: main.truncated || shaped.truncated,
      generated_at: new Date(now).toISOString(),
      cached: false,
      low_sample: def.unit !== "count" && main.total.n > 0 && main.total.n < 5,
    };
    if (compare) {
      const cd = compareDates(range, compare);
      const cr = fromDates(cd.from, cd.to, tz, "");
      const oneTime = dims.length === 1 && HD_DIMENSIONS[dims[0]].kind === "time";
      const prev = await compute(c, q.measure, oneTime ? dims : [], filters, scope, cr, now, oneTime, automated);
      const delta = out.total.value !== null && prev.total.value !== null ? round2(out.total.value - prev.total.value) : null;
      const deltaPct = delta !== null && prev.total.value ? round2((delta / Math.abs(prev.total.value)) * 100) : null;
      out.compare = { kind: compare, range: { from: cd.from, to: cd.to }, total: prev.total, delta, delta_pct: deltaPct };
      if (oneTime) {
        const ps = shapeRows(q.measure, dims, prev.rows, cr, limit, now);
        const pl = await labelMaps(c, dims, ps.rows);
        out.compare.rows = ps.rows.map((r) => ({ keys: r.keys, labels: r.keys.map((k, i) => pl[i](k)), value: r.v, n: r.n }));
      }
    }
    return out;
  });

  if (cache.size >= ENGINE_LIMITS.cacheEntries) {
    for (const [k, v] of cache) if (now - v.at >= v.ttl) cache.delete(k);
    if (cache.size >= ENGINE_LIMITS.cacheEntries) cache.delete(cache.keys().next().value as string);
  }
  if (opts.now === undefined) cache.set(key, { at: now, ttl: def.basis === "live" ? ENGINE_LIMITS.liveTtlMs : ENGINE_LIMITS.cacheTtlMs, value: result });
  return result;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Days in a resolved range (for labels). */
export function rangeDays(r: { from: string; to: string }): number {
  return daysBetween(r.from, r.to);
}
