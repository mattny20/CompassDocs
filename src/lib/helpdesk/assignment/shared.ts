// Helpdesk 1.19.0: ticket assignment (agent N), the pure half. Types, labels,
// input checks, rule matching, the round-robin and load-balancing picks and
// the on-call rotation arithmetic. No database and no server-only imports,
// so the settings screens import it too, and the tests can check the
// arithmetic without fixtures. The engine (./engine) feeds it facts it
// loaded and acts on what it answers.

import { wallClock, zonedInstant } from "../sla";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, HD_SOURCE_LABEL, type HdPriority } from "../types";
import { HD_ROLES, HD_ROLE_LABEL, HD_ROLE_RANK, type HdRole } from "../roles-shared";
import { validateSkillCriteria, type HdSkillCriteria } from "../skills/shared";

// --- Team settings ---------------------------------------------------------------------

export const HD_ASSIGN_MODES = ["manual", "round_robin", "load_balanced"] as const;
export type HdAssignMode = (typeof HD_ASSIGN_MODES)[number];

export const HD_ASSIGN_MODE_LABEL: Record<HdAssignMode, string> = {
  manual: "Manual",
  round_robin: "Round robin",
  load_balanced: "Load balanced",
};

/** The plain-language card text under each mode. */
export const HD_ASSIGN_MODE_HINT: Record<HdAssignMode, string> = {
  manual: "New tickets wait in the team's queue. Agents take them, or a lead assigns them.",
  round_robin: "New tickets go to the next person in turn. People with a higher weight get more turns.",
  load_balanced: "New tickets go to whoever has the fewest open tickets right now.",
};

export const HD_ELIGIBILITY = ["available", "available_or_away"] as const;
export type HdEligibility = (typeof HD_ELIGIBILITY)[number];
export const HD_ELIGIBILITY_LABEL: Record<HdEligibility, string> = {
  available: "Available only",
  available_or_away: "Available or away",
};

/** The desk roles that can take auto-assigned tickets. */
export const HD_ASSIGN_ROLE_CHOICES: readonly HdRole[] = HD_ROLES;
export const HD_DEFAULT_INCLUDE_ROLES: HdRole[] = ["agent", "team_lead"];

export interface HdTeamAssignment {
  team_id: number;
  mode: HdAssignMode;
  eligible: HdEligibility;
  include_roles: HdRole[];
  /** null = no limit. Counts the person's open tickets in every team. */
  max_open_per_agent: number | null;
  /** 1 = only while the team's calendar is open; outside hours tickets wait in the queue. */
  respect_shift: number;
  /** 1 = prefer whoever last solved a ticket for this requester. */
  sticky_requester: number;
  /** 1 = move tickets on when their owner goes away or offline. */
  reassign_when_away: number;
  /** Reassign when the owner has not replied within this many business minutes; null = never. */
  unanswered_minutes: number | null;
  updated_by: number | null;
  updated_at: string | null;
}

export function defaultTeamAssignment(teamId: number): HdTeamAssignment {
  return {
    team_id: teamId,
    mode: "manual",
    eligible: "available",
    include_roles: [...HD_DEFAULT_INCLUDE_ROLES],
    max_open_per_agent: null,
    respect_shift: 1,
    sticky_requester: 0,
    reassign_when_away: 0,
    unanswered_minutes: null,
    updated_by: null,
    updated_at: null,
  };
}

export const ASSIGNMENT_LIMITS = {
  weight: 10,
  capacity: 500,
  unanswered: 60 * 24 * 10,
  rules: 200,
  ruleName: 120,
  conditions: 12,
  value: 200,
  values: 50,
  tags: 10,
  tag: 40,
  rotation: 50,
  rotationDays: 28,
  overrides: 200,
  /** Automatic reassignments of one ticket (away, unanswered). */
  maxAutoReassigns: 3,
  /** An owner must have been away this long before their tickets move. */
  awayGraceMinutes: 10,
} as const;

/** The member list's row (GET team settings). */
export interface HdAssignmentMemberView {
  user_id: number;
  name: string;
  email: string;
  role: HdRole | null;
  role_label: string;
  weight: number;
  paused: number;
  availability: "available" | "away" | "offline";
  open_count: number;
  last_assigned_at: string | null;
  /** Why auto-assignment would pass them over right now; '' = they can take tickets. */
  skip_reason: string;
}

// --- Rules -------------------------------------------------------------------------

export const HD_ASSIGN_OPS = ["equals", "not_equals", "in", "not_in", "contains", "not_contains", "is_empty", "not_empty", "is_true", "is_false"] as const;
export type HdAssignOp = (typeof HD_ASSIGN_OPS)[number];

export const HD_ASSIGN_OP_LABEL: Record<HdAssignOp, string> = {
  equals: "is",
  not_equals: "is not",
  in: "is any of",
  not_in: "is none of",
  contains: "contains any of",
  not_contains: "contains none of",
  is_empty: "is empty",
  not_empty: "is not empty",
  is_true: "yes",
  is_false: "no",
};

export type HdAssignFieldKind = "choice" | "text" | "bool";

export interface HdAssignFieldDef {
  label: string;
  group: string;
  kind: HdAssignFieldKind;
  ops: readonly HdAssignOp[];
  /** Fixed choices (source, priority, hours); team/request type/integration choices come from the server. */
  options?: { value: string; label: string }[];
}

/** Sources a ticket can come in through, including machine intake (agent P). */
export const HD_ASSIGN_SOURCES: { value: string; label: string }[] = (() => {
  const labels: Record<string, string> = { ...HD_SOURCE_LABEL, alert: "Alert (monitoring)", api: "API" };
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
})();

const CHOICE_OPS: readonly HdAssignOp[] = ["in", "not_in"];
const TEXT_OPS: readonly HdAssignOp[] = ["contains", "not_contains", "equals", "not_equals", "in", "is_empty", "not_empty"];
const BOOL_OPS: readonly HdAssignOp[] = ["is_true", "is_false"];

/**
 * What a rule can check. Keys are stable (stored in rules); answer fields are
 * "answer:<form key>". Requester fields never match a ticket without a
 * person behind it (an alert or API ticket).
 */
export const HD_ASSIGN_FIELDS = {
  source: { label: "Came in through", group: "Ticket", kind: "choice", ops: CHOICE_OPS, options: HD_ASSIGN_SOURCES },
  automated: { label: "Sender is automated", group: "Ticket", kind: "bool", ops: BOOL_OPS },
  integration: { label: "Integration", group: "Ticket", kind: "choice", ops: CHOICE_OPS },
  request_type: { label: "Request type", group: "Ticket", kind: "choice", ops: CHOICE_OPS },
  team: { label: "Team", group: "Ticket", kind: "choice", ops: CHOICE_OPS },
  priority: {
    label: "Priority",
    group: "Ticket",
    kind: "choice",
    ops: CHOICE_OPS,
    options: HD_PRIORITIES.map((p) => ({ value: p, label: HD_PRIORITY_LABEL[p] })),
  },
  category: { label: "Category", group: "Ticket", kind: "text", ops: TEXT_OPS },
  tags: { label: "Tags", group: "Ticket", kind: "choice", ops: ["in", "not_in", "is_empty", "not_empty"] },
  // 1.19.2 (agent W2): the ticket's language (lib/helpdesk/skills); the choices are the workspace's languages.
  language: { label: "Ticket language", group: "Ticket", kind: "choice", ops: ["equals", "not_equals", "is_empty", "not_empty"] },
  subject: { label: "Subject", group: "Words", kind: "text", ops: ["contains", "not_contains"] },
  body: { label: "First message", group: "Words", kind: "text", ops: ["contains", "not_contains"] },
  text: { label: "Subject or first message", group: "Words", kind: "text", ops: ["contains", "not_contains"] },
  requester_department: { label: "Requester's department", group: "Requester", kind: "text", ops: TEXT_OPS },
  requester_office: { label: "Requester's office", group: "Requester", kind: "text", ops: TEXT_OPS },
  requester_vip: { label: "Requester is a VIP", group: "Requester", kind: "bool", ops: BOOL_OPS },
  hours: {
    label: "Team's office hours",
    group: "When",
    kind: "choice",
    ops: ["equals"],
    options: [
      { value: "open", label: "Open" },
      { value: "closed", label: "Closed" },
    ],
  },
} as const satisfies Record<string, HdAssignFieldDef>;

export type HdAssignFixedField = keyof typeof HD_ASSIGN_FIELDS;
export const ANSWER_PREFIX = "answer:";
export const ANSWER_OPS: readonly HdAssignOp[] = ["equals", "not_equals", "in", "contains", "is_empty", "not_empty", "is_true", "is_false"];

export interface HdAssignCondition {
  /** A key of HD_ASSIGN_FIELDS, or "answer:<form key>". */
  field: string;
  op: HdAssignOp;
  value?: string | string[];
}

export interface HdAssignConditions {
  match: "all" | "any";
  rules: HdAssignCondition[];
}

export const HD_ASSIGN_ACTIONS = ["team_mode", "skills", "user", "round_robin_in_team", "load_balanced_in_team", "on_call", "leave_unassigned"] as const;
export type HdAssignActionKind = (typeof HD_ASSIGN_ACTIONS)[number];

export const HD_ASSIGN_ACTION_LABEL: Record<HdAssignActionKind, string> = {
  team_mode: "The team's turn",
  skills: "An agent with the right skills or language",
  user: "A specific person",
  round_robin_in_team: "Round robin in the team",
  load_balanced_in_team: "Least busy in the team",
  on_call: "Whoever is on call",
  leave_unassigned: "Leave it in the queue",
};

/** One sentence under each choice in the rule editor. */
export const HD_ASSIGN_ACTION_HINT: Record<HdAssignActionKind, string> = {
  team_mode: "Round robin or load balanced, as the team is set up.",
  skills: "Among available agents of the team, in turn.",
  user: "Always the same person, if they can work the team's tickets.",
  round_robin_in_team: "The next person in turn, whatever the team is set to.",
  load_balanced_in_team: "Whoever has the fewest open tickets right now.",
  on_call: "The team's on-call person right now.",
  leave_unassigned: "Nobody is assigned; it waits for someone to take it.",
};

/** Roles a rule may require (min_role): Agent and up. */
export const HD_MIN_ROLES: readonly HdRole[] = ["agent", "team_lead", "manager"];

export interface HdAssignAction {
  /** Move the ticket to this team first (null/absent = keep). */
  team_id?: number | null;
  assign: HdAssignActionKind;
  /** With assign 'user'. */
  user_id?: number | null;
  /** Only people with at least this desk role (VIP and urgent work to seniors). */
  min_role?: HdRole | null;
  /** A priority, or 'from_severity' (the alert's severity: critical → Urgent, high → High, warning → Normal, info → Low). */
  set_priority?: HdPriority | "from_severity" | null;
  add_tags?: string[];
  /** With assign 'skills' (1.19.2, agent W2): the language and skills the agent needs, and what happens when nobody matching is available. */
  skills?: HdSkillCriteria;
}

export interface HdAssignmentRule {
  id: number;
  name: string;
  position: number;
  enabled: number;
  /** null = every team. */
  scope_team_id: number | null;
  conditions: HdAssignConditions;
  action: HdAssignAction;
  /** 1 = stop at this rule when it matches. */
  stop: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

// --- Log -----------------------------------------------------------------------------

export const HD_ASSIGN_METHODS = [
  "rule",
  "round_robin",
  "load_balanced",
  "sticky",
  "manual",
  "automation",
  "reassign_away",
  "reassign_unanswered",
  "on_call",
  "skills",
] as const;
export type HdAssignMethod = (typeof HD_ASSIGN_METHODS)[number];

export const HD_ASSIGN_METHOD_LABEL: Record<HdAssignMethod, string> = {
  rule: "Rule",
  round_robin: "Round robin",
  load_balanced: "Load balanced",
  sticky: "Same as last time",
  manual: "By hand",
  automation: "Automation",
  reassign_away: "Owner away",
  reassign_unanswered: "No first reply",
  on_call: "On call",
  skills: "Skills and language",
};

export interface HdAssignmentLogEntry {
  id: number;
  ticket_id: number;
  at: string;
  method: HdAssignMethod;
  rule_id: number | null;
  rule_name: string;
  from_user_id: number | null;
  from_name: string | null;
  to_user_id: number | null;
  to_name: string | null;
  team_id: number | null;
  team_name: string | null;
  actor_id: number | null;
  actor_name: string | null;
  reason: string;
}

export type HdAssignTrigger = "created" | "team_changed" | "reopened" | "agent_away" | "unanswered" | "manual_request" | "retry";

// --- On call ----------------------------------------------------------------------------

export interface HdOnCallRotation {
  team_id: number;
  user_ids: number[];
  length_days: number;
  /** "HH:MM" in `timezone`. */
  handover_time: string;
  timezone: string;
  /** "YYYY-MM-DD": the first handover's date. */
  starts_on: string;
  updated_by?: number | null;
  updated_at?: string | null;
}

export interface HdOnCallShift {
  user_id: number;
  starts_at: string;
  ends_at: string;
  source: "rotation" | "override";
  /** hd_on_call id for an override. */
  id?: number;
}

// --- Input checks -----------------------------------------------------------------------

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const isInt = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const asNum = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);
const bit = (v: unknown) => (v === true || v === 1 || v === "1" ? 1 : 0);

export function isAssignMode(v: unknown): v is HdAssignMode {
  return typeof v === "string" && (HD_ASSIGN_MODES as readonly string[]).includes(v);
}

/** A PUT body for a team's settings, over the current ones. */
export function validateTeamAssignment(raw: Record<string, unknown>, current: HdTeamAssignment): Checked<HdTeamAssignment> {
  const out: HdTeamAssignment = { ...current, include_roles: [...current.include_roles] };
  if (raw.mode !== undefined) {
    if (!isAssignMode(raw.mode)) return { ok: false, error: "Mode is manual, round_robin or load_balanced." };
    out.mode = raw.mode;
  }
  if (raw.eligible !== undefined) {
    if (!(HD_ELIGIBILITY as readonly unknown[]).includes(raw.eligible)) return { ok: false, error: "Eligibility is available or available_or_away." };
    out.eligible = raw.eligible as HdEligibility;
  }
  if (raw.include_roles !== undefined) {
    if (!Array.isArray(raw.include_roles) || !raw.include_roles.every((r) => (HD_ROLES as readonly unknown[]).includes(r))) {
      return { ok: false, error: "Roles are newbie, agent, team_lead, manager or admin." };
    }
    const set = new Set(raw.include_roles as HdRole[]);
    if (!set.size) return { ok: false, error: "Choose at least one role that takes tickets." };
    out.include_roles = HD_ROLES.filter((r) => set.has(r));
  }
  for (const k of ["max_open_per_agent", "unanswered_minutes"] as const) {
    if (raw[k] === undefined) continue;
    if (raw[k] === null || raw[k] === "") {
      out[k] = null;
      continue;
    }
    const n = asNum(raw[k]);
    const max = k === "max_open_per_agent" ? ASSIGNMENT_LIMITS.capacity : ASSIGNMENT_LIMITS.unanswered;
    if (!isInt(n, 1, max)) return { ok: false, error: k === "max_open_per_agent" ? `Capacity is 1 to ${max} open tickets, or no limit.` : `The reply window is 1 to ${max} minutes, or off.` };
    out[k] = n as number;
  }
  for (const k of ["respect_shift", "sticky_requester", "reassign_when_away"] as const) {
    if (raw[k] !== undefined) out[k] = bit(raw[k]);
  }
  return { ok: true, value: out };
}

/** A member change: { weight?, paused? }. */
export function validateMemberPatch(raw: Record<string, unknown>): Checked<{ weight?: number; paused?: number }> {
  const out: { weight?: number; paused?: number } = {};
  if (raw.weight !== undefined) {
    const w = asNum(raw.weight);
    if (!isInt(w, 1, ASSIGNMENT_LIMITS.weight)) return { ok: false, error: `Weight is 1 to ${ASSIGNMENT_LIMITS.weight}.` };
    out.weight = w as number;
  }
  if (raw.paused !== undefined) out.paused = bit(raw.paused);
  if (out.weight === undefined && out.paused === undefined) return { ok: false, error: "Send a weight or paused." };
  return { ok: true, value: out };
}

function fieldDef(field: string): { kind: HdAssignFieldKind; ops: readonly HdAssignOp[] } | null {
  if (field.startsWith(ANSWER_PREFIX)) {
    const key = field.slice(ANSWER_PREFIX.length);
    return /^[A-Za-z0-9_.-]{1,60}$/.test(key) ? { kind: "text", ops: ANSWER_OPS } : null;
  }
  return Object.prototype.hasOwnProperty.call(HD_ASSIGN_FIELDS, field) ? HD_ASSIGN_FIELDS[field as HdAssignFixedField] : null;
}

export function opTakesValue(op: HdAssignOp): boolean {
  return !["is_empty", "not_empty", "is_true", "is_false"].includes(op);
}

export function validateConditions(raw: unknown): Checked<HdAssignConditions> {
  if (raw === undefined || raw === null) return { ok: true, value: { match: "all", rules: [] } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Conditions are { match, rules }." };
  const r = raw as Record<string, unknown>;
  const match = r.match === "any" ? "any" : "all";
  const list = r.rules ?? [];
  if (!Array.isArray(list) || list.length > ASSIGNMENT_LIMITS.conditions) return { ok: false, error: `Up to ${ASSIGNMENT_LIMITS.conditions} conditions.` };
  const rules: HdAssignCondition[] = [];
  for (const c of list as Record<string, unknown>[]) {
    if (!c || typeof c !== "object") return { ok: false, error: "Each condition is { field, op, value }." };
    const field = typeof c.field === "string" ? c.field : "";
    const def = fieldDef(field);
    if (!def) return { ok: false, error: `Unknown condition field "${field.slice(0, 60)}".` };
    if (!(def.ops as readonly unknown[]).includes(c.op)) return { ok: false, error: `That comparison doesn't fit ${field}.` };
    const op = c.op as HdAssignOp;
    const cond: HdAssignCondition = { field, op };
    if (opTakesValue(op)) {
      const vals = (Array.isArray(c.value) ? c.value : [c.value]).map((v) => (typeof v === "number" ? String(v) : v));
      if (!vals.every((v) => typeof v === "string") || vals.length > ASSIGNMENT_LIMITS.values) return { ok: false, error: "Condition values are text." };
      const clean = (vals as string[]).map((v) => v.trim()).filter(Boolean);
      if (!clean.length) return { ok: false, error: "Give each condition a value." };
      if (clean.some((v) => v.length > ASSIGNMENT_LIMITS.value)) return { ok: false, error: `Values are up to ${ASSIGNMENT_LIMITS.value} characters.` };
      cond.value = Array.isArray(c.value) || ["in", "not_in", "contains", "not_contains"].includes(op) ? clean : clean[0];
    }
    rules.push(cond);
  }
  return { ok: true, value: { match, rules } };
}

export function validateAction(raw: unknown): Checked<HdAssignAction> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The action is { assign, … }." };
  const a = raw as Record<string, unknown>;
  if (!(HD_ASSIGN_ACTIONS as readonly unknown[]).includes(a.assign)) return { ok: false, error: "Choose how the rule assigns." };
  const out: HdAssignAction = { assign: a.assign as HdAssignActionKind };
  if (a.team_id !== undefined && a.team_id !== null && a.team_id !== "") {
    const t = asNum(a.team_id);
    if (!isInt(t, 1, 2 ** 31 - 1)) return { ok: false, error: "team_id must be a team's id." };
    out.team_id = t as number;
  }
  if (out.assign === "skills") {
    const c = validateSkillCriteria(a.skills);
    if (!c.ok) return c;
    out.skills = c.value;
  }
  if (out.assign === "user") {
    const u = asNum(a.user_id);
    if (!isInt(u, 1, 2 ** 31 - 1)) return { ok: false, error: "Choose the person the rule assigns to." };
    out.user_id = u as number;
  }
  if (a.min_role !== undefined && a.min_role !== null && a.min_role !== "") {
    if (!(HD_MIN_ROLES as readonly unknown[]).includes(a.min_role)) return { ok: false, error: "The minimum role is agent, team_lead or manager." };
    out.min_role = a.min_role as HdRole;
  }
  if (a.set_priority !== undefined && a.set_priority !== null && a.set_priority !== "") {
    if (a.set_priority !== "from_severity" && !(HD_PRIORITIES as readonly unknown[]).includes(a.set_priority)) return { ok: false, error: "Unknown priority." };
    out.set_priority = a.set_priority as HdAssignAction["set_priority"];
  }
  if (a.add_tags !== undefined && a.add_tags !== null) {
    const tags = Array.isArray(a.add_tags) ? a.add_tags : typeof a.add_tags === "string" ? a.add_tags.split(",") : null;
    if (!tags || !tags.every((t) => typeof t === "string")) return { ok: false, error: "Tags are text." };
    const clean = [...new Set((tags as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (clean.length > ASSIGNMENT_LIMITS.tags || clean.some((t) => t.length > ASSIGNMENT_LIMITS.tag)) {
      return { ok: false, error: `Up to ${ASSIGNMENT_LIMITS.tags} tags of up to ${ASSIGNMENT_LIMITS.tag} characters.` };
    }
    if (clean.length) out.add_tags = clean;
  }
  return { ok: true, value: out };
}

export interface HdAssignRuleInput {
  name: string;
  enabled: number;
  scope_team_id: number | null;
  conditions: HdAssignConditions;
  action: HdAssignAction;
  stop: number;
}

export function validateRuleInput(raw: Record<string, unknown>, partial = false): Checked<Partial<HdAssignRuleInput>> {
  const out: Partial<HdAssignRuleInput> = {};
  if (raw.name !== undefined || !partial) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || name.length > ASSIGNMENT_LIMITS.ruleName) return { ok: false, error: `Name the rule (up to ${ASSIGNMENT_LIMITS.ruleName} characters).` };
    out.name = name;
  }
  if (raw.enabled !== undefined || !partial) out.enabled = raw.enabled === undefined ? 1 : bit(raw.enabled);
  if (raw.stop !== undefined || !partial) out.stop = raw.stop === undefined ? 1 : bit(raw.stop);
  if (raw.scope_team_id !== undefined || !partial) {
    if (raw.scope_team_id === undefined || raw.scope_team_id === null || raw.scope_team_id === "") out.scope_team_id = null;
    else {
      const t = asNum(raw.scope_team_id);
      if (!isInt(t, 1, 2 ** 31 - 1)) return { ok: false, error: "scope_team_id must be a team's id or null." };
      out.scope_team_id = t as number;
    }
  }
  if (raw.conditions !== undefined || !partial) {
    const c = validateConditions(raw.conditions);
    if (!c.ok) return c;
    out.conditions = c.value;
  }
  if (raw.action !== undefined || !partial) {
    const a = validateAction(raw.action);
    if (!a.ok) return a;
    out.action = a.value;
  }
  return { ok: true, value: out };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function validTimeZoneName(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz.length > 0 && tz.length <= 64;
  } catch {
    return false;
  }
}

export function validateRotation(raw: Record<string, unknown>, teamId: number): Checked<HdOnCallRotation> {
  const ids = Array.isArray(raw.user_ids) ? raw.user_ids.map(asNum) : null;
  if (!ids || ids.length > ASSIGNMENT_LIMITS.rotation || !ids.every((i) => isInt(i, 1, 2 ** 31 - 1))) {
    return { ok: false, error: `The rotation is a list of up to ${ASSIGNMENT_LIMITS.rotation} people.` };
  }
  const length = asNum(raw.length_days ?? 7);
  if (!isInt(length, 1, ASSIGNMENT_LIMITS.rotationDays)) return { ok: false, error: `Each turn lasts 1 to ${ASSIGNMENT_LIMITS.rotationDays} days.` };
  const time = typeof raw.handover_time === "string" ? raw.handover_time : "09:00";
  if (!HHMM.test(time)) return { ok: false, error: "The handover time is HH:MM." };
  const tz = typeof raw.timezone === "string" ? raw.timezone : "UTC";
  if (!validTimeZoneName(tz)) return { ok: false, error: "Unknown timezone." };
  const start = typeof raw.starts_on === "string" ? raw.starts_on : "";
  const m = YMD.exec(start);
  if (!m || Number.isNaN(Date.UTC(+m[1], +m[2] - 1, +m[3])) || new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDate() !== +m[3]) {
    return { ok: false, error: "The first handover date is YYYY-MM-DD." };
  }
  return {
    ok: true,
    value: { team_id: teamId, user_ids: ids as number[], length_days: length as number, handover_time: time, timezone: tz, starts_on: start },
  };
}

// --- Matching ----------------------------------------------------------------------------

/** What rules look at, loaded by the engine for one ticket. */
export interface HdAssignFacts {
  source: string;
  automated: boolean;
  integration_id: string | null;
  request_type_id: number | null;
  team_id: number | null;
  priority: string;
  category: string;
  tags: string[];
  subject: string;
  body: string;
  answers: Record<string, unknown>;
  /** null: no person behind the ticket (alerts, API): requester conditions never match. */
  requester: { department: string; office: string; vip: boolean; vip_reason: string } | null;
  /** Is the team's calendar open now. */
  open: boolean;
  /** The ticket's language (ISO 639-1; 1.19.2, agent W2), null or absent when unknown. */
  language?: string | null;
}

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const listOf = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(lc).filter(Boolean);

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return ["yes", "true", "1", "on"].includes(lc(v));
}

function compareText(actual: string, op: HdAssignOp, value: string | string[] | undefined): boolean {
  const a = lc(actual);
  const vals = listOf(value);
  switch (op) {
    case "equals":
      return vals.some((v) => a === v);
    case "not_equals":
      return !vals.some((v) => a === v);
    case "in":
      return vals.includes(a);
    case "not_in":
      return !vals.includes(a);
    case "contains":
      return vals.some((v) => a.includes(v));
    case "not_contains":
      return !vals.some((v) => a.includes(v));
    case "is_empty":
      return a === "";
    case "not_empty":
      return a !== "";
    case "is_true":
      return truthy(actual);
    case "is_false":
      return !truthy(actual);
  }
}

function compareSet(actual: string[], op: HdAssignOp, value: string | string[] | undefined): boolean {
  const a = actual.map(lc);
  const vals = listOf(value);
  switch (op) {
    case "in":
    case "equals":
    case "contains":
      return vals.some((v) => a.includes(v));
    case "not_in":
    case "not_equals":
    case "not_contains":
      return !vals.some((v) => a.includes(v));
    case "is_empty":
      return a.length === 0;
    case "not_empty":
      return a.length > 0;
    default:
      return false;
  }
}

/** Does one condition hold for these facts? */
export function conditionHolds(c: HdAssignCondition, f: HdAssignFacts): boolean {
  if (c.field.startsWith(ANSWER_PREFIX)) {
    const v = f.answers[c.field.slice(ANSWER_PREFIX.length)];
    return compareText(v === null || v === undefined ? "" : String(v), c.op, c.value);
  }
  const field = c.field as HdAssignFixedField;
  switch (field) {
    case "source":
      return compareText(f.source, c.op, c.value);
    case "automated":
      return c.op === "is_true" ? f.automated : !f.automated;
    case "integration":
      return compareText(f.integration_id ?? "", c.op, c.value);
    case "request_type":
      return compareText(f.request_type_id === null ? "" : String(f.request_type_id), c.op, c.value);
    case "team":
      return compareText(f.team_id === null ? "" : String(f.team_id), c.op, c.value);
    case "priority":
      return compareText(f.priority, c.op, c.value);
    case "category":
      return compareText(f.category, c.op, c.value);
    case "tags":
      return compareSet(f.tags, c.op, c.value);
    case "language":
      return compareText(f.language ?? "", c.op, c.value);
    case "subject":
      return compareText(f.subject, c.op, c.value);
    case "body":
      return compareText(f.body, c.op, c.value);
    case "text":
      return c.op === "not_contains"
        ? compareText(f.subject, c.op, c.value) && compareText(f.body, c.op, c.value)
        : compareText(f.subject, c.op, c.value) || compareText(f.body, c.op, c.value);
    case "requester_department":
      return f.requester !== null && compareText(f.requester.department, c.op, c.value);
    case "requester_office":
      return f.requester !== null && compareText(f.requester.office, c.op, c.value);
    case "requester_vip":
      return f.requester !== null && (c.op === "is_true" ? f.requester.vip : !f.requester.vip);
    case "hours":
      return lc(Array.isArray(c.value) ? c.value[0] : c.value) === (f.open ? "open" : "closed");
    default:
      return false;
  }
}

/** All (or any) of the conditions; no conditions = every ticket. */
export function conditionsMatch(c: HdAssignConditions, f: HdAssignFacts): boolean {
  if (!c.rules.length) return true;
  return c.match === "any" ? c.rules.some((r) => conditionHolds(r, f)) : c.rules.every((r) => conditionHolds(r, f));
}

/** Alert severity → priority (set_priority 'from_severity'). */
export function priorityFromSeverity(raw: unknown): HdPriority | null {
  const s = lc(raw);
  if (!s) return null;
  if (["critical", "crit", "fatal", "emergency", "disaster", "p1", "sev1", "1"].includes(s)) return "urgent";
  if (["high", "major", "error", "p2", "sev2", "2"].includes(s)) return "high";
  if (["warning", "warn", "medium", "average", "minor", "p3", "sev3", "3"].includes(s)) return "normal";
  if (["info", "information", "low", "ok", "p4", "p5", "sev4", "4", "5"].includes(s)) return "low";
  return null;
}

// --- Picks -------------------------------------------------------------------------------

export interface RoundRobinCandidate {
  user_id: number;
  weight: number;
}

/**
 * Weighted round robin over candidates ordered by user id: the last person
 * keeps the turn until they have had `weight` tickets in a row, then it
 * moves to the next eligible person after them (wrapping). People who are
 * not candidates right now are simply skipped, so the turn order survives.
 */
export function pickRoundRobin(
  candidates: RoundRobinCandidate[],
  cursor: { last_user_id: number | null; streak: number }
): { user_id: number; streak: number } | null {
  if (!candidates.length) return null;
  const ordered = [...candidates].sort((a, b) => a.user_id - b.user_id);
  const last = cursor.last_user_id;
  if (last !== null) {
    const same = ordered.find((c) => c.user_id === last);
    if (same && cursor.streak < Math.max(1, same.weight)) return { user_id: last, streak: cursor.streak + 1 };
    const next = ordered.find((c) => c.user_id > last) ?? ordered[0];
    return { user_id: next.user_id, streak: 1 };
  }
  return { user_id: ordered[0].user_id, streak: 1 };
}

export interface LoadCandidate {
  user_id: number;
  weight: number;
  open_count: number;
  last_assigned_at: string | null;
}

/** Fewest open tickets per unit of weight; ties go to whoever has waited longest since their last assignment (never = longest), then the lowest id. */
export function pickLeastLoaded(candidates: LoadCandidate[]): number | null {
  if (!candidates.length) return null;
  const score = (c: LoadCandidate) => c.open_count / Math.max(1, c.weight);
  const last = (c: LoadCandidate) => (c.last_assigned_at ? Date.parse(c.last_assigned_at) : -Infinity);
  const sorted = [...candidates].sort((a, b) => score(a) - score(b) || last(a) - last(b) || a.user_id - b.user_id);
  return sorted[0].user_id;
}

export function roleRank(role: HdRole | null): number {
  return role ? HD_ROLE_RANK[role] : -1;
}

/**
 * May a person with this desk role take an auto-assigned ticket? With a
 * rule's min_role, anyone at or above it (newbies only when the team
 * includes them); otherwise the team's included roles.
 */
export function roleTakesTickets(role: HdRole | null, include: readonly HdRole[], minRole: HdRole | null | undefined): boolean {
  if (!role) return false;
  if (minRole) {
    if (roleRank(role) < roleRank(minRole)) return false;
    return role !== "newbie" || include.includes("newbie");
  }
  return include.includes(role);
}

export function roleLabel(role: HdRole | null): string {
  return role ? HD_ROLE_LABEL[role] : "No desk role";
}

// --- On-call rotation -------------------------------------------------------------------

function addDays(ymd: string, days: number): [number, number, number] {
  const m = YMD.exec(ymd)!;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * 86_400_000);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

/** The instant of handover number k (k = 0 is starts_on at handover_time), in the rotation's timezone: the same wall-clock time across DST. */
export function handoverAt(r: Pick<HdOnCallRotation, "starts_on" | "length_days" | "handover_time" | "timezone">, k: number): number {
  const [y, m, d] = addDays(r.starts_on, k * r.length_days);
  const [hh, mm] = r.handover_time.split(":").map(Number);
  return zonedInstant(y, m, d, hh, mm, r.timezone);
}

/** The rotation's shifts overlapping [from, to). Nobody is on call before the first handover. */
export function rotationShifts(r: HdOnCallRotation, from: number, to: number): HdOnCallShift[] {
  if (!r.user_ids.length || to <= from) return [];
  const out: HdOnCallShift[] = [];
  const span = r.length_days * 86_400_000;
  // Start a little before the estimate: DST shifts a handover by at most an hour or two.
  let k = Math.max(0, Math.floor((from - handoverAt(r, 0)) / span) - 1);
  for (let guard = 0; guard < 1000; guard++, k++) {
    const s = handoverAt(r, k);
    if (s >= to) break;
    const e = handoverAt(r, k + 1);
    if (e > from) {
      out.push({ user_id: r.user_ids[k % r.user_ids.length], starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString(), source: "rotation" });
    }
  }
  return out;
}

/** Who is on call at `t`: an override covering t (the newest), else the rotation. */
export function onCallAt(r: HdOnCallRotation | null, overrides: HdOnCallShift[], t: number): HdOnCallShift | null {
  const cover = overrides
    .filter((o) => Date.parse(o.starts_at) <= t && t < Date.parse(o.ends_at))
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
  if (cover) return cover;
  if (!r) return null;
  return rotationShifts(r, t, t + 1)[0] ?? null;
}

/** The on-call strip: each day's [start, end) split at handovers and overrides, for `days` days from the day holding `from` in tz. */
export function onCallStrip(
  r: HdOnCallRotation | null,
  overrides: HdOnCallShift[],
  from: number,
  days: number,
  tz: string
): { date: string; segments: HdOnCallShift[] }[] {
  const w = wallClock(from, tz);
  const out: { date: string; segments: HdOnCallShift[] }[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(w.y, w.m - 1, w.d) + i * 86_400_000);
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const start = zonedInstant(y, m, d, 0, 0, tz);
    const next = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
    const end = zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz);
    // Cut points: rotation handovers and override edges inside the day.
    const cuts = new Set<number>([start, end]);
    if (r) for (const s of rotationShifts(r, start, end)) for (const t of [Date.parse(s.starts_at), Date.parse(s.ends_at)]) if (t > start && t < end) cuts.add(t);
    for (const o of overrides) for (const t of [Date.parse(o.starts_at), Date.parse(o.ends_at)]) if (t > start && t < end) cuts.add(t);
    const points = [...cuts].sort((a, b) => a - b);
    const segments: HdOnCallShift[] = [];
    for (let j = 0; j + 1 < points.length; j++) {
      const who = onCallAt(r, overrides, points[j]);
      if (!who) continue;
      const seg: HdOnCallShift = { ...who, starts_at: new Date(points[j]).toISOString(), ends_at: new Date(points[j + 1]).toISOString() };
      const prev = segments[segments.length - 1];
      if (prev && prev.user_id === seg.user_id && prev.source === seg.source && prev.ends_at === seg.starts_at) prev.ends_at = seg.ends_at;
      else segments.push(seg);
    }
    out.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, segments });
  }
  return out;
}

// --- Words -----------------------------------------------------------------------------

/** "by round robin", "by rule “VIP to seniors”". */
export function methodPhrase(method: HdAssignMethod, ruleName?: string | null): string {
  switch (method) {
    case "rule":
      return `by rule “${ruleName ?? ""}”`;
    case "round_robin":
      return "by round robin";
    case "load_balanced":
      return "by load balancing";
    case "sticky":
      return "because they helped this requester last time";
    case "on_call":
      return "because they are on call";
    case "manual":
      return "by hand";
    case "automation":
      return "by an automation";
    case "reassign_away":
      return "because the owner is away";
    case "reassign_unanswered":
      return "because the owner had not replied in time";
    case "skills":
      return `by rule “${ruleName ?? ""}”`;
  }
}

/** The name the assignment notice shows as the assigner ("Round robin assigned you #1047"). */
export function assignerName(method: HdAssignMethod, ruleName?: string | null): string {
  if (method === "rule" || method === "skills") return `Rule “${ruleName ?? ""}”`;
  if (method === "sticky") return "Auto-assign";
  if (method === "on_call") return "On-call rota";
  if (method === "load_balanced") return "Load balancing";
  if (method === "reassign_away" || method === "reassign_unanswered") return "Auto-reassign";
  return HD_ASSIGN_METHOD_LABEL[method];
}
