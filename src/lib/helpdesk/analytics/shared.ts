// Helpdesk 1.19.0 reports (agent K): the registry every part of the
// metrics engine, the API and the desk's Reports screens share. Pure data
// and pure functions, safe in client components: measures (what is
// counted, its unit, which direction is good), dimensions (what a measure
// can be split by), filters, date presets, widget and dashboard shapes and
// their validation, value formatting and the queue drill-down link.
//
// The SQL behind each key lives in lib/helpdesk/analytics/engine (server
// only); a key that is not in these tables never reaches SQL.

import { HD_PRIORITIES, HD_PRIORITY_LABEL, HD_STATUSES, HD_STATUS_LABEL } from "../types";
import type { HdPriority, HdStatus } from "../types";

// --- Measures ------------------------------------------------------------------------

export type HdUnit = "count" | "minutes" | "percent" | "ratio";
/** Which way is better: up (more solved), down (faster replies), neutral (volume). */
export type HdGood = "up" | "down" | "neutral";

/**
 * When a measure happens, which decides which tickets a date range takes
 * and what a time dimension buckets on: an event (created, solved, rated,
 * due…), a snapshot at the end of each period (backlog), or now (live).
 */
export type HdBasis = "event" | "snapshot" | "live";

export interface HdMeasureDef {
  label: string;
  /** Short label for a narrow tile or an axis. */
  short: string;
  unit: HdUnit;
  good: HdGood;
  basis: HdBasis;
  description: string;
  /** The queue drill-down's date pair for this measure's event time. */
  drillDate?: "created" | "solved";
  /** Extra drill-down parameters (breached=1). */
  drill?: Record<string, string>;
  /** About people asking for help: automated tickets (alerts, API) never count (CSAT, replies, first reply). */
  peopleOnly?: boolean;
  /** What one counted thing is: a ticket, a workflow task step, a run, an approval, a reviewed reply. */
  subject?: "ticket" | "step" | "run" | "approval" | "review";
  group: "Volume" | "Speed" | "Service levels" | "Satisfaction" | "Quality" | "Workflows" | "Workload" | "Review";
}

export const HD_MEASURES = {
  created: {
    label: "Tickets created",
    short: "Created",
    unit: "count",
    good: "neutral",
    basis: "event",
    group: "Volume",
    drillDate: "created",
    description: "Tickets and requests raised in the period, workflow tasks included.",
  },
  solved: {
    label: "Tickets solved",
    short: "Solved",
    unit: "count",
    good: "up",
    basis: "event",
    group: "Volume",
    drillDate: "solved",
    description: "Tickets marked solved or closed in the period.",
  },
  reopened: {
    label: "Reopened",
    short: "Reopened",
    unit: "count",
    good: "down",
    basis: "event",
    group: "Quality",
    description: "Times a solved or closed ticket was opened again in the period.",
  },
  backlog: {
    label: "Backlog",
    short: "Backlog",
    unit: "count",
    good: "down",
    basis: "snapshot",
    group: "Volume",
    description: "Tickets still open at the end of the period (or of each day, week or month on a chart).",
  },
  unassigned: {
    label: "Unassigned",
    short: "Unassigned",
    unit: "count",
    good: "down",
    basis: "snapshot",
    group: "Workload",
    description: "Open tickets with nobody assigned at the end of the period, by today's assignments.",
  },
  first_reply_median: {
    label: "First reply time (median)",
    short: "First reply",
    unit: "minutes",
    good: "down",
    basis: "event",
    peopleOnly: true,
    group: "Speed",
    drillDate: "created",
    description: "Business time from a ticket being raised to the first public reply, for tickets created in the period. Half were answered faster.",
  },
  first_reply_p90: {
    label: "First reply time (90th percentile)",
    short: "First reply p90",
    unit: "minutes",
    good: "down",
    basis: "event",
    peopleOnly: true,
    group: "Speed",
    drillDate: "created",
    description: "The business time within which nine in ten tickets created in the period had their first public reply.",
  },
  resolution_median: {
    label: "Resolution time (median)",
    short: "Resolution",
    unit: "minutes",
    good: "down",
    basis: "event",
    group: "Speed",
    drillDate: "solved",
    description: "Business time from raised to solved, less time waiting on the requester or on hold, for tickets solved in the period.",
  },
  resolution_p90: {
    label: "Resolution time (90th percentile)",
    short: "Resolution p90",
    unit: "minutes",
    good: "down",
    basis: "event",
    group: "Speed",
    drillDate: "solved",
    description: "The business time within which nine in ten tickets solved in the period were resolved.",
  },
  sla_first_reply_pct: {
    label: "First reply SLA met",
    short: "Reply SLA",
    unit: "percent",
    good: "up",
    basis: "event",
    group: "Service levels",
    description: "Share of first reply targets due in the period that were met (targets still running are left out).",
  },
  sla_resolution_pct: {
    label: "Resolution SLA met",
    short: "Resolve SLA",
    unit: "percent",
    good: "up",
    basis: "event",
    group: "Service levels",
    description: "Share of resolution targets due in the period that were met (targets still running are left out).",
  },
  sla_breaches: {
    label: "SLA breaches",
    short: "Breaches",
    unit: "count",
    good: "down",
    basis: "event",
    group: "Service levels",
    drill: { breached: "1" },
    description: "Reply and resolution targets missed in the period; a ticket that missed both counts twice.",
  },
  csat_pct: {
    label: "Satisfaction (CSAT)",
    short: "CSAT",
    unit: "percent",
    good: "up",
    basis: "event",
    peopleOnly: true,
    group: "Satisfaction",
    description: "Share of ratings given in the period that were good (4 or 5 out of 5).",
  },
  csat_responses: {
    label: "Satisfaction ratings",
    short: "Ratings",
    unit: "count",
    good: "up",
    basis: "event",
    peopleOnly: true,
    group: "Satisfaction",
    description: "Ratings requesters gave in the period.",
  },
  csat_response_rate: {
    label: "Survey response rate",
    short: "Response rate",
    unit: "percent",
    good: "up",
    basis: "event",
    peopleOnly: true,
    group: "Satisfaction",
    drillDate: "solved",
    description: "Share of requests solved in the period whose requester rated the help.",
  },
  replies_per_ticket: {
    label: "Replies per ticket",
    short: "Replies",
    unit: "ratio",
    good: "down",
    basis: "event",
    peopleOnly: true,
    group: "Quality",
    drillDate: "solved",
    description: "Average public replies from agents on tickets solved in the period.",
  },
  one_touch_pct: {
    label: "One-touch resolution",
    short: "One-touch",
    unit: "percent",
    good: "up",
    basis: "event",
    peopleOnly: true,
    group: "Quality",
    drillDate: "solved",
    description: "Share of tickets solved in the period with a single public reply from an agent.",
  },
  approvals_pending: {
    label: "Approvals pending",
    short: "Pending",
    unit: "count",
    good: "down",
    basis: "snapshot",
    subject: "approval",
    group: "Workflows",
    description: "Approvals still waiting for a decision at the end of the period.",
  },
  approval_decision_median: {
    label: "Approval decision time (median)",
    short: "Decision time",
    unit: "minutes",
    good: "down",
    basis: "event",
    subject: "approval",
    group: "Workflows",
    description: "Calendar time from an approval being asked to its decision, for approvals decided in the period.",
  },
  workflow_started: {
    label: "Workflow runs started",
    short: "Runs started",
    unit: "count",
    good: "neutral",
    basis: "event",
    subject: "run",
    group: "Workflows",
    description: "Workflow runs that began in the period.",
  },
  workflow_finished: {
    label: "Workflow runs finished",
    short: "Runs finished",
    unit: "count",
    good: "up",
    basis: "event",
    subject: "run",
    group: "Workflows",
    description: "Workflow runs that reached their last step in the period.",
  },
  workflow_duration_median: {
    label: "Workflow duration (median)",
    short: "Run time",
    unit: "minutes",
    good: "down",
    basis: "event",
    subject: "run",
    group: "Workflows",
    description: "Calendar time from start to finish, for workflow runs finished in the period.",
  },
  agent_workload: {
    label: "Open tickets assigned",
    short: "Assigned",
    unit: "count",
    good: "neutral",
    basis: "live",
    group: "Workload",
    description: "Open tickets with someone assigned, right now. Split by assignee to see each agent's load.",
  },
  open_now: {
    label: "Open now",
    short: "Open now",
    unit: "count",
    good: "down",
    basis: "live",
    group: "Workload",
    drill: { status_group: "open" },
    description: "Tickets open right now (new, open, waiting or on hold).",
  },
  unassigned_now: {
    label: "Unassigned now",
    short: "Unassigned",
    unit: "count",
    good: "down",
    basis: "live",
    group: "Workload",
    drill: { assignee: "none", status_group: "open" },
    description: "Open tickets with nobody assigned, right now.",
  },
  breaching_now: {
    label: "Breaching now",
    short: "Breaching",
    unit: "count",
    good: "down",
    basis: "live",
    group: "Service levels",
    drill: { breached: "now" },
    description: "Open tickets past a reply or resolution target right now (paused tickets are left out).",
  },
  workflow_team_time_median: {
    label: "Workflow time by team (median)",
    short: "Team time",
    unit: "minutes",
    good: "down",
    basis: "event",
    group: "Workflows",
    subject: "step",
    description: "Business time a team held its workflow task, from the step starting to the team finishing it, in that team's hours. For tasks finished in the period.",
  },
  workflow_team_time_p90: {
    label: "Workflow time by team (90th percentile)",
    short: "Team time p90",
    unit: "minutes",
    good: "down",
    basis: "event",
    group: "Workflows",
    subject: "step",
    description: "The business time within which nine in ten of a team's workflow tasks finished in the period were done.",
  },
  task_pickup_median: {
    label: "Task wait before pickup (median)",
    short: "Pickup wait",
    unit: "minutes",
    good: "down",
    basis: "event",
    group: "Workflows",
    subject: "step",
    description: "Business time from a workflow task starting to someone in the team taking it, for tasks started in the period.",
  },
  task_cant_do_pct: {
    label: "Can't-be-done rate",
    short: "Can't do",
    unit: "percent",
    good: "down",
    basis: "event",
    group: "Workflows",
    subject: "step",
    description: "Share of workflow tasks finished in the period that the team marked as can't be done.",
  },
  steps_skipped: {
    label: "Skipped steps",
    short: "Skipped",
    unit: "count",
    good: "down",
    basis: "event",
    group: "Workflows",
    subject: "step",
    description: "Workflow steps skipped in the period (a declined approval that continues, or a step an admin skipped).",
  },
  reviews_done: {
    label: "Newbie replies reviewed",
    short: "Reviewed",
    unit: "count",
    good: "neutral",
    basis: "event",
    subject: "review",
    group: "Review",
    description: "Replies held for review that a team lead approved or returned in the period.",
  },
  reviews_returned: {
    label: "Newbie replies returned",
    short: "Returned",
    unit: "count",
    good: "down",
    basis: "event",
    subject: "review",
    group: "Review",
    description: "Replies held for review that a team lead sent back with a note in the period.",
  },
} as const satisfies Record<string, HdMeasureDef>;

export type HdMeasureKey = keyof typeof HD_MEASURES;
export const HD_MEASURE_KEYS = Object.keys(HD_MEASURES) as HdMeasureKey[];
export const HD_MEASURE_GROUPS = ["Volume", "Speed", "Service levels", "Satisfaction", "Quality", "Workload", "Workflows", "Review"] as const;

export function isMeasure(v: unknown): v is HdMeasureKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(HD_MEASURES, v);
}
export function measureDef(key: HdMeasureKey): HdMeasureDef {
  return HD_MEASURES[key];
}

// --- Dimensions ---------------------------------------------------------------------

export interface HdDimensionDef {
  label: string;
  /** A caveat the pickers show beside it. */
  hint?: string;
  kind: "time" | "cycle" | "category";
  /** What a drill-down passes to the queue for one value of this dimension. */
  drill?: string;
}

export const HD_DIMENSIONS = {
  day: { label: "Day", kind: "time" },
  week: { label: "Week", kind: "time" },
  month: { label: "Month", kind: "time" },
  weekday: { label: "Day of the week", kind: "cycle" },
  hour: { label: "Hour of the day", kind: "cycle" },
  team: { label: "Team", kind: "category", drill: "team" },
  assignee: { label: "Assignee", kind: "category", drill: "assignee" },
  request_type: { label: "Request type", kind: "category", drill: "request_type" },
  category: { label: "Category", kind: "category", drill: "category" },
  priority: { label: "Priority", kind: "category", drill: "priority" },
  channel: { label: "Channel", kind: "category", drill: "channel" },
  status: { label: "Status", kind: "category", drill: "status" },
  department: { label: "Requester's department", kind: "category", drill: "department" },
  office: { label: "Requester's office", kind: "category", drill: "office" },
  tag: { label: "Tag", kind: "category", drill: "tag" },
  origin: { label: "Origin", kind: "category", drill: "origin" },
  vip: { label: "Requester is a VIP", kind: "category", drill: "vip", hint: "Today's VIP list: someone made a VIP this week counts as one for every past ticket too." },
  integration: { label: "Integration", kind: "category", drill: "integration" },
  workflow: { label: "Workflow", kind: "category" },
  workflow_step: { label: "Workflow step", kind: "category" },
} as const satisfies Record<string, HdDimensionDef>;

export type HdDimension = keyof typeof HD_DIMENSIONS;
export const HD_DIMENSION_KEYS = Object.keys(HD_DIMENSIONS) as HdDimension[];
export const HD_TIME_DIMENSIONS: readonly HdDimension[] = ["day", "week", "month"];

export function isDimension(v: unknown): v is HdDimension {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(HD_DIMENSIONS, v);
}
export const isTimeDim = (d: HdDimension) => HD_DIMENSIONS[d].kind === "time";

/** Dimensions a measure can be split by (live measures have no time; snapshots no cycles). */
export function dimensionsFor(measure: HdMeasureKey): HdDimension[] {
  const def: HdMeasureDef = HD_MEASURES[measure];
  const subject = def.subject ?? "ticket";
  return HD_DIMENSION_KEYS.filter((d) => {
    const kind = HD_DIMENSIONS[d].kind;
    if (def.basis === "live" && kind !== "category") return false;
    if (def.basis === "snapshot" && kind === "cycle") return false;
    // The workflow step is a dimension of task steps only; the workflow, of anything a workflow touches.
    if (d === "workflow_step") return subject === "step";
    if (d === "workflow") return subject !== "review";
    // Automated tickets (alerts, API): split by origin or integration, except where they never count.
    if (d === "origin" || d === "integration") return subject === "ticket" && !def.peopleOnly;
    return true;
  });
}

/** Channels as reports group them: the CompassDocs triggers are one channel. */
export const HD_CHANNELS = ["portal", "desk", "email", "workflow", "trigger", "alert", "api"] as const;
export type HdChannel = (typeof HD_CHANNELS)[number];
export const HD_CHANNEL_LABEL: Record<HdChannel, string> = {
  portal: "Get help",
  desk: "Desk",
  email: "Email",
  workflow: "Workflow task",
  trigger: "From a page",
  alert: "Alert",
  api: "API",
};
/** The ticket sources each channel covers (hd_tickets.source). */
export const HD_CHANNEL_SOURCES: Record<HdChannel, string[]> = {
  portal: ["portal"],
  desk: ["desk"],
  email: ["email"],
  workflow: ["workflow"],
  trigger: ["doc", "handbook", "space_access", "link"],
  alert: ["alert"],
  api: ["api"],
};

/** Who raised it: a person, or a machine (an alert or an API call; hd_tickets.automated). */
export const HD_ORIGIN_LABEL: Record<string, string> = { people: "People", automated: "Automated (alerts and API)" };

export const WEEKDAY_LABEL = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// --- Filters -------------------------------------------------------------------------

/** Ids are numbers; assignee may also be "none" (unassigned). Every list is OR within, AND across. */
export interface HdFilters {
  team?: number[];
  assignee?: (number | "none")[];
  request_type?: number[];
  priority?: HdPriority[];
  channel?: HdChannel[];
  status?: HdStatus[];
  category?: string[];
  tag?: string[];
  /** Workflow ids: the runs, steps and approvals of these workflows, and the tickets they started. */
  workflow?: number[];
  /** Requesters on today's VIP list (yes) or not (no). */
  vip?: ("yes" | "no")[];
}
export const HD_FILTER_KEYS = ["team", "assignee", "request_type", "priority", "channel", "status", "category", "tag", "workflow", "vip"] as const;
export type HdFilterKey = (typeof HD_FILTER_KEYS)[number];
export const HD_FILTER_LABEL: Record<HdFilterKey, string> = {
  team: "Team",
  assignee: "Assignee",
  request_type: "Request type",
  priority: "Priority",
  channel: "Channel",
  status: "Status",
  category: "Category",
  tag: "Tag",
  workflow: "Workflow",
  vip: "VIP requester",
};

export const FILTER_LIMITS = { values: 50, text: 80 } as const;

const posInt = (v: unknown) => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Clean a filters object from JSON or a URL. Unknown keys and values are dropped; errors name the bad key. */
export function parseFilters(raw: unknown): { ok: true; value: HdFilters } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Filters must be an object." };
  const src = raw as Record<string, unknown>;
  const out: HdFilters = {};
  for (const key of Object.keys(src)) {
    if (!(HD_FILTER_KEYS as readonly string[]).includes(key)) return { ok: false, error: `Unknown filter "${key.slice(0, 40)}".` };
    const v = src[key];
    const list = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
    if (list.length > FILTER_LIMITS.values) return { ok: false, error: `Pick up to ${FILTER_LIMITS.values} values for ${HD_FILTER_LABEL[key as HdFilterKey]}.` };
    if (!list.length) continue;
    const k = key as HdFilterKey;
    const bad = () => ({ ok: false as const, error: `Unknown ${HD_FILTER_LABEL[k].toLowerCase()} in the filters.` });
    switch (k) {
      case "team":
      case "workflow":
      case "request_type": {
        const ids = list.map(posInt);
        if (ids.some((x) => x === null)) return bad();
        out[k] = [...new Set(ids as number[])];
        break;
      }
      case "assignee": {
        const ids = list.map((x) => (x === "none" ? "none" : posInt(x)));
        if (ids.some((x) => x === null)) return bad();
        out.assignee = [...new Set(ids as (number | "none")[])];
        break;
      }
      case "priority":
        if (!list.every((x) => (HD_PRIORITIES as readonly unknown[]).includes(x))) return bad();
        out.priority = [...new Set(list as HdPriority[])];
        break;
      case "status":
        if (!list.every((x) => (HD_STATUSES as readonly unknown[]).includes(x))) return bad();
        out.status = [...new Set(list as HdStatus[])];
        break;
      case "channel":
        if (!list.every((x) => (HD_CHANNELS as readonly unknown[]).includes(x))) return bad();
        out.channel = [...new Set(list as HdChannel[])];
        break;
      case "vip":
        if (!list.every((x) => x === "yes" || x === "no")) return bad();
        out.vip = [...new Set(list as ("yes" | "no")[])];
        break;
      case "category":
      case "tag":
        if (!list.every((x) => typeof x === "string" && x.length <= FILTER_LIMITS.text)) return bad();
        out[k] = [...new Set((list as string[]).map((s) => s.trim()))];
        break;
    }
  }
  return { ok: true, value: out };
}

/** A widget's own filters replace the dashboard's for the keys they set. */
export function mergeFilters(dashboard: HdFilters, widget: HdFilters | undefined): HdFilters {
  const out: HdFilters = { ...dashboard };
  for (const k of HD_FILTER_KEYS) {
    const v = widget?.[k];
    if (v && v.length) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function filtersEmpty(f: HdFilters): boolean {
  return HD_FILTER_KEYS.every((k) => !f[k]?.length);
}

// --- Date ranges ----------------------------------------------------------------------

export const HD_PRESETS = {
  today: "Today",
  yesterday: "Yesterday",
  last_7: "Last 7 days",
  last_30: "Last 30 days",
  last_90: "Last 90 days",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  last_12_months: "Last 12 months",
  this_year: "This year",
} as const;
export type HdPreset = keyof typeof HD_PRESETS;
export const HD_PRESET_KEYS = Object.keys(HD_PRESETS) as HdPreset[];
export function isPreset(v: unknown): v is HdPreset {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(HD_PRESETS, v);
}

/** A range as asked: a preset, or custom dates ("YYYY-MM-DD", inclusive, in the helpdesk's time zone). */
export type HdRangeInput = { preset: HdPreset } | { from: string; to: string };
export type HdCompare = "previous_period" | "previous_year";
export const HD_COMPARE_LABEL: Record<HdCompare, string> = {
  previous_period: "Previous period",
  previous_year: "Same period last year",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
function isoDow(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
}
function shiftYears(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  // 29 February a year away is the 28th.
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  return `${y + n}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** A preset's dates, given today's date in the helpdesk's zone. */
export function presetDates(preset: HdPreset, today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number);
  const mm = (n: number) => String(n).padStart(2, "0");
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const d = addDays(today, -1);
      return { from: d, to: d };
    }
    case "last_7":
      return { from: addDays(today, -6), to: today };
    case "last_30":
      return { from: addDays(today, -29), to: today };
    case "last_90":
      return { from: addDays(today, -89), to: today };
    case "this_week":
      return { from: addDays(today, 1 - isoDow(today)), to: today };
    case "last_week": {
      const mon = addDays(today, 1 - isoDow(today) - 7);
      return { from: mon, to: addDays(mon, 6) };
    }
    case "this_month":
      return { from: `${y}-${mm(m)}-01`, to: today };
    case "last_month": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: `${py}-${mm(pm)}-01`, to: addDays(`${y}-${mm(m)}-01`, -1) };
    }
    case "this_quarter": {
      const qm = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: `${y}-${mm(qm)}-01`, to: today };
    }
    case "last_12_months":
      return { from: addDays(shiftYears(today, -1), 1), to: today };
    case "this_year":
      return { from: `${y}-01-01`, to: today };
  }
}

/** The comparison period: the same length just before, or the same dates a year earlier. */
export function compareDates(range: { from: string; to: string }, compare: HdCompare): { from: string; to: string } {
  if (compare === "previous_year") return { from: shiftYears(range.from, -1), to: shiftYears(range.to, -1) };
  const n = daysBetween(range.from, range.to);
  return { from: addDays(range.from, -n), to: addDays(range.from, -1) };
}

export function isDate(v: unknown): v is string {
  return typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

export function parseRangeInput(raw: unknown): HdRangeInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (isPreset(r.preset)) return { preset: r.preset };
  if (isDate(r.from) && isDate(r.to)) return { from: r.from, to: r.to };
  return null;
}

export function rangeLabel(r: HdRangeInput): string {
  return "preset" in r ? HD_PRESETS[r.preset] : `${r.from} to ${r.to}`;
}

// --- Queries -----------------------------------------------------------------------------

export interface HdAnalyticsQuery {
  measure: HdMeasureKey;
  /** At most two; a second splits each bar or line by it. */
  groupBy?: HdDimension[];
  filters?: HdFilters;
  range: HdRangeInput;
  compare?: HdCompare | null;
  /** Rows kept per categorical dimension (largest first); the rest fold into "Other". */
  limit?: number;
  /** Count automated tickets (alerts, API) too. Off by default: alerts can swamp the volume a desk is judged on. */
  automated?: boolean;
}

export const QUERY_LIMITS = { groupBy: 2, rows: 50, maxRows: 500 } as const;

export function parseQuery(raw: unknown): { ok: true; value: HdAnalyticsQuery } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send the query as JSON." };
  const q = raw as Record<string, unknown>;
  if (!isMeasure(q.measure)) return { ok: false, error: "Unknown measure." };
  const groupBy = q.groupBy === undefined || q.groupBy === null ? [] : q.groupBy;
  if (!Array.isArray(groupBy) || groupBy.length > QUERY_LIMITS.groupBy) return { ok: false, error: "Split by at most two dimensions." };
  if (!groupBy.every(isDimension)) return { ok: false, error: "Unknown dimension." };
  if (new Set(groupBy).size !== groupBy.length) return { ok: false, error: "Pick two different dimensions." };
  const allowed = dimensionsFor(q.measure);
  const dims = groupBy as HdDimension[];
  const bad = dims.find((d) => !allowed.includes(d));
  if (bad) return { ok: false, error: `${HD_MEASURES[q.measure].label} can't be split by ${HD_DIMENSIONS[bad].label.toLowerCase()}.` };
  if (dims.filter((d) => HD_DIMENSIONS[d].kind !== "category").length > 1 && !(dims[0] === "weekday" && dims[1] === "hour")) {
    return { ok: false, error: "Use one time dimension at a time (day of the week by hour is the exception)." };
  }
  const filters = parseFilters(q.filters);
  if (!filters.ok) return filters;
  const range = parseRangeInput(q.range ?? { preset: "last_30" });
  if (!range) return { ok: false, error: "Pick a date range." };
  let compare: HdCompare | null = null;
  if (q.compare !== undefined && q.compare !== null && q.compare !== "") {
    if (q.compare !== "previous_period" && q.compare !== "previous_year") return { ok: false, error: "Unknown comparison." };
    compare = q.compare;
  }
  let limit: number = QUERY_LIMITS.rows;
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > QUERY_LIMITS.maxRows) return { ok: false, error: `Show between 1 and ${QUERY_LIMITS.maxRows} rows.` };
    limit = n;
  }
  return { ok: true, value: { measure: q.measure, groupBy: dims, filters: filters.value, range, compare, limit, automated: q.automated === true } };
}

export type HdKey = string | number | null;

export interface HdResultRow {
  /** One key per groupBy dimension (ids for teams/people/types, codes for the rest, "YYYY-MM-DD" for time). */
  keys: HdKey[];
  labels: string[];
  value: number | null;
  /** How many tickets/events the value rests on (the denominator of a percentage, the sample of a median). */
  n: number;
}

export interface HdQueryResult {
  measure: HdMeasureKey;
  unit: HdUnit;
  groupBy: HdDimension[];
  range: { from: string; to: string; timezone: string; label: string };
  rows: HdResultRow[];
  total: { value: number | null; n: number };
  compare?: {
    kind: HdCompare;
    range: { from: string; to: string };
    total: { value: number | null; n: number };
    /** value − compare value (in the measure's unit); null when either is missing. */
    delta: number | null;
    /** The change as a percentage of the comparison value. */
    delta_pct: number | null;
    /** Only for one time dimension: the comparison series, by position. */
    rows?: HdResultRow[];
  };
  /** Rows beyond the limit were folded into "Other" (categorical) or cut (time). */
  truncated: boolean;
  generated_at: string;
  cached: boolean;
  /** Small-sample warning: a percentage or median on fewer than 5. */
  low_sample: boolean;
}

// --- Widgets and dashboards ---------------------------------------------------------------

export const HD_WIDGET_TYPES = {
  kpi: { label: "Number", description: "One number, its change against the comparison period, and a sparkline." },
  line: { label: "Line over time", description: "A measure day by day, week by week or month by month." },
  area: { label: "Area over time", description: "Like a line, with the area under it shaded." },
  bar: { label: "Ranked bars", description: "Horizontal bars, largest first, for teams, agents or categories." },
  stacked: { label: "Stacked bars", description: "Bars split by a second dimension, over time or by category." },
  table: { label: "Table", description: "Sortable rows; click one to open its tickets." },
  donut: { label: "Donut", description: "Parts of a whole, for up to five parts (channels, priorities)." },
  gauge: { label: "SLA gauge", description: "A percentage against a target, as a progress bar." },
  heatmap: { label: "Heatmap", description: "Tickets created by day of the week and hour of the day." },
  leaderboard: { label: "Leaderboard", description: "Agents ranked by a measure." },
  live: { label: "Live number", description: "Right now: the backlog, unassigned, breaching. Refreshes every minute." },
} as const;
export type HdWidgetType = keyof typeof HD_WIDGET_TYPES;
export const HD_WIDGET_TYPE_KEYS = Object.keys(HD_WIDGET_TYPES) as HdWidgetType[];

export interface HdTarget {
  value: number;
  /** Optional amber band: within this distance of the target is "close". */
  warn?: number;
}

export interface HdWidget {
  id: string;
  type: HdWidgetType;
  title: string;
  measure: HdMeasureKey;
  groupBy: HdDimension[];
  /** Override the dashboard's filters for the keys set here. */
  filters: HdFilters;
  /** Columns of a four-column grid. */
  size: 1 | 2 | 3 | 4;
  target?: HdTarget | null;
}

export interface HdDashboardLayout {
  widgets: HdWidget[];
  /** Dashboard-level defaults (the filter bar starts here). */
  filters: HdFilters;
  range: HdRangeInput;
  compare: HdCompare | null;
  /** Include automated tickets (alerts, API) in the numbers. */
  automated?: boolean;
}

export type HdVisibility = "private" | "team" | "everyone";
export const HD_VISIBILITY_LABEL: Record<HdVisibility, string> = {
  private: "Only me",
  team: "A team",
  everyone: "Everyone who reads reports",
};

export interface HdDashboard {
  id: number;
  name: string;
  description: string;
  owner_id: number | null;
  owner_name: string | null;
  visibility: HdVisibility;
  team_id: number | null;
  team_name: string | null;
  layout: HdDashboardLayout;
  is_default: number;
  /** A built-in template's key (read-only; duplicate to change it). */
  builtin: string | null;
  created_at: string;
  updated_at: string;
  /** For the viewer. */
  can_edit: boolean;
}

export const DASHBOARD_LIMITS = { name: 80, description: 300, widgets: 24, title: 80, dashboardsPerUser: 50 } as const;

/** What each widget type needs. Errors are sentences for the config panel. */
export function widgetProblem(w: Pick<HdWidget, "type" | "measure" | "groupBy">): string | null {
  const def = HD_MEASURES[w.measure];
  const dims = w.groupBy;
  const time = dims.length && isTimeDim(dims[0]);
  switch (w.type) {
    case "kpi":
      if (dims.length) return "A number shows one total: remove the split.";
      if (def.basis === "live") return "Use a live number for a right-now measure.";
      return null;
    case "live":
      if (def.basis !== "live") return "A live number needs a right-now measure (open now, unassigned now, breaching now, assigned).";
      if (dims.length) return "A live number shows one total: remove the split.";
      return null;
    case "line":
    case "area":
      if (!time) return "Split a chart over time by day, week or month first.";
      if (dims.length > 2) return "Split by at most one more dimension.";
      return null;
    case "bar":
    case "leaderboard":
      if (dims.length !== 1 || HD_DIMENSIONS[dims[0]].kind === "time") return "Ranked bars need one split that isn't time (team, assignee, category…).";
      if (w.type === "leaderboard" && dims[0] !== "assignee") return "A leaderboard ranks agents: split by assignee.";
      return null;
    case "stacked":
      if (dims.length !== 2) return "Stacked bars need two splits: what the bars are, and what stacks inside them.";
      if (def.unit !== "count") return "Stack counts only: percentages and times don't add up.";
      return null;
    case "table":
      if (!dims.length) return "A table needs at least one split.";
      return null;
    case "donut":
      if (dims.length !== 1 || HD_DIMENSIONS[dims[0]].kind !== "category") return "A donut needs one split into parts (channel, priority, status).";
      if (def.unit !== "count") return "A donut shows parts of a whole count.";
      return null;
    case "gauge":
      if (def.unit !== "percent") return "A gauge shows a percentage (SLA met, CSAT, one-touch).";
      if (dims.length) return "A gauge shows one total: remove the split.";
      return null;
    case "heatmap":
      if (dims[0] !== "weekday" || dims[1] !== "hour") return "A heatmap is by day of the week and hour of the day.";
      return null;
  }
}

let widgetSeq = 0;
export function newWidgetId(): string {
  widgetSeq = (widgetSeq + 1) % 1e6;
  return `w${Date.now().toString(36)}${widgetSeq.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** Validate one widget from JSON. */
export function parseWidget(raw: unknown): { ok: true; value: HdWidget } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "A widget must be an object." };
  const w = raw as Record<string, unknown>;
  const type = w.type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(HD_WIDGET_TYPES, type)) return { ok: false, error: "Unknown widget type." };
  if (!isMeasure(w.measure)) return { ok: false, error: "Unknown measure." };
  const title = typeof w.title === "string" ? w.title.trim().slice(0, DASHBOARD_LIMITS.title) : "";
  const groupBy = Array.isArray(w.groupBy) ? w.groupBy : [];
  if (groupBy.length > QUERY_LIMITS.groupBy || !groupBy.every(isDimension)) return { ok: false, error: "Unknown split." };
  const allowed = dimensionsFor(w.measure);
  if (!(groupBy as HdDimension[]).every((d) => allowed.includes(d))) return { ok: false, error: `${HD_MEASURES[w.measure].label} can't be split that way.` };
  const filters = parseFilters(w.filters);
  if (!filters.ok) return filters;
  const size = Number(w.size);
  if (![1, 2, 3, 4].includes(size)) return { ok: false, error: "A widget is one to four columns wide." };
  let target: HdTarget | null = null;
  if (w.target !== undefined && w.target !== null) {
    const t = w.target as Record<string, unknown>;
    const value = Number(t.value);
    if (!Number.isFinite(value) || value < 0 || value > 1e9) return { ok: false, error: "The target must be a number." };
    const warn = t.warn === undefined || t.warn === null || t.warn === "" ? undefined : Number(t.warn);
    if (warn !== undefined && (!Number.isFinite(warn) || warn < 0 || warn > 1e9)) return { ok: false, error: "The warning band must be a number." };
    target = warn === undefined ? { value } : { value, warn };
  }
  const id = typeof w.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(w.id) ? w.id : newWidgetId();
  const value: HdWidget = {
    id,
    type: type as HdWidgetType,
    title: title || HD_MEASURES[w.measure].label,
    measure: w.measure,
    groupBy: groupBy as HdDimension[],
    filters: filters.value,
    size: size as HdWidget["size"],
    target,
  };
  const problem = widgetProblem(value);
  if (problem) return { ok: false, error: `${value.title}: ${problem}` };
  return { ok: true, value };
}

export function parseLayout(raw: unknown): { ok: true; value: HdDashboardLayout } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The layout must be an object." };
  const l = raw as Record<string, unknown>;
  const list = Array.isArray(l.widgets) ? l.widgets : [];
  if (list.length > DASHBOARD_LIMITS.widgets) return { ok: false, error: `A dashboard holds up to ${DASHBOARD_LIMITS.widgets} widgets.` };
  const widgets: HdWidget[] = [];
  const ids = new Set<string>();
  for (const raw of list) {
    const w = parseWidget(raw);
    if (!w.ok) return w;
    if (ids.has(w.value.id)) w.value.id = newWidgetId();
    ids.add(w.value.id);
    widgets.push(w.value);
  }
  const filters = parseFilters(l.filters);
  if (!filters.ok) return filters;
  const range = parseRangeInput(l.range) ?? { preset: "last_30" as const };
  const compare = l.compare === "previous_period" || l.compare === "previous_year" ? l.compare : null;
  return { ok: true, value: { widgets, filters: filters.value, range, compare, automated: l.automated === true } };
}

// --- Formatting ------------------------------------------------------------------------------

const nf = new Intl.NumberFormat("en-GB");
const nf1 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });

/** Business minutes as "45m", "3h 20m", "2.5d" (an 8-hour-ish business day is not assumed: days are 24h of the measure's minutes / 1440 only past 72h). */
export function formatMinutes(min: number): string {
  if (min <= 0) return "0m";
  if (min < 1) return "<1m";
  if (min < 60) return `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 10) {
    const hh = Math.floor(h);
    const mm = Math.round(min - hh * 60);
    return mm ? `${hh}h ${mm}m` : `${hh}h`;
  }
  if (h < 72) return `${Math.round(h)}h`;
  return `${nf1.format(h / 24)}d`;
}

/** Compact counts on axes and tiles: 1,284 · 12.9K · 4.2M. */
export function formatCompact(n: number): string {
  const a = Math.abs(n);
  if (a < 10_000) return nf.format(Math.round(n * 10) / 10);
  if (a < 1_000_000) return `${nf1.format(n / 1000)}K`;
  return `${nf1.format(n / 1_000_000)}M`;
}

export function formatValue(v: number | null | undefined, unit: HdUnit, opts: { compact?: boolean } = {}): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  switch (unit) {
    case "count":
      return opts.compact ? formatCompact(v) : nf.format(Math.round(v));
    case "minutes":
      return formatMinutes(v);
    case "percent":
      return `${nf1.format(v)}%`;
    case "ratio":
      return nf1.format(v);
  }
}

/** "+12%" / "−3 pts" / "+45m": how a delta reads for a unit. */
export function formatDelta(delta: number | null, deltaPct: number | null, unit: HdUnit): string {
  if (delta === null) return "";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  const a = Math.abs(delta);
  if (unit === "percent") return `${sign}${nf1.format(a)} pts`;
  if (unit === "minutes") return `${sign}${formatMinutes(a)}`;
  if (deltaPct !== null && unit === "count") return `${sign}${nf1.format(Math.abs(deltaPct))}%`;
  return `${sign}${unit === "ratio" ? nf1.format(a) : nf.format(Math.round(a))}`;
}

/** "1,284 · +12% vs previous period": a widget's headline for the digest and the PDF. */
export function headline(r: Pick<HdQueryResult, "total" | "unit" | "compare">): { value: string; change: string } {
  return {
    value: formatValue(r.total.value, r.unit),
    change: r.compare ? formatDelta(r.compare.delta, r.compare.delta_pct, r.unit) : "",
  };
}

/** Whether a change is good, bad or neither for this measure. */
export function deltaTone(delta: number | null, good: HdGood): "good" | "bad" | "flat" {
  if (delta === null || delta === 0 || good === "neutral") return "flat";
  return (delta > 0) === (good === "up") ? "good" : "bad";
}

/** A value against a target: met, close (within warn) or missed, honouring the good direction. */
export function targetState(v: number | null, target: HdTarget | null | undefined, good: HdGood): "met" | "close" | "missed" | null {
  if (v === null || !target) return null;
  const lowerIsBetter = good === "down";
  const met = lowerIsBetter ? v <= target.value : v >= target.value;
  if (met) return "met";
  const gap = Math.abs(v - target.value);
  if (target.warn !== undefined && gap <= target.warn) return "close";
  return "missed";
}

/** Labels for code-valued dimension keys (ids are labelled by the engine). */
export function codeLabel(dim: HdDimension, key: HdKey): string {
  if (key === null || key === "") {
    if (dim === "assignee") return "Unassigned";
    if (dim === "team") return "No team";
    if (dim === "request_type") return "No request type";
    if (dim === "tag") return "No tag";
    if (dim === "integration") return "No integration";
    return "Not set";
  }
  switch (dim) {
    case "priority":
      return HD_PRIORITY_LABEL[key as HdPriority] ?? String(key);
    case "status":
      return HD_STATUS_LABEL[key as HdStatus] ?? String(key);
    case "channel":
      return HD_CHANNEL_LABEL[key as HdChannel] ?? String(key);
    case "weekday":
      return WEEKDAY_LABEL[Number(key)] ?? String(key);
    case "hour":
      return `${String(key).padStart(2, "0")}:00`;
    case "origin":
      return HD_ORIGIN_LABEL[String(key)] ?? String(key);
    case "vip":
      return key === "yes" ? "VIP" : "Not a VIP";
    default:
      return String(key);
  }
}

// --- Drill-down -------------------------------------------------------------------------------

/**
 * The desk queue's address for the tickets behind one value (D's
 * /desk?from=reports&… drill-down, components/helpdesk/desk/queue/views).
 * Parameters: team, assignee (id | none), priority, request_type, channel,
 * status, tag, category, department, office, created_from/created_to or
 * solved_from/solved_to ("YYYY-MM-DD", inclusive, the helpdesk's zone),
 * breached (1 | now), status_group (open). Null when the measure has no
 * ticket list (workflow runs, approvals).
 */
export function drillHref(
  measure: HdMeasureKey,
  groupBy: HdDimension[],
  keys: HdKey[],
  filters: HdFilters,
  range: { from: string; to: string },
  opts: { automated?: boolean } = {}
): string | null {
  const def: HdMeasureDef = HD_MEASURES[measure];
  if (def.group === "Workflows" || def.group === "Review") return null;
  if (groupBy.includes("workflow") || groupBy.includes("workflow_step")) return null;
  const p = new URLSearchParams({ from: "reports" });
  const one = (k: string, v: string | number) => p.set(k, String(v));
  // Filters first (a single value travels; several are left to the list's own filters).
  for (const k of HD_FILTER_KEYS) {
    const v = filters[k];
    if (k === "workflow") continue;
    if (v && v.length === 1) one(k, v[0] as string | number);
  }
  for (const [k, v] of Object.entries(def.drill ?? {})) one(k, v);
  // The report left automated tickets (alerts, API) out, so the list does too.
  if ((!opts.automated || def.peopleOnly) && !groupBy.includes("origin") && !groupBy.includes("integration")) one("origin", "people");
  let from = range.from;
  let to = range.to;
  groupBy.forEach((d, i) => {
    const key = keys[i];
    const dimDef: HdDimensionDef = HD_DIMENSIONS[d];
    if (dimDef.kind === "time" && typeof key === "string") {
      from = key.length === 7 ? `${key}-01` : key;
      if (d === "day") to = key;
      else if (d === "week") to = addDays(key, 6);
      else {
        const [y, m] = key.split("-").map(Number);
        to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      }
      if (from < range.from) from = range.from;
      if (to > range.to) to = range.to;
    } else if (dimDef.drill) {
      one(dimDef.drill, key === null || key === "" ? "none" : key);
    }
  });
  if (def.basis !== "live") {
    const which = def.drillDate ?? "created";
    one(`${which}_from`, from);
    one(`${which}_to`, to);
  }
  return `/desk?${p.toString()}`;
}
