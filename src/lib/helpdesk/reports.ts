// Helpdesk reports (1.19.0): the numbers behind /desk/reports and its CSV.
//
// One date range (inclusive days in the helpdesk's time zone, at most 366),
// optionally one team. Every ticket counts, workflow task tickets included
// (they are work the teams did); CSAT exists only on requests.
//
//   created / solved      tickets created in the range / solved in it
//   first reply median    business minutes from created to the first public
//                         agent reply, over tickets created in the range
//   resolution median     business minutes from created to solved, less the
//                         time spent paused (Waiting on requester, On hold),
//                         over tickets solved in the range
//   SLA met %             tickets with an SLA target due in the range (and
//                         already decided: met, or past due) that met every
//                         such target
//   CSAT                  ratings given in the range: % good (4 or 5),
//                         average, responses
//   series                one point per day, per ISO week past 92 days
//   merged (1.19.1)       a ticket merged into another counts as created,
//                         never as solved, and has no resolution target
//   by team / agent /     the same counts split; an agent is the ticket's
//   category              assignee
//
// Business time is each ticket's team calendar (agent L's per-team hours;
// the helpdesk's hours until that lands; see teamHoursResolver), so a ticket
// raised on Friday at 17:00 and answered on Monday at 09:30 took 60 business
// minutes with the default hours. Server-only.

import "server-only";
import { hq } from "./db-core";
import { getBusinessHours } from "./settings";
import { businessMinutesBetween, wallClock, zonedInstant } from "./sla";
import { csvCell } from "../csv";
import type { HdBusinessHours, HdReportSummary } from "./types";

export const REPORT_MAX_DAYS = 366;

/** The summary plus the CSAT average the contract's type does not carry yet (for A to merge). */
export interface HdReportSummaryC extends HdReportSummary {
  csat_average: number | null;
}

export interface ReportRange {
  /** "YYYY-MM-DD", inclusive, in the helpdesk's time zone. */
  from: string;
  to: string;
  team_id?: number | null;
  /** Only tickets assigned to this person ("my stats", reports.own). */
  assignee_id?: number | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function ymd(t: number, tz: string): string {
  const w = wallClock(t, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

function dayStart(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return zonedInstant(y, m, d, 0, 0, tz);
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/**
 * Parse ?from=&to= (defaults: the last 30 days to today). Errors are
 * messages for a 400.
 */
export function parseReportRange(
  params: URLSearchParams,
  tz: string,
  now = Date.now()
): { ok: true; range: ReportRange } | { ok: false; error: string } {
  const today = ymd(now, tz);
  const to = params.get("to") || today;
  const from = params.get("from") || addDays(to, -29);
  if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return { ok: false, error: "Dates must look like 2026-11-06." };
  }
  if (from > to) return { ok: false, error: "The start date is after the end date." };
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (days > REPORT_MAX_DAYS) return { ok: false, error: `Choose a range of up to ${REPORT_MAX_DAYS} days.` };
  const team = params.get("team");
  let team_id: number | null = null;
  if (team) {
    team_id = Number(team);
    if (!Number.isInteger(team_id) || team_id <= 0) return { ok: false, error: "Unknown team." };
  }
  const agent = params.get("agent");
  if (agent && agent !== "me") return { ok: false, error: "agent can only be me." };
  return { ok: true, range: { from, to, team_id, ...(agent === "me" ? { own: true } : {}) } as ReportRange & { own?: boolean } };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

const pct = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : null);

export interface Row {
  id: number;
  team_id: number | null;
  team_name: string | null;
  assignee_id: number | null;
  assignee_name: string | null;
  category: string;
  /** 1.20.6 */
  subcategory?: string;
  created_at: string;
  first_replied_at: string | null;
  solved_at: string | null;
  first_reply_due: string | null;
  resolve_due: string | null;
  sla_paused_ms: number;
  csat_score: number | null;
  csat_at: string | null;
  /** 1.19.1: set on a ticket merged into another; it closed, it was never solved. */
  merged_into?: number | null;
}

/** Business minutes from created to solved, less the paused share (pauses are stored as wall-clock ms). */
export function resolutionMinutes(r: Row, hours: HdBusinessHours): number {
  const a = Date.parse(r.created_at);
  const b = Date.parse(r.solved_at!);
  const business = businessMinutesBetween(a, b, hours);
  const wall = Math.max(1, b - a);
  const paused = Math.min(wall, Number(r.sla_paused_ms) || 0);
  return Math.max(0, business * (1 - paused / wall));
}

/** Whether a ticket's targets that fell in [lo, hi) were met; null when none did (or none is decided yet). */
function slaOutcome(r: Row, lo: number, hi: number, now: number): boolean | null {
  let any = false;
  let met = true;
  const check = (due: string | null, doneAt: string | null) => {
    if (!due) return;
    const d = Date.parse(due);
    if (d < lo || d >= hi) return;
    const done = doneAt ? Date.parse(doneAt) : null;
    if (done !== null && done <= d) {
      any = true;
      return;
    }
    if (done !== null || now > d) {
      any = true;
      met = false;
    }
  };
  check(r.first_reply_due, r.first_replied_at);
  // A merged ticket's resolution target is not met or missed by the merge (its work goes on in the other ticket).
  if (r.merged_into == null) check(r.resolve_due, r.solved_at);
  return any ? met : null;
}

/**
 * Business hours per team (lib/helpdesk/calendars hoursForTeam), cached
 * for one report; the pure businessMinutesBetween does the counting. Tests
 * pass `fixed` hours and never reach the calendars.
 */
export function teamHoursResolver(fallback: HdBusinessHours, fixed = false): (teamId: number | null) => Promise<HdBusinessHours> {
  const cache = new Map<number | null, Promise<HdBusinessHours>>();
  return (teamId) => {
    if (fixed) return Promise.resolve(fallback);
    let p = cache.get(teamId);
    if (!p) {
      p = import("./calendars").then((m) => m.hoursForTeam(teamId));
      cache.set(teamId, p);
    }
    return p;
  };
}

/** Business minutes between two instants for a ticket of `teamId`. */
export async function businessMinutesForTeam(
  resolve: (teamId: number | null) => Promise<HdBusinessHours>,
  teamId: number | null,
  a: number,
  b: number
): Promise<number> {
  return businessMinutesBetween(a, b, await resolve(teamId));
}

/** The report for a range. `opts.hours` (one calendar for every team) and `opts.now` are for tests. */
export async function reportSummary(range: ReportRange, opts: { hours?: HdBusinessHours; now?: number } = {}): Promise<HdReportSummaryC> {
  const hours = opts.hours ?? (await getBusinessHours());
  const hoursFor = teamHoursResolver(hours, Boolean(opts.hours));
  const now = opts.now ?? Date.now();
  const tz = hours.timezone;
  const lo = dayStart(range.from, tz);
  const hi = dayStart(addDays(range.to, 1), tz);
  const loIso = new Date(lo).toISOString();
  const hiIso = new Date(hi).toISOString();
  const params: unknown[] = [loIso, hiIso];
  let teamSql = "";
  if (range.team_id) {
    params.push(range.team_id);
    teamSql += ` AND t.team_id = $${params.length}`;
  }
  if (range.assignee_id) {
    params.push(range.assignee_id);
    teamSql += ` AND t.assignee_id = $${params.length}`;
  }
  // Every ticket the range touches: created, solved, rated or due in it.
  const rows = await hq<Row>(
    `SELECT t.id, t.team_id, tm.name AS team_name, t.assignee_id, COALESCE(NULLIF(u.name, ''), u.username) AS assignee_name,
            t.category, t.subcategory, t.created_at, t.first_replied_at, t.solved_at, t.first_reply_due, t.resolve_due,
            t.sla_paused_ms, t.csat_score, t.csat_at, t.merged_into
       FROM hd_tickets t
       LEFT JOIN hd_teams tm ON tm.id = t.team_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ((t.created_at >= $1 AND t.created_at < $2)
          OR (t.solved_at >= $1 AND t.solved_at < $2)
          OR (t.csat_at >= $1 AND t.csat_at < $2)
          OR (t.first_reply_due >= $1 AND t.first_reply_due < $2)
          OR (t.resolve_due >= $1 AND t.resolve_due < $2))
        AND t.deleted_at IS NULL -- 1.19.4 (C7): not a ticket in the recycle bin
        ${teamSql}
      LIMIT 200000`,
    params
  );
  const inRange = (iso: string | null) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return t >= lo && t < hi;
  };

  // Each ticket's calendar, looked up once per team.
  const rowHours = new Map<number, HdBusinessHours>();
  for (const r of rows) rowHours.set(r.id, await hoursFor(r.team_id));
  const hoursOf = (r: Row) => rowHours.get(r.id) ?? hours;
  const created = rows.filter((r) => inRange(r.created_at));
  // 1.19.1: a ticket merged into another closed without being solved, so it never counts as solved.
  const solved = rows.filter((r) => r.merged_into == null && inRange(r.solved_at));
  const firstReplyMins = (list: Row[]) =>
    list.filter((r) => r.first_replied_at).map((r) => businessMinutesBetween(Date.parse(r.created_at), Date.parse(r.first_replied_at!), hoursOf(r)));
  const slaList = rows.map((r) => ({ r, met: slaOutcome(r, lo, hi, now) })).filter((x) => x.met !== null);
  const rated = rows.filter((r) => r.csat_score != null && inRange(r.csat_at));
  const good = (list: Row[]) => list.filter((r) => (r.csat_score ?? 0) >= 4).length;

  // Series: days, or ISO weeks (Monday) beyond 92 days.
  const totalDays = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
  const weekly = totalDays > 92;
  const bucket = (iso: string) => {
    const day = ymd(Date.parse(iso), tz);
    if (!weekly) return day;
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
    return addDays(day, 1 - dow);
  };
  const series = new Map<string, { date: string; created: number; solved: number }>();
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    const key = weekly ? bucket(`${d}T12:00:00Z`) : d;
    if (!series.has(key)) series.set(key, { date: key, created: 0, solved: 0 });
  }
  for (const r of created) series.get(bucket(r.created_at)) && series.get(bucket(r.created_at))!.created++;
  for (const r of solved) series.get(bucket(r.solved_at!)) && series.get(bucket(r.solved_at!))!.solved++;

  // By team.
  const teams = new Map<string, { team_id: number | null; name: string; created: number; solved: number; met: number; slaN: number }>();
  const teamOf = (r: Row) => {
    const k = String(r.team_id ?? "none");
    if (!teams.has(k)) teams.set(k, { team_id: r.team_id, name: r.team_name ?? "No team", created: 0, solved: 0, met: 0, slaN: 0 });
    return teams.get(k)!;
  };
  for (const r of created) teamOf(r).created++;
  for (const r of solved) teamOf(r).solved++;
  for (const { r, met } of slaList) {
    const t = teamOf(r);
    t.slaN++;
    if (met) t.met++;
  }

  // By agent (assignee).
  const agents = new Map<number, { user_id: number; name: string; solved: number; replies: number[]; rated: number; good: number }>();
  const agentOf = (r: Row) => {
    if (r.assignee_id == null) return null;
    if (!agents.has(r.assignee_id)) agents.set(r.assignee_id, { user_id: r.assignee_id, name: r.assignee_name ?? "Unknown", solved: 0, replies: [], rated: 0, good: 0 });
    return agents.get(r.assignee_id)!;
  };
  for (const r of solved) {
    const a = agentOf(r);
    if (a) a.solved++;
  }
  for (const r of created) {
    const a = agentOf(r);
    if (a && r.first_replied_at) a.replies.push(businessMinutesBetween(Date.parse(r.created_at), Date.parse(r.first_replied_at), hoursOf(r)));
  }
  for (const r of rated) {
    const a = agentOf(r);
    if (!a) continue;
    a.rated++;
    if ((r.csat_score ?? 0) >= 4) a.good++;
  }

  // By category.
  const cats = new Map<string, { category: string; created: number; solved: number }>();
  const catOf = (r: Row) => {
    const k = r.category || "";
    if (!cats.has(k)) cats.set(k, { category: k, created: 0, solved: 0 });
    return cats.get(k)!;
  };
  for (const r of created) catOf(r).created++;
  for (const r of solved) catOf(r).solved++;
  // 1.20.6: and by sub-category, for the tickets that have one (lib/helpdesk/categories).
  const subs = new Map<string, { category: string; subcategory: string; created: number; solved: number }>();
  const subOf = (r: Row) => {
    const k = `${r.category}\u0000${r.subcategory}`;
    if (!subs.has(k)) subs.set(k, { category: r.category, subcategory: r.subcategory ?? "", created: 0, solved: 0 });
    return subs.get(k)!;
  };
  for (const r of created) if (r.subcategory) subOf(r).created++;
  for (const r of solved) if (r.subcategory) subOf(r).solved++;

  const csatSum = rated.reduce((s, r) => s + (r.csat_score ?? 0), 0);
  return {
    from: range.from,
    to: range.to,
    created: created.length,
    solved: solved.length,
    first_reply_median_minutes: median(firstReplyMins(created)),
    resolution_median_minutes: median(solved.map((r) => resolutionMinutes(r, hoursOf(r)))),
    sla_met_percent: pct(slaList.filter((x) => x.met).length, slaList.length),
    csat_percent: pct(good(rated), rated.length),
    csat_responses: rated.length,
    csat_average: rated.length ? Math.round((csatSum / rated.length) * 100) / 100 : null,
    series: [...series.values()].sort((a, b) => a.date.localeCompare(b.date)),
    by_team: [...teams.values()]
      .map((t) => ({ team_id: t.team_id, name: t.name, created: t.created, solved: t.solved, sla_met_percent: pct(t.met, t.slaN) }))
      .sort((a, b) => b.created - a.created || a.name.localeCompare(b.name)),
    by_agent: [...agents.values()]
      .map((a) => ({ user_id: a.user_id, name: a.name, solved: a.solved, first_reply_median_minutes: median(a.replies), csat_percent: pct(a.good, a.rated) }))
      .sort((a, b) => b.solved - a.solved || a.name.localeCompare(b.name)),
    by_category: [...cats.values()].sort((a, b) => b.created - a.created || a.category.localeCompare(b.category)),
    by_subcategory: [...subs.values()].sort((a, b) => b.created - a.created || a.category.localeCompare(b.category) || a.subcategory.localeCompare(b.subcategory)),
  };
}

/** The report as one CSV: a summary block, then the series and each breakdown, separated by blank lines. */
export function reportCsv(r: HdReportSummaryC): string {
  const line = (cells: unknown[]) => cells.map(csvCell).join(",");
  const out: string[] = [];
  out.push("Metric,Value");
  out.push(line(["From", r.from]));
  out.push(line(["To", r.to]));
  out.push(line(["Created", r.created]));
  out.push(line(["Solved", r.solved]));
  out.push(line(["First reply median (business minutes)", r.first_reply_median_minutes ?? ""]));
  out.push(line(["Resolution median (business minutes)", r.resolution_median_minutes ?? ""]));
  out.push(line(["SLA met (%)", r.sla_met_percent ?? ""]));
  out.push(line(["CSAT good (%)", r.csat_percent ?? ""]));
  out.push(line(["CSAT average (1-5)", r.csat_average ?? ""]));
  out.push(line(["CSAT responses", r.csat_responses]));
  out.push("");
  out.push("Date,Created,Solved");
  for (const p of r.series) out.push(line([p.date, p.created, p.solved]));
  out.push("");
  out.push("Team,Created,Solved,SLA met (%)");
  for (const t of r.by_team) out.push(line([t.name, t.created, t.solved, t.sla_met_percent ?? ""]));
  out.push("");
  out.push("Agent,Solved,First reply median (business minutes),CSAT good (%)");
  for (const a of r.by_agent) out.push(line([a.name, a.solved, a.first_reply_median_minutes ?? "", a.csat_percent ?? ""]));
  out.push("");
  out.push("Category,Created,Solved");
  for (const c of r.by_category) out.push(line([c.category || "(none)", c.created, c.solved]));
  // 1.20.6: a block per sub-category, only while any ticket in the range has one.
  if (r.by_subcategory?.length) {
    out.push("");
    out.push("Category,Sub-category,Created,Solved");
    for (const c of r.by_subcategory) out.push(line([c.category, c.subcategory, c.created, c.solved]));
  }
  return out.join("\r\n") + "\r\n";
}
