import "server-only";

// The people half of the home dashboard (1.17.0): the data behind My team,
// People this week, My training and Team compliance
// (components/dashboard/*Tile). Each reader answers null or an empty list
// when its tile does not apply, so a tile can return null without asking
// twice.
//
// Directory data goes through the same rules as the directory page: hidden
// people never appear, and a field the viewer may not see (Directory →
// Fields → "Admins only", lib/directory-visibility) is never read for them —
// an admin-only birthday makes no birthday row, an admin-only "Reports to"
// makes no My team tile. The account ↔ person link is users.directory_person_id;
// "reports to" is the built-in people field `manager` (directory_person_links
// person_id → target_id, the target being the manager).

import { pool, listMyTraining, reportPolicyStanding, type ReportPolicyStanding } from "./db";
import type { SessionUser } from "./types";
import { listFields } from "./directory";
import { viewerScope } from "./directory-viewer";
import { parseDateValue, type FieldLike } from "./directory-display";
import { MANAGER_FIELD_KEY, managerField } from "./directory-org";
import { getDirectoryGraphConfig } from "./directory-config";
import { eePresent, featureEnabled } from "./ee";
import { userHolds } from "./access";
import { slideCount } from "./training";
import { getComplianceSettings } from "./compliance-settings";
import { teamViewAllowed } from "./team-access";

// --- Shared -----------------------------------------------------------------

/** A directory person as a dashboard row shows them. */
export interface DashPerson {
  id: number;
  name: string;
  title: string;
  department: string;
  /** Synced from Microsoft (the only people Teams presence covers). */
  graph: boolean;
  /** `/api/directory/{id}/photo?v=…`, or "" for the initials. */
  photo: string;
}

interface PersonRow {
  id: number;
  name: string;
  title: string;
  department: string;
  source: string;
  has_photo: boolean;
  v: number;
}

const PERSON_COLS = `p.id, p.name, p.title, p.department, p.source, (p.photo <> '') AS has_photo,
  extract(epoch FROM p.updated_at)::int AS v`;

function toPerson(r: PersonRow, photos: boolean): DashPerson {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    department: r.department,
    graph: r.source === "graph",
    photo: photos && r.has_photo ? `/api/directory/${r.id}/photo?v=${r.v}` : "",
  };
}

/** The viewer's visible directory entry, or null when the account is not linked (or the entry is hidden). */
async function myPersonId(userId: number): Promise<number | null> {
  const r = await pool().query<{ id: number }>(
    `SELECT p.id FROM users u JOIN directory_people p ON p.id = u.directory_person_id AND p.hidden = 0
     WHERE u.id = $1`,
    [userId]
  );
  return r.rows[0]?.id ?? null;
}

/** The directory is the viewer's to browse at all (the directory page's and API's question). */
async function mayReadDirectory(user: SessionUser): Promise<boolean> {
  return userHolds(user, "directory.read", { legacyMin: "viewer" });
}

/** Photos are served by /api/directory/{id}/photo, which asks directory.photo_read. */
async function mayReadPhotos(user: SessionUser): Promise<boolean> {
  return userHolds(user, "directory.photo_read", { legacyMin: "viewer" });
}

/** The fields this viewer may see (admins: all). */
async function visibleDirectoryFields(user: SessionUser): Promise<FieldLike[]> {
  return (await viewerScope(user, await listFields())).fields;
}

/** Teams presence (Enterprise): bundled, licensed and switched on — the directory page's own test. */
export async function presenceEnabled(): Promise<boolean> {
  return eePresent() && (await featureEnabled("directory_sync")) && (await getDirectoryGraphConfig()).presence;
}

// --- My team ----------------------------------------------------------------

export interface MyTeam {
  /** The viewer's own directory entry. */
  me: number;
  manager: DashPerson | null;
  /** Everyone else who reports to the viewer's manager. */
  team: DashPerson[];
  reports: DashPerson[];
  presence: boolean;
}

/**
 * The viewer's manager, the people who share that manager, and the viewer's
 * own direct reports, from the directory. Null when the account has no
 * visible directory entry, the viewer may not see "Reports to", or there is
 * nobody on any of the three lines.
 */
export async function getMyTeam(user: SessionUser): Promise<MyTeam | null> {
  const [me, mayRead, photos, fields] = await Promise.all([
    myPersonId(user.id),
    mayReadDirectory(user),
    mayReadPhotos(user),
    visibleDirectoryFields(user),
  ]);
  if (me === null || !mayRead || !managerField(fields)) return null;
  const rows = (
    await pool().query<PersonRow & { rel: "manager" | "team" | "report" }>(
      `WITH mgr AS (
         SELECT t.id FROM directory_person_links l
         JOIN directory_people t ON t.id = l.target_id AND t.hidden = 0
         WHERE l.person_id = $1 AND l.field_key = $2
         ORDER BY l.sort, t.name, t.id
         LIMIT 1
       )
       SELECT 'manager' AS rel, ${PERSON_COLS} FROM directory_people p WHERE p.id IN (SELECT id FROM mgr)
       UNION ALL
       SELECT 'team' AS rel, ${PERSON_COLS} FROM directory_people p
        WHERE p.hidden = 0 AND p.id <> $1 AND p.id NOT IN (SELECT id FROM mgr)
          AND EXISTS (SELECT 1 FROM directory_person_links l
                       WHERE l.person_id = p.id AND l.field_key = $2 AND l.target_id IN (SELECT id FROM mgr))
       UNION ALL
       SELECT 'report' AS rel, ${PERSON_COLS} FROM directory_people p
        WHERE p.hidden = 0 AND p.id <> $1
          AND EXISTS (SELECT 1 FROM directory_person_links l
                       WHERE l.person_id = p.id AND l.field_key = $2 AND l.target_id = $1)
       ORDER BY name, id`,
      [me, MANAGER_FIELD_KEY]
    )
  ).rows;
  const manager = rows.find((r) => r.rel === "manager");
  const team = rows.filter((r) => r.rel === "team").map((r) => toPerson(r, photos));
  const reports = rows.filter((r) => r.rel === "report").map((r) => toPerson(r, photos));
  if (!manager && !team.length && !reports.length) return null;
  const anyGraph = rows.some((r) => r.source === "graph");
  return {
    me,
    manager: manager ? toPerson(manager, photos) : null,
    team,
    reports,
    presence: anyGraph && (await presenceEnabled()),
  };
}

// --- People this week -------------------------------------------------------

export type PeopleEventKind = "started" | "starting" | "anniversary" | "birthday";

export interface PeopleEvent<P = DashPerson> {
  person: P;
  kind: PeopleEventKind;
  /** The day it falls on, "YYYY-MM-DD" (this year's for an anniversary or a birthday). */
  date: string;
  /** Whole years, for an anniversary. */
  years: number;
}

/** A calendar day as "YYYY-MM-DD". */
export interface Ymd {
  y: number;
  m: number;
  d: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const ymdText = (x: Ymd) => `${x.y}-${pad(x.m)}-${pad(x.d)}`;

/** The calendar day `now` falls on in `timeZone` (UTC when the zone is unusable). */
export function dayIn(now: Date, timeZone: string): Ymd {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Days since 1970-01-01 for a calendar day (no time zone involved). */
const dayNumber = (x: Ymd) => Math.round(Date.UTC(x.y, x.m - 1, x.d) / 86_400_000);
const fromDayNumber = (n: number): Ymd => {
  const t = new Date(n * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Monday … Sunday of the week `today` is in. */
export function weekOf(today: Ymd): Ymd[] {
  const n = dayNumber(today);
  // 1970-01-01 was a Thursday: (n + 3) % 7 is 0 on a Monday.
  const monday = n - ((n + 3) % 7);
  return Array.from({ length: 7 }, (_, i) => fromDayNumber(monday + i));
}

/** Does a month/day recur on this calendar day? A 29 February recurs on the 28th in other years. */
function recursOn(m: number, d: number, day: Ymd): boolean {
  if (m === 2 && d === 29 && !isLeap(day.y)) return day.m === 2 && day.d === 28;
  return day.m === m && day.d === d;
}

/** How many rows the tile shows. */
export const PEOPLE_THIS_WEEK_MAX = 5;
/** A start date this many days either side of today makes a new starter. */
export const NEW_STARTER_DAYS = 7;

/**
 * Who starts (or started) within a week of today, marks a work anniversary
 * this week (Monday to Sunday), or has a birthday this week — from the date
 * fields flagged as a start date or a birthday (`date_role`, as the
 * directory's month strip reads them; directory-display milestonesFor). The
 * `max` nearest today are kept, then ordered by day. Pure.
 */
export function peopleThisWeek<P extends { id: number; name: string; custom: Record<string, string> }>(
  people: P[],
  fields: FieldLike[],
  today: Ymd,
  max = PEOPLE_THIS_WEEK_MAX
): PeopleEvent<P>[] {
  const starts = fields.filter((f) => f.kind === "date" && f.date_role === "start");
  const bdays = fields.filter((f) => f.kind === "date" && f.date_role === "birthday");
  if (!starts.length && !bdays.length) return [];
  const week = weekOf(today);
  const t = dayNumber(today);
  const out: PeopleEvent<P>[] = [];
  for (const p of people) {
    const seen = new Set<string>();
    const push = (e: PeopleEvent<P>) => {
      const key = `${e.kind}:${e.date}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(e);
    };
    for (const f of starts) {
      const s = parseDateValue(p.custom?.[f.key] ?? "");
      if (!s || !s.y) continue;
      const n = dayNumber(s);
      if (Math.abs(n - t) <= NEW_STARTER_DAYS) {
        push({ person: p, kind: n > t ? "starting" : "started", date: ymdText(s), years: 0 });
        continue;
      }
      const day = week.find((w) => recursOn(s.m, s.d, w));
      if (day && day.y > s.y) push({ person: p, kind: "anniversary", date: ymdText(day), years: day.y - s.y });
    }
    for (const f of bdays) {
      const b = parseDateValue(p.custom?.[f.key] ?? "");
      if (!b) continue;
      const day = week.find((w) => recursOn(b.m, b.d, w));
      if (day) push({ person: p, kind: "birthday", date: ymdText(day), years: 0 });
    }
  }
  const KIND_ORDER: Record<PeopleEventKind, number> = { started: 0, starting: 0, anniversary: 1, birthday: 2 };
  const dist = (e: PeopleEvent<P>) => Math.abs(dayNumber(parseDateValue(e.date)!) - t);
  const byDay = (a: PeopleEvent<P>, b: PeopleEvent<P>) =>
    a.date.localeCompare(b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.person.name.localeCompare(b.person.name);
  return out
    .sort((a, b) => dist(a) - dist(b) || byDay(a, b))
    .slice(0, max)
    .sort(byDay);
}

/** People this week for the viewer: their time zone's today, the fields they may see. */
export async function getPeopleThisWeek(user: SessionUser, timeZone: string, now = new Date()): Promise<PeopleEvent[]> {
  const [mayRead, photos, fields] = await Promise.all([mayReadDirectory(user), mayReadPhotos(user), visibleDirectoryFields(user)]);
  if (!mayRead) return [];
  const dated = fields.filter((f) => f.kind === "date" && (f.date_role === "start" || f.date_role === "birthday"));
  if (!dated.length) return [];
  const keys = dated.map((f) => f.key);
  // Only the dated keys leave the database: the rest of a person's custom
  // values (some of them admin-only) are never read here.
  const rows = (
    await pool().query<PersonRow & { custom: Record<string, string> | null }>(
      `SELECT ${PERSON_COLS},
              (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each_text(p.synced || p.custom) e
                WHERE e.key = ANY($1::text[])) AS custom
       FROM directory_people p
       WHERE p.hidden = 0 AND (p.synced || p.custom) ?| $1::text[]`,
      [keys]
    )
  ).rows;
  const people = rows.map((r) => ({ ...toPerson(r, photos), custom: r.custom ?? {} }));
  return peopleThisWeek(people, dated, dayIn(now, timeZone)).map((e) => ({
    ...e,
    person: { id: e.person.id, name: e.person.name, title: e.person.title, department: e.person.department, graph: e.person.graph, photo: e.person.photo },
  }));
}

// --- My training ------------------------------------------------------------

export interface TrainingDue {
  assignment_id: number;
  title: string;
  due_at: string | null;
  overdue: boolean;
  /** Percent of slides seen, or null when the deck has none to count. */
  pct: number | null;
}

/** How many rows the tile shows. */
export const MY_TRAINING_MAX = 3;

/**
 * The viewer's open training (what /training lists, not yet completed or
 * waived), overdue first then the soonest deadline; `total` counts every
 * current assignment, done or not ("2 of 3 due"). Null when Training is not
 * licensed, the viewer may not read their own, or nothing is open.
 */
export async function getMyOpenTraining(
  user: SessionUser,
  now = new Date()
): Promise<{ open: TrainingDue[]; openCount: number; total: number } | null> {
  if (!(await featureEnabled("training"))) return null;
  if (!(await userHolds(user, "training.read_own", { legacyMin: "viewer" }))) return null;
  const mine = await listMyTraining(user.id);
  const open = mine
    .filter((m) => !m.completed_at)
    .map((m): TrainingDue => {
      const slides = slideCount(m.content);
      return {
        assignment_id: m.assignment_id,
        title: m.title,
        due_at: m.due_at,
        overdue: m.due_at !== null && new Date(m.due_at).getTime() < now.getTime(),
        pct: slides > 0 ? Math.round((Math.min(m.last_slide, slides) / slides) * 100) : null,
      };
    })
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        (a.due_at ? Date.parse(a.due_at) : Infinity) - (b.due_at ? Date.parse(b.due_at) : Infinity)
    );
  if (!open.length) return null;
  return { open: open.slice(0, MY_TRAINING_MAX), openCount: open.length, total: mine.length };
}

// --- Team compliance --------------------------------------------------------

/**
 * The accounts of the viewer's direct reports in the directory: people whose
 * "Reports to" is the viewer's entry, linked to an active account. Empty when
 * the viewer has no entry or may not see "Reports to".
 */
export async function directReportAccounts(user: SessionUser): Promise<number[]> {
  const [me, mayRead, fields] = await Promise.all([myPersonId(user.id), mayReadDirectory(user), visibleDirectoryFields(user)]);
  if (me === null || !mayRead || !managerField(fields)) return [];
  const r = await pool().query<{ id: number }>(
    `SELECT DISTINCT u.id FROM users u
     JOIN directory_people p ON p.id = u.directory_person_id AND p.hidden = 0
     JOIN directory_person_links l ON l.person_id = p.id AND l.field_key = $2 AND l.target_id = $1
     WHERE u.status = 'active' AND u.id <> $3
     ORDER BY u.id`,
    [me, MANAGER_FIELD_KEY, user.id]
  );
  return r.rows.map((x) => x.id);
}

export interface TeamCompliance {
  reports: number;
  policies: ReportPolicyStanding[];
  /** The viewer may open /compliance/team (a group lead with standing on, or compliance.team_read). */
  teamView: boolean;
}

/**
 * Read confirmation across the viewer's direct reports: the three policies
 * with the smallest share confirmed. Only when Read confirmation is licensed
 * and the workspace lets leads see policy standing (Program settings, on by
 * default) or the viewer holds compliance.team_read — a manager is a lead by
 * another name, and the setting that hides standing from leads hides it here
 * too. Null when it does not apply or nothing is owed.
 */
export async function getTeamCompliance(user: SessionUser): Promise<TeamCompliance | null> {
  if (!(await featureEnabled("policy_ack"))) return null;
  const [settings, teamRead] = await Promise.all([
    getComplianceSettings(),
    userHolds(user, "compliance.team_read", { legacyMin: "admin" }),
  ]);
  if (!settings.ack_defaults.leads_see_policies && !teamRead) return null;
  const reports = await directReportAccounts(user);
  if (!reports.length) return null;
  const [policies, teamView] = await Promise.all([reportPolicyStanding(reports, user.id, 3), teamViewAllowed(user.id)]);
  if (!policies.length) return null;
  return { reports: reports.length, policies, teamView };
}
