// Helpdesk 1.19.0: business calendars, holidays and per-team reply targets
// (agent L). Each team works to a calendar (hd_teams.calendar_id; none =
// the default calendar) and, optionally, its own targets per priority
// (hd_team_sla_targets; none = the workspace policy). Everything that times
// a ticket asks here: hoursForTicket / slaPolicyForTicket on create,
// priority change and resume (lib/helpdesk/tickets), transferDues on a team
// move, addTeamBusinessMinutes for workflow offsets, businessMinutesForTicket
// for reports. Edits re-time the open, running clocks they affect
// (recompute*: batches under an advisory lock, the business time already
// used kept, the rest counted in the new calendar or against the new target).
//
// Schema: lib/helpdesk/calendars-schema (HD_CALENDARS_SCHEMA, appended to
// lib/db's Helpdesk block, which boot runs under the schema lock and the
// guards; calendarsReady() runs no DDL). The first read also migrates the
// old single schedule in helpdesk_settings into the default calendar
// "Office hours" and the holiday set "Company holidays"; the settings'
// hours stay readable (deprecated) and follow the default calendar.
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { hq, hqOne, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import {
  CALENDAR_LIMITS,
  clockNoteWith,
  hoursFromCalendar,
  legacyFromSchedule,
  openStateWith,
  scheduleFromLegacy,
  targetPhrase,
  teamPhrase,
  validDate,
} from "./calendars-shared";
import type {
  HdCalendar,
  HdCalendarTeam,
  HdHoliday,
  HdHolidayInput,
  HdHolidaySet,
  HdTeamOpenState,
  HdTeamSlaTarget,
  HdTeamSlaView,
  HdWeekSchedule,
} from "./calendars-shared";
import { addBusinessMinutes, addPolicyMinutes, businessMinutesBetween, policyMinutesBetween } from "./sla";
import { HD_OPEN_STATUSES, HD_PAUSED_STATUSES, HD_PRIORITIES } from "./types";
import type { HdBusinessHours, HdPriority, HdSlaPolicy, HdTicketRow } from "./types";

export type { HdCalendar, HdHoliday, HdHolidaySet, HdTeamOpenState } from "./calendars-shared";

const MIN = 60_000;
/** lib/db's schema lock: our lazy schema waits for (and never races) the boot schema. */
const SCHEMA_LOCK = 728341;
/** One recompute batch at a time across instances. */
export const CALENDAR_RECOMPUTE_LOCK = 7_281_917;
const RECOMPUTE_BATCH = 200;

export const DEFAULT_CALENDAR_NAME = "Office hours";
export const DEFAULT_HOLIDAY_SET_NAME = "Company holidays";

// --- Schema and migration ------------------------------------------------------------

let readyPromise: Promise<void> | null = null;
/** True once calendarsReady() has finished in this process. */
let readyDone = false;

/** Wait for the boot schema and make sure a default calendar exists. Once per process. */
export function calendarsReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      // The tables come with lib/db's boot schema (HD_CALENDARS_SCHEMA is
      // in SCHEMA_SQL, run there under the schema lock with the column and
      // index guards): no DDL here, only the one-time default calendar.
      const { dbReady } = await import("../db");
      await dbReady();
      const { getHelpdeskSettings } = await import("./settings");
      const legacy = await getHelpdeskSettings().catch(() => null);
      await withTx(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]);
        const has = await client.query("SELECT 1 FROM hd_calendars WHERE is_default = 1");
        if (has.rowCount) return;
        // Migration: the single schedule in helpdesk_settings becomes the
        // default calendar, in its zone (the workspace's when none is stored).
        const tz = legacy?.timezone ?? "UTC";
        const schedule = scheduleFromLegacy(legacy?.days ?? [1, 2, 3, 4, 5], legacy?.start ?? "09:00", legacy?.end ?? "17:30");
        const cal = await client.query<{ id: number }>(
          `INSERT INTO hd_calendars (name, timezone, schedule, is_default) VALUES ($1, $2, $3::jsonb, 1)
           ON CONFLICT (name) DO UPDATE SET is_default = 1, updated_at = now() RETURNING id`,
          [DEFAULT_CALENDAR_NAME, tz, JSON.stringify(schedule)]
        );
        const set = await client.query<{ id: number }>(
          `INSERT INTO hd_holiday_sets (name, description) VALUES ($1, 'Moved from the helpdesk settings')
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [DEFAULT_HOLIDAY_SET_NAME]
        );
        for (const date of legacy?.holidays ?? []) {
          await client.query(
            "INSERT INTO hd_holidays (set_id, date, name) VALUES ($1, $2, 'Holiday') ON CONFLICT DO NOTHING",
            [set.rows[0].id, date]
          );
        }
        await client.query("INSERT INTO hd_calendar_holiday_sets (calendar_id, set_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
          cal.rows[0].id,
          set.rows[0].id,
        ]);
      });
    })().then(
      () => {
        readyDone = true;
      },
      (e) => {
        readyPromise = null;
        throw e;
      }
    );
  }
  return readyPromise;
}

async function cq<T = Record<string, unknown>>(sql: string, params: unknown[] = [], client?: HdQueryable): Promise<T[]> {
  // A caller holding a client (its transaction) never waits on calendarsReady(),
  // which takes pooled connections of its own: the tables come with lib/db's
  // boot schema, and until the one-time migration has run the reads find no
  // default calendar and fall back to the legacy settings hours.
  if (!client || readyDone) await calendarsReady();
  else void calendarsReady().catch(() => {});
  return hq<T>(sql, params, client);
}

// --- Rows -----------------------------------------------------------------------------

interface CalRow {
  id: number;
  name: string;
  timezone: string;
  schedule: HdWeekSchedule;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface HolidayRow {
  id: number;
  set_id: number;
  date: string;
  name: string;
  recurring_yearly: number;
  closed_from: string | null;
  closed_to: string | null;
}

const HOLIDAY_COLS = "id, set_id, to_char(date, 'YYYY-MM-DD') AS date, name, recurring_yearly, closed_from, closed_to";

function holidayOut(r: HolidayRow): HdHoliday {
  return { ...r, recurring_yearly: r.recurring_yearly === 1 };
}

// --- The snapshot (cached) ------------------------------------------------------------

export interface HdEffectiveSlaPolicy extends HdSlaPolicy {
  source: "team" | "workspace";
  /** The workspace policy row (hd_tickets.sla_policy_id); null when only the team has a target. */
  policy_id: number | null;
}

/** Everything timing needs, read in one go. */
export interface CalendarSnapshot {
  defaultId: number | null;
  calendars: Map<number, { row: CalRow; hours: HdBusinessHours; set_ids: number[] }>;
  teams: Map<number, { name: string; calendar_id: number | null }>;
  targets: Map<number, Map<HdPriority, HdTeamSlaTarget>>;
  workspace: Map<HdPriority, HdSlaPolicy>;
}

const SNAPSHOT_TTL_MS = 30_000;
/** `value` is set once `snap` has resolved: a transaction may reuse only that (see calendarSnapshot). */
let cached: { at: number; snap: Promise<CalendarSnapshot>; value?: CalendarSnapshot } | null = null;

/** Drop the cached calendars (after a calendar, holiday, team or target change). */
export function invalidateCalendarCache(): void {
  cached = null;
}

async function loadSnapshot(client?: HdQueryable): Promise<CalendarSnapshot> {
  // One query at a time: callers may already hold a pooled client (the pool has five).
  const cals = await cq<CalRow>("SELECT id, name, timezone, schedule, is_default, created_at, updated_at FROM hd_calendars ORDER BY is_default DESC, name", [], client);
  const links = await cq<{ calendar_id: number; set_id: number }>("SELECT calendar_id, set_id FROM hd_calendar_holiday_sets", [], client);
  const holidays = await cq<HolidayRow>(`SELECT ${HOLIDAY_COLS} FROM hd_holidays ORDER BY date`, [], client);
  const teams = await cq<{ id: number; name: string; calendar_id: number | null }>("SELECT id, name, calendar_id FROM hd_teams", [], client);
  const targets = await cq<HdTeamSlaTarget & { team_id: number }>(
    "SELECT team_id, priority, first_reply_minutes, resolve_minutes, business_hours FROM hd_team_sla_targets",
    [],
    client
  );
  const workspace = await hq<HdSlaPolicy>("SELECT id, name, priority, first_reply_minutes, resolve_minutes, business_hours FROM hd_sla_policies", [], client);
  const bySet = new Map<number, HolidayRow[]>();
  for (const h of holidays) {
    const l = bySet.get(h.set_id);
    if (l) l.push(h);
    else bySet.set(h.set_id, [h]);
  }
  const snap: CalendarSnapshot = { defaultId: null, calendars: new Map(), teams: new Map(), targets: new Map(), workspace: new Map() };
  for (const c of cals) {
    const setIds = links.filter((l) => l.calendar_id === c.id).map((l) => l.set_id);
    const hs = setIds.flatMap((s) => bySet.get(s) ?? []).map(holidayOut);
    snap.calendars.set(c.id, { row: c, hours: hoursFromCalendar(c, hs), set_ids: setIds });
    if (c.is_default === 1) snap.defaultId = c.id;
  }
  for (const t of teams) snap.teams.set(t.id, { name: t.name, calendar_id: t.calendar_id });
  for (const t of targets) {
    let m = snap.targets.get(t.team_id);
    if (!m) snap.targets.set(t.team_id, (m = new Map()));
    m.set(t.priority, { priority: t.priority, first_reply_minutes: t.first_reply_minutes, resolve_minutes: t.resolve_minutes, business_hours: t.business_hours });
  }
  for (const p of workspace) snap.workspace.set(p.priority, p);
  return snap;
}

/**
 * The current snapshot (cached for 30 seconds; edits here invalidate it at
 * once). With `client` (a caller's open transaction) a cold cache is read on
 * that client and not cached (it may see the transaction's own writes), so
 * the caller never needs a second pooled connection.
 */
export async function calendarSnapshot(client?: HdQueryable): Promise<CalendarSnapshot> {
  const fresh = cached && Date.now() - cached.at < SNAPSHOT_TTL_MS ? cached : null;
  if (client) {
    // Never await an in-flight pooled load while holding a client: if every
    // pooled connection is held by a transaction doing the same, that load
    // can never get one and the pool deadlocks. A resolved snapshot is free.
    if (fresh?.value) return fresh.value;
    return loadSnapshot(client);
  }
  if (fresh) return fresh.snap;
  const snap = loadSnapshot();
  // Cached from the start (concurrent callers share it); a write's invalidate drops it.
  const entry: NonNullable<typeof cached> = { at: Date.now(), snap };
  cached = entry;
  snap.then(
    (v) => {
      entry.value = v;
    },
    () => {
      if (cached === entry) cached = null;
    }
  );
  return snap;
}

let fallbackHours: HdBusinessHours | null = null;
async function legacyHours(client?: HdQueryable): Promise<HdBusinessHours> {
  if (!fallbackHours) {
    const { getBusinessHours } = await import("./settings");
    fallbackHours = await getBusinessHours(client);
  }
  return fallbackHours;
}

function calendarIdIn(snap: CalendarSnapshot, teamId: number | null): number | null {
  const team = teamId != null ? snap.teams.get(teamId) : undefined;
  const id = team?.calendar_id ?? snap.defaultId;
  return id != null && snap.calendars.has(id) ? id : snap.defaultId;
}

function hoursIn(snap: CalendarSnapshot, teamId: number | null): HdBusinessHours | null {
  const id = calendarIdIn(snap, teamId);
  return id != null ? snap.calendars.get(id)!.hours : null;
}

function policyIn(snap: CalendarSnapshot, priority: HdPriority, teamId: number | null): HdEffectiveSlaPolicy | undefined {
  const ws = snap.workspace.get(priority);
  const team = teamId != null ? snap.targets.get(teamId)?.get(priority) : undefined;
  if (team) {
    return {
      id: ws?.id ?? 0,
      name: ws?.name ?? priority[0].toUpperCase() + priority.slice(1),
      priority,
      first_reply_minutes: team.first_reply_minutes,
      resolve_minutes: team.resolve_minutes,
      business_hours: team.business_hours,
      source: "team",
      policy_id: ws?.id ?? null,
    };
  }
  return ws ? { ...ws, source: "workspace", policy_id: ws.id } : undefined;
}

// --- Resolution ------------------------------------------------------------------------

/** The business hours a team works to: its calendar, or the default calendar (teamId null or no calendar). */
export async function hoursForTeam(teamId: number | null, client?: HdQueryable): Promise<HdBusinessHours> {
  return hoursIn(await calendarSnapshot(client), teamId) ?? (await legacyHours(client));
}

/** The business hours a ticket's clocks count: its team's calendar. */
export async function hoursForTicket(ticket: Pick<HdTicketRow, "team_id">): Promise<HdBusinessHours> {
  return hoursForTeam(ticket.team_id ?? null);
}

/** One calendar's hours (the preview; null when it does not exist). */
export async function hoursForCalendar(calendarId: number): Promise<HdBusinessHours | null> {
  return (await calendarSnapshot()).calendars.get(calendarId)?.hours ?? null;
}

/**
 * The reply targets a team's ticket of `priority` works to: the team's own
 * (source 'team') or the workspace policy (source 'workspace'). Undefined
 * when neither exists. The workspace row is read fresh (A's SLA page does
 * not invalidate this cache); the team's from the snapshot.
 */
export async function slaPolicyForTeam(priority: HdPriority, teamId: number | null, client?: HdQueryable): Promise<HdEffectiveSlaPolicy | undefined> {
  const snap = await calendarSnapshot(client);
  const ws = await hqOne<HdSlaPolicy>(
    "SELECT id, name, priority, first_reply_minutes, resolve_minutes, business_hours FROM hd_sla_policies WHERE priority = $1",
    [priority],
    client
  );
  const local: CalendarSnapshot = { ...snap, workspace: new Map(ws ? [[priority, ws]] : []) };
  return policyIn(local, priority, teamId);
}

export async function slaPolicyForTicket(ticket: Pick<HdTicketRow, "priority" | "team_id">, client?: HdQueryable): Promise<HdEffectiveSlaPolicy | undefined> {
  return slaPolicyForTeam(ticket.priority, ticket.team_id ?? null, client);
}

/** `minutes` business minutes after `from` in the team's calendar (workflow waits and task dues). */
export async function addTeamBusinessMinutes(teamId: number | null, from: Date | number, minutes: number): Promise<Date> {
  return addBusinessMinutes(from, minutes, await hoursForTeam(teamId));
}

/**
 * A pause is ending (call inside the caller's transaction, before its
 * UPDATE clears sla_paused_at): add the business time it lasted, in the
 * ticket's team calendar, to hd_tickets.sla_paused_business_ms. A ticket
 * whose earlier pauses were never tracked (NULL with wall time on record)
 * stays NULL, so a re-time from creation estimates rather than undercounts
 * (lib/helpdesk/sla-pause-schema). No-op when the ticket is not paused.
 */
export async function bankPausedBusiness(client: HdQueryable, ticketId: number, now: Date | number = Date.now()): Promise<void> {
  const r = await hqOne<{ team_id: number | null; sla_paused_at: string | null }>(
    "SELECT team_id, sla_paused_at FROM hd_tickets WHERE id = $1",
    [ticketId],
    client
  );
  if (!r?.sla_paused_at) return;
  const end = typeof now === "number" ? now : now.getTime();
  const minutes = businessMinutesBetween(Date.parse(r.sla_paused_at), end, await hoursForTeam(r.team_id, client));
  await client.query(
    `UPDATE hd_tickets
        SET sla_paused_business_ms = CASE WHEN sla_paused_business_ms IS NULL AND sla_paused_ms > 0 THEN NULL
                                          ELSE coalesce(sla_paused_business_ms, 0) + $2::bigint END
      WHERE id = $1`,
    [ticketId, Math.round(minutes * 60_000)]
  );
}

/** Business minutes between two instants in the ticket's team calendar (reports, analytics). */
export async function businessMinutesForTicket(ticket: Pick<HdTicketRow, "team_id">, a: Date | number, b: Date | number): Promise<number> {
  return businessMinutesBetween(a, b, await hoursForTeam(ticket.team_id ?? null));
}

// --- Notes for the desk and Get help ---------------------------------------------------

type NoteTicket = Pick<HdTicketRow, "id" | "team_id" | "priority" | "status" | "first_reply_due" | "resolve_due" | "first_replied_at" | "sla_paused_at">;

/** Why the ticket's running clock is stopped right now ("Paused for Christmas Day, resumes Mon 09:00"), or null. */
export async function clockNote(ticket: Omit<NoteTicket, "id">, now: Date | number = Date.now()): Promise<string | null> {
  const snap = await calendarSnapshot();
  const hours = hoursIn(snap, ticket.team_id ?? null) ?? (await legacyHours());
  const policy = policyIn(snap, ticket.priority, ticket.team_id ?? null);
  return clockNoteWith(ticket, hours, typeof now === "number" ? now : now.getTime(), policy ? policy.business_hours === 1 : true);
}

/** clockNote for a page of tickets (one snapshot): ticket id → note, only those with one. */
export async function clockNotes(tickets: NoteTicket[], now: Date | number = Date.now()): Promise<Map<number, string>> {
  const snap = await calendarSnapshot();
  const t = typeof now === "number" ? now : now.getTime();
  const fallback = snap.defaultId == null ? await legacyHours() : null;
  const out = new Map<number, string>();
  for (const k of tickets) {
    const hours = hoursIn(snap, k.team_id ?? null) ?? fallback!;
    const policy = policyIn(snap, k.priority, k.team_id ?? null);
    const note = clockNoteWith(k, hours, t, policy ? policy.business_hours === 1 : true);
    if (note) out.set(k.id, note);
  }
  return out;
}

/** The SLA tooltip's source line: "IT team target: first reply in 2 business hours" / "Workspace target: …". */
export async function slaTargetNote(ticket: Pick<HdTicketRow, "team_id" | "priority" | "first_replied_at">): Promise<string> {
  const snap = await calendarSnapshot();
  const policy = policyIn(snap, ticket.priority, ticket.team_id ?? null);
  if (!policy) return "";
  const business = policy.business_hours === 1;
  const what = ticket.first_replied_at
    ? `resolve in ${targetPhrase(policy.resolve_minutes, business)}`
    : `first reply in ${targetPhrase(policy.first_reply_minutes, business)}`;
  if (policy.source === "team") {
    const name = snap.teams.get(ticket.team_id!)?.name ?? "Team";
    return `${teamPhrase(name).replace(/^The /, "")} target: ${what}`;
  }
  return `Workspace target: ${what}`;
}

/** Is the team open now? For Get help: "The IT team is closed for Christmas Day. We'll reply from Mon 09:00." */
export async function teamOpenState(teamId: number | null, now: Date | number = Date.now()): Promise<HdTeamOpenState> {
  const snap = await calendarSnapshot();
  const hours = hoursIn(snap, teamId) ?? (await legacyHours());
  const name = teamId != null ? snap.teams.get(teamId)?.name ?? null : null;
  return openStateWith(hours, name, typeof now === "number" ? now : now.getTime());
}

// --- Re-timing ---------------------------------------------------------------------------

type RetimeTicket = Pick<
  HdTicketRow,
  "id" | "team_id" | "priority" | "status" | "created_at" | "first_reply_due" | "resolve_due" | "first_replied_at" | "sla_paused_at" | "sla_paused_ms" | "sla_policy_id"
> & {
  /** Business time spent paused (lib/helpdesk/sla-pause-schema); NULL or absent = not tracked. */
  sla_paused_business_ms?: number | string | null;
};

/**
 * The time a ticket's clocks spent paused, before `anchor`, in each kind of
 * target: wall minutes (24/7 targets) and business minutes (business-hours
 * targets). Business time is what bankPausedBusiness summed as each pause
 * ended; a ticket paused before that was tracked (NULL with wall time on
 * record) is estimated from its wall time at the share of business time
 * in its life so far, never added as whole nights and weekends.
 */
function pausedMinutes(t: RetimeTicket, anchor: number, hours: HdBusinessHours): { wall: number; business: number } {
  const wall = Math.max(0, Number(t.sla_paused_ms ?? 0)) / 60_000;
  const banked = t.sla_paused_business_ms;
  if (banked !== null && banked !== undefined && banked !== "") return { wall, business: Math.max(0, Number(banked)) / 60_000 };
  if (wall <= 0) return { wall: 0, business: 0 };
  const created = Date.parse(t.created_at);
  const lifeWall = Math.max(1, (anchor - created) / 60_000);
  const share = Math.min(1, businessMinutesBetween(created, anchor, hours) / lifeWall);
  return { wall, business: wall * share };
}

interface ClockSide {
  hours: HdBusinessHours;
  policy: HdEffectiveSlaPolicy | undefined;
}

/**
 * One clock moved from `old` (calendar + target) to `neu`: the policy time
 * already used is kept (old target − what was left at `anchor`, measured in
 * the old calendar) and the rest of the new target is counted from `anchor`
 * in the new calendar. A clock already past due stays where it is (no
 * retroactive un-breach); one whose new target is already used up is due at
 * `anchor` (breached there; the sweep records and announces it).
 */
function retimeClock(
  due: string | null,
  which: "first_reply" | "resolve",
  anchor: number,
  created: number,
  paused: { wall: number; business: number },
  old: ClockSide,
  neu: ClockSide
): { due: string | null; breached: boolean } {
  const target = (p: HdEffectiveSlaPolicy) => (which === "first_reply" ? p.first_reply_minutes : p.resolve_minutes);
  if (!neu.policy) return { due, breached: false };
  if (due && Date.parse(due) <= anchor) return { due, breached: false };
  let used: number;
  if (due && old.policy) {
    const left = policyMinutesBetween(anchor, Date.parse(due), old.policy, old.hours);
    used = Math.max(0, target(old.policy) - left);
  } else {
    // From creation: the policy time since creation less the time paused,
    // both in the target's own kind of time (1.19.1: the paused share was
    // wall-clock before, which added whole nights to a business target).
    const pausedPolicy = neu.policy.business_hours ? paused.business : paused.wall;
    used = Math.max(0, policyMinutesBetween(created, anchor, neu.policy, old.hours) - pausedPolicy);
  }
  const remaining = target(neu.policy) - used;
  if (remaining <= 0) return { due: new Date(anchor).toISOString(), breached: true };
  return { due: new Date(addPolicyMinutes(anchor, remaining, neu.policy, neu.hours)).toISOString(), breached: false };
}

function retimeTicket(t: RetimeTicket, now: number, old: ClockSide, neu: ClockSide) {
  const paused = !!t.sla_paused_at && HD_PAUSED_STATUSES.includes(t.status);
  // A paused clock is measured to where it stopped; resume continues from there.
  const anchor = paused ? Date.parse(t.sla_paused_at!) : now;
  const created = Date.parse(t.created_at);
  const pausedTime = pausedMinutes(t, anchor, old.hours);
  const open = HD_OPEN_STATUSES.includes(t.status);
  const fr = !t.first_replied_at && open ? retimeClock(t.first_reply_due, "first_reply", anchor, created, pausedTime, old, neu) : { due: t.first_reply_due, breached: false };
  const rs = open ? retimeClock(t.resolve_due, "resolve", anchor, created, pausedTime, old, neu) : { due: t.resolve_due, breached: false };
  return {
    first_reply_due: fr.due,
    resolve_due: rs.due,
    breached: { first_reply: fr.breached, resolve: rs.breached },
    changed: fr.due !== t.first_reply_due || rs.due !== t.resolve_due,
  };
}

/**
 * The dues after a team move (call inside updateTicket's transaction when
 * team_id changes): business time already used is kept, measured in the
 * old team's calendar against its target; the rest of the NEW team's
 * target is counted in the new team's calendar. `breached` marks clocks the
 * move used up (due = the move; the sweep stamps and announces the breach).
 * Met and closed clocks keep their dues.
 */
export async function transferDues(
  ticket: RetimeTicket,
  fromTeam: number | null,
  toTeam: number | null,
  now: Date | number = Date.now(),
  client?: HdQueryable
): Promise<{
  first_reply_due: Date | null;
  resolve_due: Date | null;
  sla_policy_id: number | null;
  policy_source: "team" | "workspace" | null;
  breached: { first_reply: boolean; resolve: boolean };
  changed: boolean;
}> {
  const snap = await calendarSnapshot(client);
  const fallback = await legacyHours(client);
  const ws = await hq<HdSlaPolicy>(
    "SELECT id, name, priority, first_reply_minutes, resolve_minutes, business_hours FROM hd_sla_policies WHERE priority = $1",
    [ticket.priority],
    client
  );
  const local: CalendarSnapshot = { ...snap, workspace: new Map(ws.map((p) => [p.priority, p])) };
  const old: ClockSide = { hours: hoursIn(local, fromTeam) ?? fallback, policy: policyIn(local, ticket.priority, fromTeam) };
  const neu: ClockSide = { hours: hoursIn(local, toTeam) ?? fallback, policy: policyIn(local, ticket.priority, toTeam) };
  const r = retimeTicket(ticket, typeof now === "number" ? now : now.getTime(), old, neu);
  return {
    first_reply_due: r.first_reply_due ? new Date(r.first_reply_due) : null,
    resolve_due: r.resolve_due ? new Date(r.resolve_due) : null,
    sla_policy_id: neu.policy ? neu.policy.policy_id : ticket.sla_policy_id,
    policy_source: neu.policy?.source ?? null,
    breached: r.breached,
    changed: r.changed,
  };
}

/**
 * One clock re-timed for a new target (a priority change, possibly with a
 * team move): the business time already used is read off the clock as it
 * stands (old target minus what was left at `anchor`, plus any overdue
 * time, measured in the old calendar), never from wall-clock paused time;
 * the rest of the new target is counted from `anchor` in the new calendar.
 * A target the clock has already used up is due at `anchor` (the SLA sweep
 * stamps and announces the breach). Without an old due (no SLA before) the
 * time used counts from creation.
 */
function rescaleClock(
  due: string | null,
  which: "first_reply" | "resolve",
  anchor: number,
  createdFrom: number,
  old: ClockSide,
  neu: ClockSide
): string | null {
  const target = (p: HdEffectiveSlaPolicy) => (which === "first_reply" ? p.first_reply_minutes : p.resolve_minutes);
  if (!neu.policy) return null;
  let used: number;
  if (due && old.policy) {
    const d = Date.parse(due);
    used =
      d > anchor
        ? Math.max(0, target(old.policy) - policyMinutesBetween(anchor, d, old.policy, old.hours))
        : target(old.policy) + policyMinutesBetween(d, anchor, old.policy, old.hours);
  } else {
    used = policyMinutesBetween(createdFrom, anchor, neu.policy, neu.hours);
  }
  const remaining = target(neu.policy) - used;
  if (remaining <= 0) return new Date(anchor).toISOString();
  return new Date(addPolicyMinutes(anchor, remaining, neu.policy, neu.hours)).toISOString();
}

/**
 * The dues after a priority change (call inside updateTicket's transaction;
 * `toTeam` differs from `fromTeam` when the same patch moves the ticket).
 * Business time used is kept (rescaleClock); a paused ticket is measured to
 * where its clock stopped, and resuming counts on from there. A met first
 * reply keeps its due; a closed ticket keeps both.
 */
export async function reprioritisedDues(
  ticket: RetimeTicket,
  from: { team: number | null; priority: HdPriority },
  to: { team: number | null; priority: HdPriority },
  now: Date | number = Date.now(),
  client?: HdQueryable
): Promise<{ first_reply_due: string | null; resolve_due: string | null; sla_policy_id: number | null }> {
  const snap = await calendarSnapshot(client);
  const fallback = await legacyHours(client);
  const ws = await hq<HdSlaPolicy>(
    "SELECT id, name, priority, first_reply_minutes, resolve_minutes, business_hours FROM hd_sla_policies WHERE priority = ANY($1::text[])",
    [[from.priority, to.priority]],
    client
  );
  const local: CalendarSnapshot = { ...snap, workspace: new Map(ws.map((p) => [p.priority, p])) };
  const old: ClockSide = { hours: hoursIn(local, from.team) ?? fallback, policy: policyIn(local, from.priority, from.team) };
  const neu: ClockSide = { hours: hoursIn(local, to.team) ?? fallback, policy: policyIn(local, to.priority, to.team) };
  const t = typeof now === "number" ? now : now.getTime();
  const paused = !!ticket.sla_paused_at && HD_PAUSED_STATUSES.includes(ticket.status);
  const anchor = paused ? Date.parse(ticket.sla_paused_at!) : t;
  const createdFrom = Date.parse(ticket.created_at);
  const open = HD_OPEN_STATUSES.includes(ticket.status);
  const sla_policy_id = neu.policy ? neu.policy.policy_id : null;
  if (!neu.policy) return { first_reply_due: null, resolve_due: null, sla_policy_id };
  return {
    first_reply_due:
      open && !ticket.first_replied_at ? rescaleClock(ticket.first_reply_due, "first_reply", anchor, createdFrom, old, neu) : ticket.first_reply_due,
    resolve_due: open ? rescaleClock(ticket.resolve_due, "resolve", anchor, createdFrom, old, neu) : ticket.resolve_due,
    sla_policy_id,
  };
}

/** Which tickets a change reaches: these teams' (and, for the default calendar, team-less ones). */
interface Scope {
  teamIds: number[];
  noTeam: boolean;
}

function scopeForCalendars(snap: CalendarSnapshot, calendarIds: number[]): Scope {
  const ids = new Set(calendarIds);
  const teamIds: number[] = [];
  for (const [id, t] of snap.teams) {
    const cal = t.calendar_id != null && snap.calendars.has(t.calendar_id) ? t.calendar_id : snap.defaultId;
    if (cal != null && ids.has(cal)) teamIds.push(id);
  }
  return { teamIds, noTeam: snap.defaultId != null && ids.has(snap.defaultId) };
}

/**
 * Re-time the open, running clocks in `scope` from the `before` snapshot to
 * the current one (or, without `before`, from creation: the target counted
 * from created_at plus the time paused, as a priority change does). Paused
 * tickets wait: resume re-times them. Batches of 200 under the recompute
 * lock, rows locked. Returns how many tickets moved.
 */
async function recompute(scope: Scope, before: CalendarSnapshot | null, now = Date.now()): Promise<number> {
  invalidateCalendarCache();
  if (!scope.teamIds.length && !scope.noTeam) return 0;
  const after = await loadSnapshot();
  const fallback = await legacyHours();
  let moved = 0;
  let lastId = 0;
  for (;;) {
    const n = await withTx(async (client: PoolClient) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [CALENDAR_RECOMPUTE_LOCK]);
      const rows = (
        await client.query<RetimeTicket>(
          `SELECT id, team_id, priority, status, created_at, first_reply_due, resolve_due, first_replied_at, sla_paused_at, sla_paused_ms, sla_paused_business_ms, sla_policy_id
             FROM hd_tickets
            WHERE id > $1 AND status IN ('new', 'open', 'pending', 'on_hold') AND sla_paused_at IS NULL
              AND (team_id = ANY($2::int[]) ${scope.noTeam ? "OR team_id IS NULL" : ""})
            ORDER BY id LIMIT $3 FOR UPDATE`,
          [lastId, scope.teamIds, RECOMPUTE_BATCH]
        )
      ).rows.map((r) => ({
        ...r,
        created_at: new Date(r.created_at as unknown as Date).toISOString(),
        first_reply_due: r.first_reply_due ? new Date(r.first_reply_due as unknown as Date).toISOString() : null,
        resolve_due: r.resolve_due ? new Date(r.resolve_due as unknown as Date).toISOString() : null,
        first_replied_at: r.first_replied_at ? new Date(r.first_replied_at as unknown as Date).toISOString() : null,
        sla_paused_at: null,
      }));
      if (!rows.length) return -1;
      lastId = rows[rows.length - 1].id;
      let c = 0;
      for (const t of rows) {
        const neu: ClockSide = { hours: hoursIn(after, t.team_id) ?? fallback, policy: policyIn(after, t.priority, t.team_id) };
        let r: ReturnType<typeof retimeTicket>;
        if (before) {
          const old: ClockSide = { hours: hoursIn(before, t.team_id) ?? fallback, policy: policyIn(before, t.priority, t.team_id) };
          r = retimeTicket(t, now, old, neu);
        } else {
          // From creation: as if the ticket had always had these hours and targets.
          const old: ClockSide = { hours: neu.hours, policy: undefined };
          r = retimeTicket({ ...t, first_reply_due: null, resolve_due: null }, now, old, neu);
          const keep = (due: string | null, next: string | null) => (due && Date.parse(due) <= now ? due : next);
          r = { ...r, first_reply_due: t.first_replied_at ? t.first_reply_due : keep(t.first_reply_due, r.first_reply_due), resolve_due: keep(t.resolve_due, r.resolve_due) };
          r.changed = r.first_reply_due !== t.first_reply_due || r.resolve_due !== t.resolve_due;
        }
        if (!r.changed) continue;
        await client.query(
          `UPDATE hd_tickets SET first_reply_due = $2, resolve_due = $3, sla_warned_at = NULL,
                  first_reply_breached_at = CASE WHEN $2::timestamptz > $4 THEN NULL ELSE first_reply_breached_at END,
                  resolve_breached_at = CASE WHEN $3::timestamptz > $4 THEN NULL ELSE resolve_breached_at END
            WHERE id = $1`,
          [t.id, r.first_reply_due, r.resolve_due, new Date(now)]
        );
        c++;
      }
      return c;
    });
    if (n < 0) break;
    moved += n;
  }
  return moved;
}

/**
 * Re-time the open, running tickets of every team on `calendarId` (and the
 * team-less ones when it is the default). Writes here call it themselves
 * with the state from before the write; call it bare to re-time from
 * creation.
 */
export async function recomputeDuesForCalendar(calendarId: number, opts: { before?: CalendarSnapshot; now?: number } = {}): Promise<number> {
  const snap = opts.before ?? (await loadSnapshot());
  return recompute(scopeForCalendars(snap, [calendarId]), opts.before ?? null, opts.now);
}

/** Re-time one team's open, running tickets (its calendar or targets changed). */
export async function recomputeDuesForTeam(teamId: number, opts: { before?: CalendarSnapshot; now?: number } = {}): Promise<number> {
  return recompute({ teamIds: [teamId], noTeam: false }, opts.before ?? null, opts.now);
}

/** A fresh snapshot to pass as `before` to the recomputes. */
export async function snapshotForRecompute(): Promise<CalendarSnapshot> {
  return loadSnapshot();
}

// --- Calendars: reads and writes -----------------------------------------------------------

export class CalendarError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

function calendarOut(snap: CalendarSnapshot, id: number): HdCalendar | undefined {
  const c = snap.calendars.get(id);
  if (!c) return undefined;
  return {
    id: c.row.id,
    name: c.row.name,
    timezone: c.row.timezone,
    schedule: c.row.schedule,
    is_default: c.row.is_default === 1,
    holiday_set_ids: c.set_ids,
    team_ids: [...snap.teams].filter(([, t]) => t.calendar_id === id).map(([tid]) => tid),
    created_at: c.row.created_at,
    updated_at: c.row.updated_at,
  };
}

export async function listCalendars(): Promise<HdCalendar[]> {
  const snap = await loadSnapshot();
  return [...snap.calendars.keys()].map((id) => calendarOut(snap, id)!);
}

export async function getCalendar(id: number): Promise<HdCalendar | undefined> {
  return calendarOut(await loadSnapshot(), id);
}

export async function listCalendarTeams(): Promise<HdCalendarTeam[]> {
  return cq<HdCalendarTeam>("SELECT id, name, calendar_id FROM hd_teams ORDER BY position, name");
}

export interface CalendarInput {
  name: string;
  timezone: string;
  schedule: HdWeekSchedule;
  holiday_set_ids?: number[];
}

async function setLinks(client: PoolClient, calendarId: number, setIds: number[]): Promise<void> {
  const ids = [...new Set(setIds)].slice(0, CALENDAR_LIMITS.setsPerCalendar);
  if (ids.length) {
    const found = await client.query("SELECT id FROM hd_holiday_sets WHERE id = ANY($1::int[])", [ids]);
    if (found.rowCount !== ids.length) throw new CalendarError("One of those holiday sets does not exist.");
  }
  await client.query("DELETE FROM hd_calendar_holiday_sets WHERE calendar_id = $1", [calendarId]);
  for (const s of ids) await client.query("INSERT INTO hd_calendar_holiday_sets (calendar_id, set_id) VALUES ($1, $2)", [calendarId, s]);
}

function isUnique(e: unknown): boolean {
  return (e as { code?: string })?.code === "23505";
}

export async function createCalendar(input: CalendarInput): Promise<HdCalendar> {
  await calendarsReady();
  const count = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_calendars");
  if ((count?.n ?? 0) >= CALENDAR_LIMITS.calendars) throw new CalendarError(`Up to ${CALENDAR_LIMITS.calendars} calendars.`);
  let id = 0;
  try {
    id = await withTx(async (client) => {
      const r = await client.query<{ id: number }>("INSERT INTO hd_calendars (name, timezone, schedule) VALUES ($1, $2, $3::jsonb) RETURNING id", [
        input.name,
        input.timezone,
        JSON.stringify(input.schedule),
      ]);
      await setLinks(client, r.rows[0].id, input.holiday_set_ids ?? []);
      return r.rows[0].id;
    });
  } catch (e) {
    if (isUnique(e)) throw new CalendarError("A calendar with that name already exists.", 409);
    throw e;
  }
  invalidateCalendarCache();
  return (await getCalendar(id))!;
}

/** Mirror the default calendar into the deprecated helpdesk_settings hours (older readers). */
async function mirrorDefaultToSettings(snap: CalendarSnapshot): Promise<void> {
  if (snap.defaultId == null) return;
  const c = snap.calendars.get(snap.defaultId)!;
  const legacy = legacyFromSchedule(c.row.schedule);
  const holidays = (c.hours.holidayRanges ?? []).filter((h) => !h.yearly && !h.from && !h.to).map((h) => h.date);
  const { saveHelpdeskSettings } = await import("./settings");
  await saveHelpdeskSettings({ timezone: c.row.timezone, days: legacy.days, start: legacy.start, end: legacy.end, holidays: [...new Set(holidays)].slice(-366) });
  fallbackHours = null;
}

export async function updateCalendar(id: number, patch: Partial<CalendarInput>): Promise<{ calendar: HdCalendar; retimed: number } | undefined> {
  const before = await loadSnapshot();
  if (!before.calendars.has(id)) return undefined;
  try {
    await withTx(async (client) => {
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (col: string, v: unknown, cast = "") => {
        params.push(v);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (patch.name !== undefined) set("name", patch.name);
      if (patch.timezone !== undefined) set("timezone", patch.timezone);
      if (patch.schedule !== undefined) set("schedule", JSON.stringify(patch.schedule), "::jsonb");
      set("updated_at", new Date());
      await client.query(`UPDATE hd_calendars SET ${sets.join(", ")} WHERE id = $1`, params);
      if (patch.holiday_set_ids !== undefined) await setLinks(client, id, patch.holiday_set_ids);
    });
  } catch (e) {
    if (isUnique(e)) throw new CalendarError("A calendar with that name already exists.", 409);
    throw e;
  }
  const retimed = await recompute(scopeForCalendars(before, [id]), before);
  const after = await loadSnapshot();
  if (after.defaultId === id) await mirrorDefaultToSettings(after);
  return { calendar: calendarOut(after, id)!, retimed };
}

/** Delete a calendar (never the default): its teams fall back to the default and are re-timed. */
export async function deleteCalendar(id: number): Promise<{ calendar: HdCalendar; retimed: number } | undefined> {
  const before = await loadSnapshot();
  const cal = calendarOut(before, id);
  if (!cal) return undefined;
  if (cal.is_default) throw new CalendarError("The default calendar can't be deleted. Make another calendar the default first.", 409);
  await hq("DELETE FROM hd_calendars WHERE id = $1", [id]);
  const retimed = await recompute({ teamIds: cal.team_ids, noTeam: false }, before);
  return { calendar: cal, retimed };
}

/** Make `id` the default (teams without a calendar and team-less tickets move to it). */
export async function setDefaultCalendar(id: number): Promise<{ calendar: HdCalendar; previous: HdCalendar | undefined; retimed: number } | undefined> {
  const before = await loadSnapshot();
  if (!before.calendars.has(id)) return undefined;
  const prev = before.defaultId != null ? calendarOut(before, before.defaultId) : undefined;
  if (before.defaultId === id) return { calendar: calendarOut(before, id)!, previous: prev, retimed: 0 };
  await withTx(async (client) => {
    await client.query("UPDATE hd_calendars SET is_default = 0, updated_at = now() WHERE is_default = 1");
    await client.query("UPDATE hd_calendars SET is_default = 1, updated_at = now() WHERE id = $1", [id]);
  });
  const scope: Scope = { teamIds: [...before.teams].filter(([, t]) => t.calendar_id == null || !before.calendars.has(t.calendar_id)).map(([tid]) => tid), noTeam: true };
  const retimed = await recompute(scope, before);
  const after = await loadSnapshot();
  await mirrorDefaultToSettings(after);
  return { calendar: calendarOut(after, id)!, previous: prev, retimed };
}

/** Put a team on a calendar (null = the default). Re-times its open tickets. */
export async function assignTeamCalendar(
  teamId: number,
  calendarId: number | null
): Promise<{ team: { id: number; name: string }; from: number | null; to: number | null; retimed: number } | undefined> {
  const before = await loadSnapshot();
  const team = before.teams.get(teamId);
  if (!team) return undefined;
  if (calendarId !== null && !before.calendars.has(calendarId)) throw new CalendarError("That calendar does not exist.", 404);
  if (team.calendar_id === calendarId) return { team: { id: teamId, name: team.name }, from: team.calendar_id, to: calendarId, retimed: 0 };
  await hq("UPDATE hd_teams SET calendar_id = $2 WHERE id = $1", [teamId, calendarId]);
  const retimed = await recompute({ teamIds: [teamId], noTeam: false }, before);
  return { team: { id: teamId, name: team.name }, from: team.calendar_id, to: calendarId, retimed };
}

/**
 * The deprecated settings hours, written: they go to the default calendar
 * (A's PATCH /api/helpdesk/admin/settings calls this when timezone, days,
 * start, end or holidays change). Holidays replace the "Company holidays"
 * set's one-off whole days.
 */
export async function applyLegacyHoursToDefaultCalendar(
  patch: Partial<Pick<HdBusinessHours, "timezone" | "days" | "start" | "end" | "holidays">>
): Promise<number> {
  await calendarsReady();
  const before = await loadSnapshot();
  if (before.defaultId == null) return 0;
  const cur = before.calendars.get(before.defaultId)!;
  const legacy = legacyFromSchedule(cur.row.schedule);
  const touchesWeek = patch.days !== undefined || patch.start !== undefined || patch.end !== undefined;
  const schedule = touchesWeek ? scheduleFromLegacy(patch.days ?? legacy.days, patch.start ?? legacy.start, patch.end ?? legacy.end) : cur.row.schedule;
  await withTx(async (client) => {
    await client.query("UPDATE hd_calendars SET timezone = $2, schedule = $3::jsonb, updated_at = now() WHERE id = $1", [
      before.defaultId,
      patch.timezone ?? cur.row.timezone,
      JSON.stringify(schedule),
    ]);
    if (patch.holidays) {
      const set = await client.query<{ id: number }>(
        "INSERT INTO hd_holiday_sets (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        [DEFAULT_HOLIDAY_SET_NAME]
      );
      const sid = set.rows[0].id;
      await client.query("DELETE FROM hd_holidays WHERE set_id = $1 AND recurring_yearly = 0 AND closed_from IS NULL AND closed_to IS NULL AND date <> ALL($2::date[])", [
        sid,
        patch.holidays,
      ]);
      for (const d of patch.holidays.filter(validDate)) {
        await client.query(
          "INSERT INTO hd_holidays (set_id, date, name) SELECT $1, $2::date, 'Holiday' WHERE NOT EXISTS (SELECT 1 FROM hd_holidays WHERE set_id = $1 AND date = $2::date)",
          [sid, d]
        );
      }
      await client.query("INSERT INTO hd_calendar_holiday_sets (calendar_id, set_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [before.defaultId, sid]);
    }
  });
  fallbackHours = null;
  return recompute(scopeForCalendars(before, [before.defaultId]), before);
}

// --- Holiday sets ----------------------------------------------------------------------------

export async function listHolidaySets(): Promise<HdHolidaySet[]> {
  const rows = await cq<{ id: number; name: string; description: string; calendar_ids: number[] | null; holiday_count: number }>(
    `SELECT s.id, s.name, s.description,
            (SELECT array_agg(calendar_id ORDER BY calendar_id) FROM hd_calendar_holiday_sets l WHERE l.set_id = s.id) AS calendar_ids,
            (SELECT count(*)::int FROM hd_holidays h WHERE h.set_id = s.id) AS holiday_count
       FROM hd_holiday_sets s ORDER BY s.name`
  );
  return rows.map((r) => ({ ...r, calendar_ids: r.calendar_ids ?? [] }));
}

export async function getHolidaySet(id: number): Promise<(HdHolidaySet & { holidays: HdHoliday[] }) | undefined> {
  const set = (await listHolidaySets()).find((s) => s.id === id);
  if (!set) return undefined;
  const holidays = await cq<HolidayRow>(`SELECT ${HOLIDAY_COLS} FROM hd_holidays WHERE set_id = $1 ORDER BY date, name`, [id]);
  return { ...set, holidays: holidays.map(holidayOut) };
}

/** Run a holiday-set write and re-time every calendar that observes the set. */
async function withSetRecompute<T>(setId: number, write: () => Promise<T>): Promise<{ result: T; retimed: number }> {
  const before = await loadSnapshot();
  const result = await write();
  const calendarIds = [...before.calendars].filter(([, c]) => c.set_ids.includes(setId)).map(([id]) => id);
  const retimed = await recompute(calendarIds.length ? scopeForCalendars(before, calendarIds) : { teamIds: [], noTeam: false }, before);
  if (before.defaultId != null && calendarIds.includes(before.defaultId)) await mirrorDefaultToSettings(await loadSnapshot());
  return { result, retimed };
}

export async function createHolidaySet(input: { name: string; description?: string; holidays?: HdHolidayInput[] }): Promise<HdHolidaySet & { holidays: HdHoliday[] }> {
  await calendarsReady();
  const count = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_holiday_sets");
  if ((count?.n ?? 0) >= CALENDAR_LIMITS.sets) throw new CalendarError(`Up to ${CALENDAR_LIMITS.sets} holiday sets.`);
  let id = 0;
  try {
    id = (await hqOne<{ id: number }>("INSERT INTO hd_holiday_sets (name, description) VALUES ($1, $2) RETURNING id", [input.name, input.description ?? ""]))!.id;
  } catch (e) {
    if (isUnique(e)) throw new CalendarError("A holiday set with that name already exists.", 409);
    throw e;
  }
  if (input.holidays?.length) await insertHolidays(id, input.holidays);
  return (await getHolidaySet(id))!;
}

export async function updateHolidaySet(id: number, patch: { name?: string; description?: string }): Promise<HdHolidaySet | undefined> {
  await calendarsReady();
  try {
    const r = await hqOne<{ id: number }>(
      "UPDATE hd_holiday_sets SET name = COALESCE($2, name), description = COALESCE($3, description) WHERE id = $1 RETURNING id",
      [id, patch.name ?? null, patch.description ?? null]
    );
    if (!r) return undefined;
  } catch (e) {
    if (isUnique(e)) throw new CalendarError("A holiday set with that name already exists.", 409);
    throw e;
  }
  invalidateCalendarCache();
  return (await listHolidaySets()).find((s) => s.id === id);
}

export async function deleteHolidaySet(id: number): Promise<{ set: HdHolidaySet; retimed: number } | undefined> {
  const set = (await listHolidaySets()).find((s) => s.id === id);
  if (!set) return undefined;
  const { retimed } = await withSetRecompute(id, () => hq("DELETE FROM hd_holiday_sets WHERE id = $1", [id]));
  return { set, retimed };
}

async function insertHolidays(setId: number, list: HdHolidayInput[]): Promise<{ added: HdHoliday[]; duplicates: number }> {
  const existing = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_holidays WHERE set_id = $1", [setId]);
  if ((existing?.n ?? 0) + list.length > CALENDAR_LIMITS.holidaysPerSet) {
    throw new CalendarError(`A holiday set holds up to ${CALENDAR_LIMITS.holidaysPerSet} holidays.`);
  }
  return withTx(async (client) => {
    const added: HdHoliday[] = [];
    let duplicates = 0;
    for (const h of list) {
      const r = await client.query<HolidayRow>(
        `INSERT INTO hd_holidays (set_id, date, name, recurring_yearly, closed_from, closed_to) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (set_id, date, name) DO NOTHING RETURNING ${HOLIDAY_COLS}`,
        [setId, h.date, h.name, h.recurring_yearly ? 1 : 0, h.closed_from, h.closed_to]
      );
      if (r.rows[0]) added.push(holidayOut(r.rows[0]));
      else duplicates++;
    }
    return { added, duplicates };
  });
}

/** Add holidays (bulk: the form, a paste, an .ics import). Duplicates (same date and name) are skipped. */
export async function addHolidays(setId: number, list: HdHolidayInput[]): Promise<{ added: HdHoliday[]; duplicates: number; retimed: number } | undefined> {
  await calendarsReady();
  if (!(await hqOne("SELECT 1 FROM hd_holiday_sets WHERE id = $1", [setId]))) return undefined;
  const { result, retimed } = await withSetRecompute(setId, () => insertHolidays(setId, list));
  return { ...result, retimed };
}

export async function updateHoliday(setId: number, holidayId: number, h: HdHolidayInput): Promise<{ holiday: HdHoliday; retimed: number } | undefined> {
  await calendarsReady();
  try {
    const { result, retimed } = await withSetRecompute(setId, () =>
      hqOne<HolidayRow>(
        `UPDATE hd_holidays SET date = $3, name = $4, recurring_yearly = $5, closed_from = $6, closed_to = $7
          WHERE id = $1 AND set_id = $2 RETURNING ${HOLIDAY_COLS}`,
        [holidayId, setId, h.date, h.name, h.recurring_yearly ? 1 : 0, h.closed_from, h.closed_to]
      )
    );
    return result ? { holiday: holidayOut(result), retimed } : undefined;
  } catch (e) {
    if (isUnique(e)) throw new CalendarError("That set already has a holiday with this name on that date.", 409);
    throw e;
  }
}

export async function deleteHoliday(setId: number, holidayId: number): Promise<{ holiday: HdHoliday; retimed: number } | undefined> {
  await calendarsReady();
  const { result, retimed } = await withSetRecompute(setId, () =>
    hqOne<HolidayRow>(`DELETE FROM hd_holidays WHERE id = $1 AND set_id = $2 RETURNING ${HOLIDAY_COLS}`, [holidayId, setId])
  );
  return result ? { holiday: holidayOut(result), retimed } : undefined;
}

/**
 * "Copy to next year": every one-off holiday of `fromYear` again in
 * `toYear` (same month and day; 29 Feb only into a leap year). Yearly ones
 * already repeat. Returns the added ones.
 */
export async function copyHolidaysToYear(setId: number, fromYear: number, toYear: number): Promise<{ added: HdHoliday[]; duplicates: number; retimed: number } | undefined> {
  const set = await getHolidaySet(setId);
  if (!set) return undefined;
  const list: HdHolidayInput[] = [];
  for (const h of set.holidays) {
    if (h.recurring_yearly || !h.date.startsWith(`${fromYear}-`)) continue;
    const date = `${toYear}${h.date.slice(4)}`;
    if (!validDate(date)) continue;
    list.push({ date, name: h.name, recurring_yearly: false, closed_from: h.closed_from, closed_to: h.closed_to });
  }
  return addHolidays(setId, list);
}

// --- Per-team reply targets ---------------------------------------------------------------------

export async function getTeamSlaView(teamId: number): Promise<HdTeamSlaView | undefined> {
  const snap = await loadSnapshot();
  const team = snap.teams.get(teamId);
  if (!team) return undefined;
  const own = snap.targets.get(teamId);
  return {
    team: { id: teamId, name: team.name },
    targets: HD_PRIORITIES.filter((p) => own?.has(p)).map((p) => own!.get(p)!),
    workspace: HD_PRIORITIES.filter((p) => snap.workspace.has(p)).map((p) => {
      const w = snap.workspace.get(p)!;
      return { priority: p, first_reply_minutes: w.first_reply_minutes, resolve_minutes: w.resolve_minutes, business_hours: w.business_hours };
    }),
  };
}

/**
 * Replace a team's own targets (null or [] = back to the workspace's).
 * Re-times the team's open, running clocks: the time already used stays
 * used, the rest is the new target's.
 */
export async function saveTeamSlaTargets(
  teamId: number,
  targets: HdTeamSlaTarget[] | null,
  actorId: number | null
): Promise<{ view: HdTeamSlaView; before: HdTeamSlaTarget[]; retimed: number } | undefined> {
  const before = await loadSnapshot();
  if (!before.teams.has(teamId)) return undefined;
  const prior = HD_PRIORITIES.filter((p) => before.targets.get(teamId)?.has(p)).map((p) => before.targets.get(teamId)!.get(p)!);
  await withTx(async (client) => {
    await client.query("DELETE FROM hd_team_sla_targets WHERE team_id = $1", [teamId]);
    for (const t of targets ?? []) {
      await client.query(
        `INSERT INTO hd_team_sla_targets (team_id, priority, first_reply_minutes, resolve_minutes, business_hours, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [teamId, t.priority, t.first_reply_minutes, t.resolve_minutes, t.business_hours ? 1 : 0, actorId]
      );
    }
  });
  const retimed = await recompute({ teamIds: [teamId], noTeam: false }, before);
  return { view: (await getTeamSlaView(teamId))!, before: prior, retimed };
}
