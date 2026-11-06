// Helpdesk 1.19.0 reports (agent K): report schedules. A schedule sends a
// dashboard's summary by email on a cadence (./schedule-time) to people and
// whole teams. Each recipient gets the numbers of their own report scope
// (a team lead sees their teams; someone without a report capability gets
// nothing), through the hd_report_digest template and C's
// sendHelpdeskEmail. "csv" and "pdf" add a link to the export, which asks
// the reader to sign in and checks tickets.export as usual.
//
// Who may schedule: a dashboard's editors, reports.all, or a desk Manager
// or Admin; anyone who can see a dashboard may schedule it to themselves
// alone.
//
// The periodic hook (A's lib/periodic HELPDESK_SWEEPS, one entry):
//   { name: "hd_report_schedules", run: async (now) => (await import("./helpdesk/analytics/schedules")).sendDueReportSchedules(now) },
// Every instance may run it: a schedule is claimed by moving last_sent_at
// under its old value, so a slot is sent once. Server-only.

import "server-only";
import { hq, hqOne } from "../db-core";
import { logEvent } from "../../log";
import { sendHelpdeskEmail } from "../email";
import { emailGate } from "../../notify-policy";
import { DashboardError, dashboardById, dashboardRights, ensureAnalyticsSchema, getDashboard, viewerCanSee } from "./store";
import { reportScope, type Viewer } from "./engine";
import { reportTimezone } from "./hours";
import { digestSummary, runDashboard } from "./export";
import { digestPeriod, isDue, latestSlot, nextSlot, type HdFrequency, type HdRecipients, type HdReportSchedule, type HdScheduleFormat } from "./schedule-time";
import type { Role } from "../../types";

export type { HdRecipients, HdReportSchedule } from "./schedule-time";

export const SCHEDULE_LIMITS = { users: 50, teams: 20, perDashboard: 20 } as const;

interface Row {
  id: number;
  dashboard_id: number;
  dashboard_name: string;
  created_by: number | null;
  created_by_name: string | null;
  recipients: HdRecipients;
  frequency: HdFrequency;
  weekday: number;
  hour: number;
  format: HdScheduleFormat;
  last_sent_at: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const COLS = `s.id, s.dashboard_id, d.name AS dashboard_name, s.created_by, COALESCE(NULLIF(u.name, ''), u.username) AS created_by_name,
  s.recipients, s.frequency, s.weekday, s.hour, s.format, s.last_sent_at, s.enabled, s.created_at, s.updated_at`;
const FROM = `hd_report_schedules s JOIN hd_dashboards d ON d.id = s.dashboard_id LEFT JOIN users u ON u.id = s.created_by`;

function recipientsOf(raw: unknown): HdRecipients {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : []);
  return { users: ids(r.users), teams: ids(r.teams) };
}

async function shapeAll(rows: Row[], tz: string, now = Date.now()): Promise<HdReportSchedule[]> {
  const userIds = [...new Set(rows.flatMap((r) => recipientsOf(r.recipients).users))];
  const teamIds = [...new Set(rows.flatMap((r) => recipientsOf(r.recipients).teams))];
  const [users, teams] = await Promise.all([
    userIds.length ? hq<{ id: number; name: string }>("SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])", [userIds]) : [],
    teamIds.length ? hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE id = ANY($1::int[])", [teamIds]) : [],
  ]);
  const un = new Map(users.map((u) => [u.id, u.name]));
  const tn = new Map(teams.map((t) => [t.id, t.name]));
  return rows.map((r) => {
    const rec = recipientsOf(r.recipients);
    return {
      ...r,
      recipients: rec,
      recipient_labels: {
        users: rec.users.filter((id) => un.has(id)).map((id) => ({ id, name: un.get(id)! })),
        teams: rec.teams.filter((id) => tn.has(id)).map((id) => ({ id, name: tn.get(id)! })),
      },
      next_at: new Date(nextSlot(r, tz, now)).toISOString(),
    };
  });
}

// --- Rules -----------------------------------------------------------------------------------

async function canManageSchedules(dashboardId: number, viewer: Viewer): Promise<{ manage: boolean; seen: boolean }> {
  const d = await getDashboard(dashboardId, viewer);
  if (!d) return { manage: false, seen: false };
  const rights = await dashboardRights(viewer);
  return { manage: d.can_edit || rights.all || rights.manager, seen: true };
}

export interface ScheduleInput {
  dashboard_id?: unknown;
  recipients?: unknown;
  frequency?: unknown;
  weekday?: unknown;
  hour?: unknown;
  format?: unknown;
  enabled?: unknown;
}

interface CleanSchedule {
  recipients?: HdRecipients;
  frequency?: HdFrequency;
  weekday?: number;
  hour?: number;
  format?: HdScheduleFormat;
  enabled?: number;
}

async function cleanSchedule(input: ScheduleInput, partial: boolean): Promise<CleanSchedule> {
  const out: CleanSchedule = {};
  if (input.recipients !== undefined || !partial) {
    const r = input.recipients && typeof input.recipients === "object" ? (input.recipients as Record<string, unknown>) : {};
    if ((Array.isArray(r.users) && r.users.length > SCHEDULE_LIMITS.users) || (Array.isArray(r.teams) && r.teams.length > SCHEDULE_LIMITS.teams)) {
      throw new DashboardError(`Send to up to ${SCHEDULE_LIMITS.users} people and ${SCHEDULE_LIMITS.teams} teams.`);
    }
    const rec = recipientsOf(r);
    rec.users = [...new Set(rec.users)];
    rec.teams = [...new Set(rec.teams)];
    if (!rec.users.length && !rec.teams.length) throw new DashboardError("Choose who gets it.");
    if (rec.users.length) {
      const found = await hq<{ id: number }>("SELECT id FROM users WHERE id = ANY($1::int[]) AND status = 'active'", [rec.users]);
      if (found.length !== rec.users.length) throw new DashboardError("Someone on the list has no active account.");
    }
    if (rec.teams.length) {
      const found = await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1::int[])", [rec.teams]);
      if (found.length !== rec.teams.length) throw new DashboardError("Unknown team.");
    }
    out.recipients = rec;
  }
  if (input.frequency !== undefined || !partial) {
    if (input.frequency !== "daily" && input.frequency !== "weekly" && input.frequency !== "monthly") throw new DashboardError("Choose daily, weekly or monthly.");
    out.frequency = input.frequency;
  }
  if (input.weekday !== undefined || !partial) {
    const w = input.weekday === undefined ? 1 : Number(input.weekday);
    if (!Number.isInteger(w) || w < 1 || w > 7) throw new DashboardError("Pick a day of the week.");
    out.weekday = w;
  }
  if (input.hour !== undefined || !partial) {
    const h = input.hour === undefined ? 8 : Number(input.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new DashboardError("Pick an hour between 0 and 23.");
    out.hour = h;
  }
  if (input.format !== undefined || !partial) {
    const f = input.format ?? "email";
    if (f !== "email" && f !== "csv" && f !== "pdf") throw new DashboardError("Unknown format.");
    out.format = f;
  }
  if (input.enabled !== undefined) out.enabled = input.enabled === false || input.enabled === 0 ? 0 : 1;
  return out;
}

// --- CRUD -------------------------------------------------------------------------------------

/** Schedules the viewer manages (or created), optionally for one dashboard. */
export async function listSchedules(viewer: Viewer, dashboardId?: number): Promise<HdReportSchedule[]> {
  await ensureAnalyticsSchema();
  const rows = await hq<Row>(`SELECT ${COLS} FROM ${FROM} WHERE ($1::int IS NULL OR s.dashboard_id = $1) ORDER BY s.id LIMIT 500`, [dashboardId ?? null]);
  const kept: Row[] = [];
  const cache = new Map<number, boolean>();
  for (const r of rows) {
    if (r.created_by === viewer.id) {
      kept.push(r);
      continue;
    }
    if (!cache.has(r.dashboard_id)) cache.set(r.dashboard_id, (await canManageSchedules(r.dashboard_id, viewer)).manage);
    if (cache.get(r.dashboard_id)) kept.push(r);
  }
  return shapeAll(kept, await reportTimezone());
}

async function getRow(id: number): Promise<Row | undefined> {
  await ensureAnalyticsSchema();
  return hqOne<Row>(`SELECT ${COLS} FROM ${FROM} WHERE s.id = $1`, [id]);
}

function onlySelf(r: HdRecipients, viewer: Viewer): boolean {
  return r.teams.length === 0 && r.users.length === 1 && r.users[0] === viewer.id;
}

export async function createSchedule(viewer: Viewer, input: ScheduleInput): Promise<HdReportSchedule> {
  await ensureAnalyticsSchema();
  const dashboardId = Number(input.dashboard_id);
  if (!Number.isSafeInteger(dashboardId) || dashboardId <= 0) throw new DashboardError("Pick a dashboard.");
  const { manage, seen } = await canManageSchedules(dashboardId, viewer);
  if (!seen) throw new DashboardError("That dashboard doesn't exist.", 404);
  const c = await cleanSchedule(input, false);
  if (!manage && !onlySelf(c.recipients!, viewer)) throw new DashboardError("You can schedule this dashboard to yourself only.", 403);
  const count = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_report_schedules WHERE dashboard_id = $1", [dashboardId]);
  if ((count?.n ?? 0) >= SCHEDULE_LIMITS.perDashboard) throw new DashboardError(`A dashboard can have up to ${SCHEDULE_LIMITS.perDashboard} schedules.`);
  const r = await hqOne<{ id: number }>(
    `INSERT INTO hd_report_schedules (dashboard_id, created_by, recipients, frequency, weekday, hour, format, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [dashboardId, viewer.id, JSON.stringify(c.recipients), c.frequency, c.weekday, c.hour, c.format, c.enabled ?? 1]
  );
  return (await shapeAll([(await getRow(r!.id))!], await reportTimezone()))[0];
}

async function editableSchedule(id: number, viewer: Viewer): Promise<Row> {
  const row = await getRow(id);
  if (!row) throw new DashboardError("That schedule doesn't exist.", 404);
  if (row.created_by === viewer.id && (await getDashboard(row.dashboard_id, viewer))) return row;
  const { manage } = await canManageSchedules(row.dashboard_id, viewer);
  if (!manage) throw new DashboardError("That schedule doesn't exist.", 404);
  return row;
}

export async function updateSchedule(id: number, viewer: Viewer, input: ScheduleInput): Promise<{ before: HdReportSchedule; after: HdReportSchedule }> {
  const row = await editableSchedule(id, viewer);
  const c = await cleanSchedule(input, true);
  if (c.recipients) {
    const { manage } = await canManageSchedules(row.dashboard_id, viewer);
    if (!manage && !onlySelf(c.recipients, viewer)) throw new DashboardError("You can schedule this dashboard to yourself only.", 403);
  }
  await hq(
    `UPDATE hd_report_schedules SET recipients = COALESCE($2::jsonb, recipients), frequency = COALESCE($3, frequency),
            weekday = COALESCE($4, weekday), hour = COALESCE($5, hour), format = COALESCE($6, format), enabled = COALESCE($7, enabled),
            updated_at = now()
      WHERE id = $1`,
    [id, c.recipients ? JSON.stringify(c.recipients) : null, c.frequency ?? null, c.weekday ?? null, c.hour ?? null, c.format ?? null, c.enabled ?? null]
  );
  const tz = await reportTimezone();
  const [before, after] = await shapeAll([row, (await getRow(id))!], tz);
  return { before, after };
}

export async function deleteSchedule(id: number, viewer: Viewer): Promise<HdReportSchedule> {
  const row = await editableSchedule(id, viewer);
  await hq("DELETE FROM hd_report_schedules WHERE id = $1", [id]);
  return (await shapeAll([row], await reportTimezone()))[0];
}

// --- Sending -------------------------------------------------------------------------------------

/** Everyone a schedule reaches: its people and its teams' members, active, once each. */
export async function resolveRecipients(r: HdRecipients): Promise<Viewer[]> {
  const rows = await hq<{ id: number; role: Role }>(
    `SELECT DISTINCT u.id, u.role FROM users u
      WHERE u.status = 'active' AND (u.id = ANY($1::int[]) OR u.id IN (SELECT user_id FROM hd_team_members WHERE team_id = ANY($2::int[])))
      ORDER BY u.id LIMIT 500`,
    [r.users, r.teams]
  );
  return rows;
}

function periodLabel(from: string, to: string): string {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  return from === to ? f(from) : `${f(from)} to ${f(to)}`;
}

export interface SweepResult {
  due: number;
  sent: number;
  skipped: number;
}

/**
 * Send every schedule whose slot has come (the periodic hook). Claims each
 * by moving last_sent_at, then builds and sends each recipient's digest
 * with no database client held. `opts.only` limits it to some schedule ids
 * (tests).
 */
export async function sendDueReportSchedules(now: Date = new Date(), opts: { only?: number[] } = {}): Promise<SweepResult> {
  await ensureAnalyticsSchema();
  const tz = await reportTimezone();
  const t = now.getTime();
  const rows = await hq<Row>(
    `SELECT ${COLS} FROM ${FROM} WHERE s.enabled = 1 AND ($1::int[] IS NULL OR s.id = ANY($1::int[])) ORDER BY s.id LIMIT 500`,
    [opts.only ?? null]
  );
  const result: SweepResult = { due: 0, sent: 0, skipped: 0 };
  for (const r of rows) {
    if (!isDue(r, tz, t)) continue;
    result.due++;
    const slot = latestSlot(r, tz, t);
    const claimed = await hqOne<{ id: number }>(
      `UPDATE hd_report_schedules SET last_sent_at = $2 WHERE id = $1 AND last_sent_at IS NOT DISTINCT FROM $3::timestamptz RETURNING id`,
      [r.id, new Date(t), r.last_sent_at]
    );
    if (!claimed) continue;
    const d = await dashboardById(r.dashboard_id);
    if (!d) continue;
    const period = digestPeriod(r, tz, slot);
    const label = periodLabel(period.from, period.to);
    const recipients = await resolveRecipients(recipientsOf(r.recipients));
    // Agent I's notification policy: someone who turned report digests off by email gets none.
    const gate = await emailGate(recipients.map((v) => v.id), "hd_report_digest");
    for (const viewer of recipients) {
      try {
        if (!gate.allows(viewer.id)) {
          result.skipped++;
          continue;
        }
        if (!(await reportScope(viewer)) || !(await viewerCanSee(d, viewer))) {
          result.skipped++;
          continue;
        }
        const state = { filters: d.layout.filters, range: { from: period.from, to: period.to }, compare: "previous_period" as const, automated: d.layout.automated === true };
        const results = await runDashboard(d, viewer, state, { now: t });
        const qs = `from=${period.from}&to=${period.to}`;
        const download =
          r.format === "csv"
            ? `[Download the CSV](/api/helpdesk/analytics/dashboards/${d.id}/export?format=csv&${qs})`
            : r.format === "pdf"
              ? `[Download the PDF](/api/helpdesk/analytics/dashboards/${d.id}/export?format=pdf&${qs})`
              : "";
        const ok = await sendHelpdeskEmail(viewer.id, "hd_report_digest", {
          dashboard_name: d.name,
          period_label: label,
          summary: digestSummary(results),
          download_line: download,
          dashboard_url: `/desk/reports?d=${d.id}&${qs}`,
        });
        if (ok) result.sent++;
        else result.skipped++;
      } catch (e) {
        result.skipped++;
        logEvent("error", "helpdesk.report_digest_failed", { schedule: r.id, user: viewer.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return result;
}
