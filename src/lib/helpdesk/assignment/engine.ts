// Helpdesk 1.19.0: ticket assignment (agent N), the engine. Decides who owns
// a ticket when it arrives, when it changes team or reopens, and when its
// owner goes away or misses the first-reply window; records every
// assignment (hd_assignment_log) with an internal note on the ticket; and
// notifies the new owner through C's notifyAssigned (which goes through F's
// delivery preferences).
//
// Order on a new ticket (lib/helpdesk/events afterTicketCreated):
//   1. intake (P): an alert or API ticket is normalised and deduplicated; a
//      duplicate becomes a note on the existing ticket and never reaches here
//   2. assignment (N, this module): the ordered assignment rules, then the
//      team's mode (manual / round robin / load balanced)
//   3. automations (C, runAutomations "ticket_created"): they run after us and
//      may still override the team or the owner
//   4. notices (C): the acknowledgement; the team's "new ticket" notice only
//      when nobody was assigned
// A rule's own field changes (team, priority, tags) go through updateTicket
// with fromAutomation + silent, so they run no automations, no notices and
// no second assignment.
//
// Concurrency: one transaction per decision with the ticket row locked (it
// must still be unassigned, or still be the owner we are moving it from),
// then the team's round-robin cursor row locked (one decision per team at a
// time), then a transaction-scoped advisory lock on every candidate in
// ascending id order (so a person in two teams is never counted by two
// decisions at once), and only then the open counts that capacity reads.
// Everything slow (roles, calendars, directory, VIP, rules) is read before
// the transaction, so it holds one pooled client and no other.
//
// Server-only.

import "server-only";
import { logEvent } from "../../log";
import { hq, hqOne, withTx } from "../db-core";
import type { HdTicketRow } from "../types";
import { HD_PRIORITY_LABEL } from "../types";
import type { HdRole } from "../roles-shared";
import {
  ASSIGNMENT_LIMITS,
  HD_ASSIGN_FIELDS,
  HD_ASSIGN_OP_LABEL,
  ANSWER_PREFIX,
  assignerName,
  conditionHolds,
  conditionsMatch,
  methodPhrase,
  onCallAt,
  opTakesValue,
  pickLeastLoaded,
  pickRoundRobin,
  priorityFromSeverity,
  roleLabel,
  roleTakesTickets,
  type HdAssignAction,
  type HdAssignCondition,
  type HdAssignFacts,
  type HdAssignmentMemberView,
  type HdAssignmentRule,
  type HdAssignMethod,
  type HdAssignTrigger,
  type HdOnCallShift,
  type HdTeamAssignment,
} from "./shared";
import {
  assignmentReady,
  claimCapNote,
  clearQueued,
  countReassign,
  getRotation,
  getTeamAssignment,
  getTicketState,
  insertLog,
  listMemberRows,
  listOverrides,
  listRules,
  loadOf,
  queueTicket,
  type MemberRow,
  type PendingDecision,
} from "./store";

/** pg_advisory_xact_lock(class, user_id): one capacity decision per person at a time. */
const AGENT_LOCK_CLASS = 7_281_962;
/** pg_try_advisory_lock key for the periodic sweep. */
export const ASSIGNMENT_SWEEP_LOCK = 7_281_963;

const NOTE_AUTHOR = "Assignment";
const OPEN_STATUSES = ["new", "open", "pending", "on_hold"];

// --- Loading -----------------------------------------------------------------------------

type TicketForAssign = HdTicketRow & { automated: number; integration_id: string | null; body: string };

async function loadTicket(id: number): Promise<TicketForAssign | undefined> {
  return hqOne<TicketForAssign>(
    `SELECT t.*, COALESCE((to_jsonb(t) ->> 'automated')::int, 0) AS automated, to_jsonb(t) ->> 'integration_id' AS integration_id,
            COALESCE((SELECT m.body FROM hd_messages m WHERE m.ticket_id = t.id AND m.kind IN ('public', 'internal')
                       ORDER BY m.created_at, m.id LIMIT 1), '') AS body
       FROM hd_tickets t WHERE t.id = $1`,
    [id]
  );
}

async function teamOpen(teamId: number | null, now: Date): Promise<boolean> {
  try {
    const { teamOpenState } = await import("../calendars");
    return (await teamOpenState(teamId, now)).open;
  } catch (e) {
    logEvent("error", "helpdesk.assignment.calendar_failed", { teamId, error: e instanceof Error ? e.message : String(e) });
    return true;
  }
}

/** O's VIP list (lib/helpdesk/contact-cards vipInfo). Not VIP when the module can't answer. */
async function vipOf(userId: number | null, email: string): Promise<{ vip: boolean; reason: string }> {
  try {
    const { vipInfo } = await import("../contact-cards");
    const v = await vipInfo(userId, email);
    return { vip: Boolean(v.vip), reason: v.reason ?? "" };
  } catch {
    return { vip: false, reason: "" };
  }
}

async function requesterFacts(t: TicketForAssign): Promise<HdAssignFacts["requester"]> {
  if (t.automated || (t.requester_id === null && !t.requester_email)) return null;
  const person = await hqOne<{ department: string; office: string }>(
    `SELECT p.department, p.office FROM directory_people p
      WHERE p.hidden = 0 AND (p.id = (SELECT directory_person_id FROM users WHERE id = $1)
         OR ($1::int IS NULL AND $2 <> '' AND lower(p.email) = lower($2)))
      LIMIT 1`,
    [t.requester_id, t.requester_email]
  ).catch(() => undefined);
  const vip = await vipOf(t.requester_id, t.requester_email);
  return { department: person?.department ?? "", office: person?.office ?? "", vip: vip.vip, vip_reason: vip.reason };
}

/** Everything a rule looks at for this ticket. */
export async function factsFor(t: TicketForAssign, now: Date): Promise<HdAssignFacts> {
  return {
    source: t.source,
    automated: Boolean(t.automated) || t.source === "alert" || t.source === "api",
    integration_id: t.integration_id === null || t.integration_id === undefined ? null : String(t.integration_id),
    request_type_id: t.request_type_id,
    team_id: t.team_id,
    priority: t.priority,
    category: t.category ?? "",
    tags: t.tags ?? [],
    subject: t.subject ?? "",
    body: t.body ?? "",
    answers: (t.form_answers ?? {}) as Record<string, unknown>,
    requester: await requesterFacts(t),
    open: await teamOpen(t.team_id, now),
  };
}

// --- Rules -------------------------------------------------------------------------------

export interface RuleTraceLine {
  rule_id: number;
  name: string;
  matched: boolean;
  /** "Matched", "Off", "Only for IT", "Came in through is not Alert". */
  reason: string;
}

export interface RuleDecision {
  /** The rule whose assign won (the last matching one that said how). */
  rule: HdAssignmentRule | null;
  /** Every matching rule, in order. */
  matched: HdAssignmentRule[];
  team_id: number | null | undefined;
  priority: string | undefined;
  add_tags: string[];
  assign: HdAssignAction["assign"];
  user_id: number | null;
  min_role: HdRole | null;
  trace: RuleTraceLine[];
}

const RANK: Record<string, number> = { agent: 1, team_lead: 2, manager: 3 };

function fieldLabel(field: string): string {
  if (field.startsWith(ANSWER_PREFIX)) return `Answer “${field.slice(ANSWER_PREFIX.length)}”`;
  return (HD_ASSIGN_FIELDS as Record<string, { label: string }>)[field]?.label ?? field;
}

/** "Came in through is any of alert" (for the test box's reasons). */
export function conditionText(c: HdAssignCondition): string {
  const v = Array.isArray(c.value) ? c.value.join(", ") : c.value ?? "";
  if (c.op === "is_true") return fieldLabel(c.field);
  if (c.op === "is_false") return `not: ${fieldLabel(c.field).toLowerCase()}`;
  if (c.field === "hours") return v === "closed" ? "the team is closed" : "the team is open";
  return `${fieldLabel(c.field)} ${HD_ASSIGN_OP_LABEL[c.op]}${opTakesValue(c.op) ? ` ${v}` : ""}`;
}

/**
 * Run the enabled rules in order against the facts. A matching rule's team,
 * priority and tags apply (later matches override team and priority, tags
 * add up); its assign wins unless it says "use the team's setting"; the
 * strictest min_role holds. A rule with stop ends the run.
 */
export function evaluateRules(
  rules: HdAssignmentRule[],
  facts: HdAssignFacts,
  opts: { severity?: unknown; teamName?: (id: number) => string; openFor?: (teamId: number | null) => boolean } = {}
): RuleDecision {
  const out: RuleDecision = { rule: null, matched: [], team_id: undefined, priority: undefined, add_tags: [], assign: "team_mode", user_id: null, min_role: null, trace: [] };
  const f = { ...facts };
  let stopped = false;
  for (const r of rules) {
    if (stopped) {
      out.trace.push({ rule_id: r.id, name: r.name, matched: false, reason: "Not checked: an earlier rule stopped the run" });
      continue;
    }
    if (!r.enabled) {
      out.trace.push({ rule_id: r.id, name: r.name, matched: false, reason: "Off" });
      continue;
    }
    if (r.scope_team_id !== null && r.scope_team_id !== f.team_id) {
      out.trace.push({ rule_id: r.id, name: r.name, matched: false, reason: `Only for ${opts.teamName?.(r.scope_team_id) ?? "another team"}` });
      continue;
    }
    const conds = r.conditions?.rules ? r.conditions : { match: "all" as const, rules: [] };
    if (!conditionsMatch(conds, f)) {
      const failing = conds.rules.filter((c) => !conditionHolds(c, f));
      const reason =
        conds.match === "any"
          ? `None of its ${conds.rules.length} conditions hold`
          : `Not true: ${failing.slice(0, 2).map(conditionText).join("; ")}`;
      out.trace.push({ rule_id: r.id, name: r.name, matched: false, reason });
      continue;
    }
    out.trace.push({ rule_id: r.id, name: r.name, matched: true, reason: conds.rules.length ? "Matched" : "Matched (no conditions: every ticket)" });
    out.matched.push(r);
    const a = r.action ?? { assign: "team_mode" };
    if (a.team_id) {
      out.team_id = a.team_id;
      if (f.team_id !== a.team_id) {
        f.team_id = a.team_id;
        if (opts.openFor) f.open = opts.openFor(a.team_id);
      }
    }
    if (a.set_priority) {
      const p = a.set_priority === "from_severity" ? priorityFromSeverity(opts.severity) : a.set_priority;
      if (p) {
        out.priority = p;
        f.priority = p;
      }
    }
    for (const tag of a.add_tags ?? []) {
      if (!out.add_tags.includes(tag)) out.add_tags.push(tag);
      if (!f.tags.includes(tag)) f.tags = [...f.tags, tag];
    }
    if (a.assign && a.assign !== "team_mode") {
      out.assign = a.assign;
      out.user_id = a.assign === "user" ? a.user_id ?? null : null;
      out.rule = r;
    } else if (!out.rule) out.rule = r;
    if (a.min_role && (!out.min_role || (RANK[a.min_role] ?? 0) > (RANK[out.min_role] ?? 0))) out.min_role = a.min_role;
    if (r.stop) stopped = true;
  }
  return out;
}

/** The alert's severity: P's alert key for the ticket, else a severity answer or source_ref field. */
async function severityOf(t: Pick<HdTicketRow, "id" | "form_answers" | "source_ref">): Promise<unknown> {
  const a = (t.form_answers ?? {}) as Record<string, unknown>;
  const s = (t.source_ref ?? {}) as Record<string, unknown>;
  const key = await hqOne<{ severity: string }>(
    `SELECT k.severity FROM hd_alert_keys k WHERE k.ticket_id = $1 ORDER BY k.last_seen DESC LIMIT 1`,
    [t.id]
  ).catch(() => undefined);
  return key?.severity || a.severity || s.severity || null;
}

// --- Eligibility ----------------------------------------------------------------------------

export interface Candidate extends MemberRow {
  desk_role: HdRole | null;
  /** May work this team's tickets at all (a desk role, and the team's queue). */
  works: boolean;
  skip: string;
}

function firstName(name: string): string {
  return (name || "").trim().split(/\s+/)[0] || name;
}

async function workFacts(userId: number, role: MemberRow["role"], teamId: number): Promise<{ desk_role: HdRole | null; works: boolean }> {
  const { hdRoleOf } = await import("../roles");
  const { canWorkTicket } = await import("../access");
  const r = await hdRoleOf({ id: userId, role }).catch(() => null);
  if (!r) return { desk_role: null, works: false };
  const works = await canWorkTicket({ id: userId, role }, { id: 0, requester_id: null, team_id: teamId, assignee_id: null }).catch(() => false);
  return { desk_role: r.role, works };
}

/**
 * The team's members and why each would be passed over right now ('' =
 * they can take tickets), before capacity. Capacity needs the locked counts
 * and is checked in the transaction.
 */
export async function teamCandidates(
  teamId: number,
  s: HdTeamAssignment,
  opts: { minRole?: HdRole | null; exclude?: number | null; open: boolean }
): Promise<Candidate[]> {
  const rows = await listMemberRows(teamId);
  const out: Candidate[] = [];
  for (const m of rows) {
    const { desk_role: role, works } = await workFacts(m.user_id, m.role, teamId);
    let skip = "";
    if (!role) skip = "has no desk role";
    else if (!works) skip = "can't work this team's tickets";
    else if (m.user_id === opts.exclude) skip = "is the current owner";
    else if (!roleTakesTickets(role, s.include_roles, opts.minRole)) {
      skip = opts.minRole && role !== "newbie" ? `is below ${roleLabel(opts.minRole)}` : `is a ${roleLabel(role)}, not included`;
    } else if (m.paused) skip = "paused auto-assign";
    else if (m.availability === "offline") skip = "is offline";
    else if (m.availability === "away" && s.eligible === "available") skip = "is away";
    else if (!opts.open && s.respect_shift) skip = "is off shift";
    out.push({ ...m, desk_role: role, works, skip });
  }
  return out;
}

/** A person named by a rule or the rota, member of the team or not: may they work it (and meet min_role)? */
async function namedPerson(userId: number, teamId: number, cands: Candidate[], minRole: HdRole | null): Promise<{ ok: boolean; name: string }> {
  let c: { name: string; desk_role: HdRole | null; works: boolean } | undefined = cands.find((x) => x.user_id === userId);
  if (!c) {
    const u = await hqOne<{ name: string; role: MemberRow["role"] }>("SELECT name, role FROM users WHERE id = $1 AND status = 'active'", [userId]);
    if (!u) return { ok: false, name: "" };
    c = { name: u.name, ...(await workFacts(userId, u.role, teamId)) };
  }
  const ok = c.works && c.desk_role !== null && (!minRole || roleTakesTickets(c.desk_role, ["newbie"], minRole));
  return { ok, name: c.name };
}

function capacitySkip(s: HdTeamAssignment, open: number): string {
  return s.max_open_per_agent !== null && open >= s.max_open_per_agent ? `has ${open} open tickets (the limit is ${s.max_open_per_agent})` : "";
}

/** "Sam is away; Ali paused auto-assign; 2 more" */
function whyNobody(cands: Candidate[], extra: Map<number, string> = new Map(), outsideHours = false): string {
  if (outsideHours) return "The team is outside its office hours";
  // The most telling reasons first: capacity and availability change by the hour; roles and pauses are standing choices.
  const weight = (why: string) => (/open tickets/.test(why) ? 0 : /away|offline|off shift/.test(why) ? 1 : /paused/.test(why) ? 2 : 3);
  const lines = cands
    .map((c) => ({ name: firstName(c.name), why: c.skip || extra.get(c.user_id) || "" }))
    .filter((x) => x.why)
    .sort((a, b) => weight(a.why) - weight(b.why));
  if (!cands.length) return "The team has nobody in it";
  const shown = lines.slice(0, 3).map((x) => `${x.name} ${x.why}`);
  if (lines.length > 3) shown.push(`${lines.length - 3} more`);
  return shown.join("; ");
}

// --- On call ---------------------------------------------------------------------------------

/** Who is on call for the team at `now` (override, else rotation), or null. */
export async function onCallNow(teamId: number, now: Date): Promise<HdOnCallShift | null> {
  const [rot, overrides] = await Promise.all([getRotation(teamId), listOverrides(teamId, new Date(now.getTime() - 1), new Date(now.getTime() + 1))]);
  return onCallAt(rot, overrides, now.getTime());
}

// --- assignTicket -------------------------------------------------------------------------------

export interface AssignOptions {
  trigger: HdAssignTrigger;
  /** For the sweep and tests. */
  now?: Date;
}

export interface AssignResult {
  outcome: "assigned" | "queued" | "left" | "skipped";
  user_id?: number;
  method?: HdAssignMethod;
  rule_id?: number | null;
  /** The note written, or why nothing happened. */
  reason: string;
}

type Plan =
  | { kind: "leave"; note?: string }
  | { kind: "user"; user_id: number }
  | { kind: "round_robin" | "load_balanced" }
  | { kind: "on_call" };

async function writeNote(client: import("pg").PoolClient, ticketId: number, body: string, now: Date) {
  await client.query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at) VALUES ($1, NULL, $2, 'internal', $3, 'system', $4)`,
    [ticketId, NOTE_AUTHOR, body.slice(0, 2000), now]
  );
}

async function notify(ticketId: number, userId: number, method: HdAssignMethod, ruleName: string | null) {
  try {
    const { notifyAssigned } = await import("../notify");
    await notifyAssigned(ticketId, userId, { actorId: null, actorName: assignerName(method, ruleName) });
  } catch (e) {
    logEvent("error", "helpdesk.assignment.notify_failed", { ticketId, error: e instanceof Error ? e.message : String(e) });
  }
}

function waited(sinceIso: string | null, now: Date): string {
  if (!sinceIso) return "";
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(sinceIso)) / 60_000));
  if (m < 1) return "";
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const span = d >= 1 ? `${d}d ${h % 24}h` : h >= 1 ? `${h}h ${m % 60}m` : `${m}m`;
  return ` after waiting in the queue for ${span}`;
}

/**
 * Find an owner for the ticket. Never throws (the hooks call it); returns
 * what happened. See the header for the order and the locking.
 *
 *   created / manual_request  rules, then the team's mode
 *   team_changed / reopened   the team's mode, only when nobody owns it
 *   retry                     the decision a queued ticket was waiting with
 *   agent_away / unanswered   the team's mode, passing over the current owner
 */
export async function assignTicket(ticketId: number, opts: AssignOptions): Promise<AssignResult> {
  try {
    return await assignTicketInner(ticketId, opts);
  } catch (e) {
    logEvent("error", "helpdesk.assignment.failed", { ticketId, trigger: opts.trigger, error: e instanceof Error ? e.message : String(e) });
    return { outcome: "skipped", reason: "Assignment failed; the ticket stays where it is." };
  }
}

async function assignTicketInner(ticketId: number, opts: AssignOptions): Promise<AssignResult> {
  await assignmentReady();
  const now = opts.now ?? new Date();
  let t = await loadTicket(ticketId);
  if (!t) return { outcome: "skipped", reason: "No such ticket." };
  if (!OPEN_STATUSES.includes(t.status)) return { outcome: "skipped", reason: "The ticket is solved or closed." };
  const reassign = opts.trigger === "agent_away" || opts.trigger === "unanswered";
  if (reassign && !t.assignee_id) return { outcome: "skipped", reason: "Nobody owns it." };
  if (!reassign && opts.trigger !== "manual_request" && t.assignee_id) return { outcome: "skipped", reason: "Someone already owns it." };
  const state = await getTicketState(ticketId);
  if (reassign && (state?.auto_reassigns ?? 0) >= ASSIGNMENT_LIMITS.maxAutoReassigns) {
    if (await claimCapNote(ticketId)) {
      await hq(
        `INSERT INTO hd_messages (ticket_id, author_name, kind, body, via, created_at) VALUES ($1, $2, 'internal', $3, 'system', $4)`,
        [ticketId, NOTE_AUTHOR, `Reassigned automatically ${ASSIGNMENT_LIMITS.maxAutoReassigns} times already, so it stays with its owner. Reassign it by hand if needed.`, now]
      );
    }
    return { outcome: "skipped", reason: "Reassigned automatically the most times already." };
  }
  const fromUser = reassign || opts.trigger === "manual_request" ? t.assignee_id : null;

  // 1. Rules (new tickets and an agent's explicit request only).
  let rule: HdAssignmentRule | null = null;
  let minRole: HdRole | null = null;
  let plan: Plan | null = null;
  let vipReason = "";
  if (opts.trigger === "created" || opts.trigger === "manual_request") {
    const rules = await listRules({ enabledOnly: true });
    if (rules.length) {
      const facts = await factsFor(t, now);
      const openCache = new Map<number | null, boolean>([[t.team_id, facts.open]]);
      const otherTeams = [...new Set(rules.map((r) => r.action?.team_id).filter((x): x is number => typeof x === "number" && x !== t!.team_id))];
      for (const id of otherTeams) openCache.set(id, await teamOpen(id, now));
      const d = evaluateRules(rules, facts, { severity: await severityOf(t), openFor: (id) => openCache.get(id) ?? true });
      if (d.matched.length) {
        rule = d.rule;
        minRole = d.min_role;
        if (facts.requester?.vip && d.matched.some((r) => r.conditions?.rules?.some((c) => c.field === "requester_vip"))) {
          vipReason = facts.requester.vip_reason;
        }
        const patch: Record<string, unknown> = {};
        if (d.team_id !== undefined && d.team_id !== t.team_id) patch.team_id = d.team_id;
        if (d.priority && d.priority !== t.priority) patch.priority = d.priority;
        if (d.add_tags.length) {
          const tags = [...new Set([...(t.tags ?? []), ...d.add_tags])].slice(0, 20);
          if (tags.length !== (t.tags ?? []).length) patch.tags = tags;
        }
        if (Object.keys(patch).length) {
          const { updateTicket } = await import("../tickets");
          await updateTicket(ticketId, patch, { id: null, name: `Assignment rule “${d.rule?.name ?? d.matched[0].name}”` }, { fromAutomation: true, silent: true });
          t = (await loadTicket(ticketId))!;
        }
        switch (d.assign) {
          case "user":
            plan = d.user_id ? { kind: "user", user_id: d.user_id } : null;
            break;
          case "round_robin_in_team":
            plan = { kind: "round_robin" };
            break;
          case "load_balanced_in_team":
            plan = { kind: "load_balanced" };
            break;
          case "on_call":
            plan = { kind: "on_call" };
            break;
          case "leave_unassigned":
            plan = { kind: "leave", note: `Rule “${rule?.name ?? ""}” left it in the queue.` };
            break;
          default:
            plan = null;
        }
      }
    }
  } else if (opts.trigger === "retry" && state?.decision?.kind) {
    const k = state.decision.kind;
    plan = k === "team_mode" ? null : { kind: k };
    minRole = (state.decision.min_role as HdRole | null) ?? null;
    if (state.decision.rule_id) rule = { id: state.decision.rule_id, name: state.decision.rule_name ?? "" } as HdAssignmentRule;
  }

  const teamId = t.team_id;
  if (teamId === null) {
    if (plan?.kind === "leave") return finishLeave(ticketId, plan.note, rule, now);
    return { outcome: "left", reason: "The ticket has no team." };
  }
  const settings = await getTeamAssignment(teamId);
  if (!plan) {
    if (settings.mode === "manual") {
      if (reassign) return { outcome: "skipped", reason: "The team assigns by hand." };
      return { outcome: "left", reason: "The team assigns by hand." };
    }
    plan = { kind: settings.mode };
  }
  if (plan.kind === "leave") return finishLeave(ticketId, plan.note, rule, now);

  const decision: PendingDecision = {
    kind: plan.kind === "user" ? "team_mode" : plan.kind,
    min_role: minRole,
    rule_id: rule?.id ?? null,
    rule_name: rule?.name ?? "",
  };
  const open = await teamOpen(teamId, now);
  const cands = await teamCandidates(teamId, settings, { minRole, exclude: reassign ? t.assignee_id : null, open });

  // A named person or the on-call person: no turn, no capacity, but they must be able to work it.
  let fixed: { user_id: number; method: HdAssignMethod; name: string } | null = null;
  let fallbackNote = "";
  if (plan.kind === "user") {
    const who = await namedPerson(plan.user_id, teamId, cands, minRole);
    if (who.ok) fixed = { user_id: plan.user_id, method: "rule", name: who.name };
    else {
      fallbackNote = ` The rule's person can't take this team's tickets, so the team's setting decided.`;
      if (settings.mode === "manual") return finishLeave(ticketId, `Rule “${rule?.name ?? ""}” names someone who can't take this team's tickets, so it waits in the queue.`, rule, now);
      plan = { kind: settings.mode };
      decision.kind = "team_mode";
    }
  } else if (plan.kind === "on_call") {
    const shift = await onCallNow(teamId, now);
    const who = shift ? await namedPerson(shift.user_id, teamId, cands, null) : null;
    if (shift && who?.ok) fixed = { user_id: shift.user_id, method: "on_call", name: who.name };
    else {
      const reason = shift ? `${firstName(who?.name || "The on-call person")} is on call but can't take this team's tickets` : "Nobody is on call right now";
      return finishQueue(ticketId, reason, decision, now);
    }
  }

  // Sticky requester: whoever last solved one of this requester's tickets, if they can take it.
  let stickyId: number | null = null;
  if (!fixed && settings.sticky_requester && t.requester_id && !t.automated) {
    const last = await hqOne<{ assignee_id: number }>(
      `SELECT assignee_id FROM hd_tickets WHERE requester_id = $1 AND id <> $2 AND assignee_id IS NOT NULL AND solved_at IS NOT NULL
        ORDER BY solved_at DESC, id DESC LIMIT 1`,
      [t.requester_id, ticketId]
    );
    if (last && cands.some((c) => c.user_id === last.assignee_id && !c.skip)) stickyId = last.assignee_id;
  }

  const pool = cands.filter((c) => !c.skip);
  const expectAssignee = reassign || opts.trigger === "manual_request" ? t.assignee_id : null;
  const mode = plan.kind === "load_balanced" ? "load_balanced" : "round_robin";

  const tx = await withTx(async (client) => {
    const row = (await client.query<{ assignee_id: number | null; team_id: number | null; status: string }>(
      "SELECT assignee_id, team_id, status FROM hd_tickets WHERE id = $1 FOR UPDATE",
      [ticketId]
    )).rows[0];
    if (!row || !OPEN_STATUSES.includes(row.status) || row.team_id !== teamId || row.assignee_id !== expectAssignee) {
      return { kind: "changed" as const };
    }
    let to: number | null = null;
    let method: HdAssignMethod = "round_robin";
    const capSkips = new Map<number, string>();
    if (fixed) {
      to = fixed.user_id;
      method = fixed.method;
    } else {
      await client.query("INSERT INTO hd_assignment_cursor (team_id) VALUES ($1) ON CONFLICT (team_id) DO NOTHING", [teamId]);
      const cur = (await client.query<{ last_user_id: number | null; streak: number }>(
        "SELECT last_user_id, streak FROM hd_assignment_cursor WHERE team_id = $1 FOR UPDATE",
        [teamId]
      )).rows[0];
      const ids = pool.map((c) => c.user_id).sort((a, b) => a - b);
      for (const id of ids) await client.query("SELECT pg_advisory_xact_lock($1, $2)", [AGENT_LOCK_CLASS, id]);
      const load = await loadOf(ids, client);
      const able = pool.filter((c) => {
        const why = capacitySkip(settings, load.get(c.user_id)?.open_count ?? 0);
        if (why) capSkips.set(c.user_id, why);
        return !why;
      });
      if (stickyId && able.some((c) => c.user_id === stickyId)) {
        to = stickyId;
        method = "sticky";
      } else if (mode === "load_balanced") {
        to = pickLeastLoaded(able.map((c) => ({ user_id: c.user_id, weight: c.weight, ...(load.get(c.user_id) ?? { open_count: 0, last_assigned_at: null }) })));
        method = "load_balanced";
      } else {
        const pick = pickRoundRobin(able.map((c) => ({ user_id: c.user_id, weight: c.weight })), { last_user_id: cur?.last_user_id ?? null, streak: cur?.streak ?? 0 });
        if (pick) {
          to = pick.user_id;
          method = "round_robin";
          await client.query("UPDATE hd_assignment_cursor SET last_user_id = $2, streak = $3, updated_at = $4 WHERE team_id = $1", [teamId, pick.user_id, pick.streak, now]);
        }
      }
    }
    if (to === null) {
      const reason = whyNobody(cands, capSkips, !open && settings.respect_shift === 1 && cands.length > 0 && cands.every((c) => c.skip === "is off shift" || c.skip === "has no desk role"));
      if (reassign) return { kind: "nobody" as const, reason };
      const fresh = await queueTicket(ticketId, reason, decision, now, client);
      if (fresh) await writeNote(client, ticketId, `No one available; waiting in the queue. (${reason}.)`, now);
      return { kind: "queued" as const, reason };
    }
    if (reassign && fixed === null) method = opts.trigger === "agent_away" ? "reassign_away" : "reassign_unanswered";
    await client.query("UPDATE hd_tickets SET assignee_id = $2, updated_at = $3 WHERE id = $1", [ticketId, to, now]);
    const toName = fixed?.name ?? cands.find((c) => c.user_id === to)?.name ?? "someone";
    const fromName = fromUser ? (await client.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [fromUser])).rows[0]?.name ?? "the owner" : "";
    let note: string;
    let reason: string;
    if (method === "reassign_away") {
      reason = `${firstName(fromName)} is away or offline`;
      note = `Reassigned from ${fromName} to ${toName}: ${reason}.`;
    } else if (method === "reassign_unanswered") {
      reason = `no first reply within ${settings.unanswered_minutes} business minutes`;
      note = `Reassigned from ${fromName} to ${toName}: ${reason}.`;
    } else {
      const how = methodPhrase(method, rule?.name);
      const viaRule = rule && method !== "rule" ? ` (rule “${rule.name}”)` : "";
      const vip = vipReason ? ` VIP list: ${vipReason}.` : "";
      reason = `${how}${viaRule}`.trim();
      note = `Assigned to ${toName} ${how}${viaRule}${opts.trigger === "retry" ? waited(state?.queued_since ?? null, now) : ""}.${vip}${fallbackNote}`;
      if (fromUser && fromUser !== to) note = `Reassigned from ${fromName} to ${toName} ${how}${viaRule}.`;
    }
    await insertLog({ ticket_id: ticketId, method, rule_id: rule?.id ?? null, rule_name: rule?.name ?? "", from_user_id: fromUser, to_user_id: to, team_id: teamId, reason, at: now }, client);
    await writeNote(client, ticketId, note, now);
    await clearQueued(ticketId, client);
    if (reassign) await countReassign(ticketId, client);
    return { kind: "assigned" as const, to, method, note };
  });

  if (tx.kind === "changed") return { outcome: "skipped", reason: "The ticket changed meanwhile." };
  if (tx.kind === "nobody") return { outcome: "skipped", reason: `Nobody else can take it: ${tx.reason}.` };
  if (tx.kind === "queued") return { outcome: "queued", reason: tx.reason, rule_id: rule?.id ?? null };
  await notify(ticketId, tx.to, tx.method, rule?.name ?? null);
  return { outcome: "assigned", user_id: tx.to, method: tx.method, rule_id: rule?.id ?? null, reason: tx.note };
}

async function finishLeave(ticketId: number, note: string | undefined, rule: HdAssignmentRule | null, now: Date): Promise<AssignResult> {
  if (note) {
    await hq(`INSERT INTO hd_messages (ticket_id, author_name, kind, body, via, created_at) VALUES ($1, $2, 'internal', $3, 'system', $4)`, [ticketId, NOTE_AUTHOR, note, now]);
  }
  return { outcome: "left", reason: note ?? "Left in the queue.", rule_id: rule?.id ?? null };
}

async function finishQueue(ticketId: number, reason: string, decision: PendingDecision, now: Date): Promise<AssignResult> {
  const fresh = await queueTicket(ticketId, reason, decision, now);
  if (fresh) {
    await hq(`INSERT INTO hd_messages (ticket_id, author_name, kind, body, via, created_at) VALUES ($1, $2, 'internal', $3, 'system', $4)`, [
      ticketId,
      NOTE_AUTHOR,
      `No one available; waiting in the queue. (${reason}.)`,
      now,
    ]);
  }
  return { outcome: "queued", reason, rule_id: decision.rule_id ?? null };
}

// --- Manual assignments -----------------------------------------------------------------------------

/**
 * An agent (or an automation) set the owner by hand: log it and take the
 * ticket out of the retry queue. A calls this from PATCH
 * /api/helpdesk/tickets/[number] after a successful assignee change; no
 * note (updateTicket already wrote "Sam assigned the ticket to Ali").
 * Never throws.
 */
export async function recordManualAssignment(
  ticketId: number,
  e: { fromUserId: number | null; toUserId: number | null; teamId: number | null; actorId: number | null; method?: "manual" | "automation"; at?: Date }
): Promise<void> {
  try {
    await assignmentReady();
    await insertLog({ ticket_id: ticketId, method: e.method ?? "manual", from_user_id: e.fromUserId, to_user_id: e.toUserId, team_id: e.teamId, actor_id: e.actorId, at: e.at });
    if (e.toUserId) await clearQueued(ticketId);
  } catch (err) {
    logEvent("error", "helpdesk.assignment.log_failed", { ticketId, error: err instanceof Error ? err.message : String(err) });
  }
}

// --- The sweep ------------------------------------------------------------------------------------------

export interface SweepResult {
  ran: boolean;
  retried: number;
  assigned: number;
  reassignedAway: number;
  reassignedUnanswered: number;
}

const SWEEP_BATCH = 100;

/**
 * The periodic pass (lib/periodic HELPDESK_SWEEPS): retry queued tickets,
 * move tickets whose owner has been away/offline for a while (teams with
 * reassign_when_away), and tickets whose owner missed the first-reply
 * window (teams with unanswered_minutes, counted in business minutes of the
 * team's calendar). At most ASSIGNMENT_LIMITS.maxAutoReassigns automatic
 * reassignments per ticket. One instance at a time (advisory try-lock);
 * `teamIds` scopes a pass to some teams and skips the lock (tests). Never throws.
 */
export async function assignmentSweep(now: Date = new Date(), opts: { teamIds?: number[] } = {}): Promise<SweepResult> {
  const res: SweepResult = { ran: false, retried: 0, assigned: 0, reassignedAway: 0, reassignedUnanswered: 0 };
  try {
    await assignmentReady();
    if (opts.teamIds) {
      await sweepOnce(now, opts.teamIds, res);
      return res;
    }
    const { pool } = await import("../../db");
    const client = await pool().connect();
    try {
      const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [ASSIGNMENT_SWEEP_LOCK]);
      if (!lock.rows[0]?.ok) return res;
      try {
        await sweepOnce(now, null, res);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [ASSIGNMENT_SWEEP_LOCK]);
      }
    } finally {
      client.release();
    }
  } catch (e) {
    logEvent("error", "helpdesk.assignment.sweep_failed", { error: e instanceof Error ? e.message : String(e) });
  }
  return res;
}

async function sweepOnce(now: Date, teamIds: number[] | null, res: SweepResult): Promise<void> {
  res.ran = true;
  const scope = teamIds ? "AND t.team_id = ANY($2::int[])" : "";
  const p = (extra: unknown[] = []) => (teamIds ? [now, teamIds, ...extra] : [now, ...extra]);

  // Queued tickets someone took meanwhile, or that closed, leave the queue.
  await hq(
    `UPDATE hd_assignment_ticket s SET queued_since = NULL, queued_reason = '', updated_at = $1
       FROM hd_tickets t WHERE t.id = s.ticket_id AND s.queued_since IS NOT NULL
        AND (t.assignee_id IS NOT NULL OR t.status NOT IN ('new', 'open', 'pending', 'on_hold')) ${scope}`,
    p()
  );
  const queued = await hq<{ ticket_id: number }>(
    `SELECT s.ticket_id FROM hd_assignment_ticket s JOIN hd_tickets t ON t.id = s.ticket_id
      WHERE s.queued_since IS NOT NULL AND s.queued_since <= $1 AND t.assignee_id IS NULL ${scope}
      ORDER BY s.queued_since, s.ticket_id LIMIT ${SWEEP_BATCH}`,
    p()
  );
  for (const q of queued) {
    res.retried++;
    if ((await assignTicket(q.ticket_id, { trigger: "retry", now })).outcome === "assigned") res.assigned++;
  }

  const graceMs = ASSIGNMENT_LIMITS.awayGraceMinutes * 60_000;
  const away = await hq<{ id: number }>(
    `SELECT t.id FROM hd_tickets t
       JOIN hd_team_assignment a ON a.team_id = t.team_id AND a.mode <> 'manual' AND a.reassign_when_away = 1
       JOIN hd_agent_prefs pr ON pr.user_id = t.assignee_id
       LEFT JOIN hd_assignment_ticket s ON s.ticket_id = t.id
      WHERE t.status IN ('new', 'open') AND t.assignee_id IS NOT NULL
        AND (pr.availability = 'offline' OR (pr.availability = 'away' AND a.eligible = 'available'))
        AND pr.updated_at <= $1::timestamptz - make_interval(secs => ${graceMs / 1000})
        AND (COALESCE(s.auto_reassigns, 0) < ${ASSIGNMENT_LIMITS.maxAutoReassigns} OR COALESCE(s.cap_noted, 0) = 0) ${scope}
      ORDER BY t.id LIMIT ${SWEEP_BATCH}`,
    p()
  );
  for (const a of away) {
    if ((await assignTicket(a.id, { trigger: "agent_away", now })).outcome === "assigned") res.reassignedAway++;
  }

  const late = await hq<{ id: number; team_id: number; unanswered_minutes: number; assigned_at: string }>(
    `SELECT t.id, t.team_id, a.unanswered_minutes, l.at AS assigned_at FROM hd_tickets t
       JOIN hd_team_assignment a ON a.team_id = t.team_id AND a.mode <> 'manual' AND a.unanswered_minutes IS NOT NULL
       JOIN LATERAL (SELECT at FROM hd_assignment_log WHERE ticket_id = t.id AND to_user_id = t.assignee_id ORDER BY at DESC, id DESC LIMIT 1) l ON true
       LEFT JOIN hd_assignment_ticket s ON s.ticket_id = t.id
      WHERE t.status IN ('new', 'open') AND t.assignee_id IS NOT NULL
        AND l.at <= $1::timestamptz - make_interval(mins => a.unanswered_minutes)
        AND NOT EXISTS (SELECT 1 FROM hd_messages m WHERE m.ticket_id = t.id AND m.author_id = t.assignee_id AND m.kind = 'public' AND m.created_at >= l.at)
        AND (COALESCE(s.auto_reassigns, 0) < ${ASSIGNMENT_LIMITS.maxAutoReassigns} OR COALESCE(s.cap_noted, 0) = 0) ${scope}
      ORDER BY t.id LIMIT ${SWEEP_BATCH}`,
    p()
  );
  if (late.length) {
    const { businessMinutesForTicket } = await import("../calendars");
    for (const l of late) {
      const mins = await businessMinutesForTicket({ team_id: l.team_id }, Date.parse(l.assigned_at), now).catch(() => Infinity);
      if (mins < l.unanswered_minutes) continue;
      if ((await assignTicket(l.id, { trigger: "unanswered", now })).outcome === "assigned") res.reassignedUnanswered++;
    }
  }
}

// --- Views for the settings page --------------------------------------------------------------------------

export interface TeamAssignmentView {
  settings: HdTeamAssignment;
  members: HdAssignmentMemberView[];
  /** Who the next ticket would go to now, or why nobody. */
  next: { user_id: number | null; name: string | null; reason: string };
  open: boolean;
  queued: number;
}

/** Settings, members (weights, pauses, open counts, why they'd be skipped) and the "Who's next" preview. Reads only. */
export async function teamAssignmentView(teamId: number, now: Date = new Date()): Promise<TeamAssignmentView> {
  await assignmentReady();
  const settings = await getTeamAssignment(teamId);
  const open = await teamOpen(teamId, now);
  const cands = await teamCandidates(teamId, settings, { open });
  const load = await loadOf(cands.map((c) => c.user_id));
  const members: HdAssignmentMemberView[] = cands.map((c) => {
    const l = load.get(c.user_id) ?? { open_count: 0, last_assigned_at: null };
    return {
      user_id: c.user_id,
      name: c.name,
      email: c.email,
      role: c.desk_role,
      role_label: roleLabel(c.desk_role),
      weight: c.weight,
      paused: c.paused,
      availability: c.availability,
      open_count: l.open_count,
      last_assigned_at: l.last_assigned_at,
      skip_reason: c.skip || capacitySkip(settings, l.open_count),
    };
  });
  const able = members.filter((m) => !m.skip_reason);
  let next: TeamAssignmentView["next"];
  if (settings.mode === "manual") next = { user_id: null, name: null, reason: "New tickets wait in the queue until someone takes them." };
  else {
    let id: number | null = null;
    if (settings.mode === "load_balanced") id = pickLeastLoaded(able.map((m) => ({ user_id: m.user_id, weight: m.weight, open_count: m.open_count, last_assigned_at: m.last_assigned_at })));
    else {
      const cur = await hqOne<{ last_user_id: number | null; streak: number }>("SELECT last_user_id, streak FROM hd_assignment_cursor WHERE team_id = $1", [teamId]);
      id = pickRoundRobin(able.map((m) => ({ user_id: m.user_id, weight: m.weight })), { last_user_id: cur?.last_user_id ?? null, streak: cur?.streak ?? 0 })?.user_id ?? null;
    }
    const who = members.find((m) => m.user_id === id);
    next = who
      ? { user_id: who.user_id, name: who.name, reason: settings.mode === "load_balanced" ? `Fewest open tickets (${who.open_count})` : "Next in turn" }
      : {
          user_id: null,
          name: null,
          reason: `No one available; new tickets wait in the queue. ${whyNobody(cands, new Map(members.map((m) => [m.user_id, m.skip_reason])), !open && settings.respect_shift === 1)}.`,
        };
  }
  const q = await hqOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM hd_assignment_ticket s JOIN hd_tickets t ON t.id = s.ticket_id
      WHERE s.queued_since IS NOT NULL AND t.team_id = $1 AND t.assignee_id IS NULL AND t.status IN ('new', 'open', 'pending', 'on_hold')`,
    [teamId]
  );
  return { settings, members, next, open, queued: q?.n ?? 0 };
}

// --- The rules' test box -------------------------------------------------------------------------------------

export interface RuleTestSample {
  ticket_number?: number;
  subject?: string;
  body?: string;
  source?: string;
  automated?: boolean;
  integration_id?: string | null;
  team_id?: number | null;
  priority?: string;
  category?: string;
  request_type_id?: number | null;
  tags?: string[];
  department?: string;
  office?: string;
  vip?: boolean;
  hours?: "open" | "closed";
  severity?: string;
  answers?: Record<string, unknown>;
}

export interface RuleTestResult {
  matched: { id: number; name: string } | null;
  trace: RuleTraceLine[];
  /** "Moves to Infra, sets Urgent, then round robin among Infra's agents (next: Sam)." */
  outcome: string;
}

/** Which rule would match this ticket (or sample), why, and what would happen. Writes nothing. */
export async function testRules(sample: RuleTestSample, ticket: TicketForAssign | null, now: Date = new Date()): Promise<RuleTestResult> {
  await assignmentReady();
  const rules = await listRules();
  const teams = new Map((await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams")).map((t) => [t.id, t.name]));
  const teamName = (id: number) => teams.get(id) ?? "a deleted team";
  let facts: HdAssignFacts;
  let severity: unknown = sample.severity ?? null;
  if (ticket) {
    facts = await factsFor(ticket, now);
    severity = await severityOf(ticket);
  } else {
    const automated = sample.automated === true || sample.source === "alert" || sample.source === "api";
    const teamId = sample.team_id ?? null;
    facts = {
      source: sample.source ?? "portal",
      automated,
      integration_id: sample.integration_id ?? null,
      request_type_id: sample.request_type_id ?? null,
      team_id: teamId,
      priority: sample.priority ?? "normal",
      category: sample.category ?? "",
      tags: sample.tags ?? [],
      subject: sample.subject ?? "",
      body: sample.body ?? "",
      answers: sample.answers ?? {},
      requester: automated ? null : { department: sample.department ?? "", office: sample.office ?? "", vip: sample.vip === true, vip_reason: "" },
      open: sample.hours ? sample.hours === "open" : await teamOpen(teamId, now),
    };
  }
  const fixedOpen = !ticket && sample.hours ? sample.hours === "open" : null;
  const openCache = new Map<number, boolean>();
  for (const r of rules) {
    const id = r.action?.team_id;
    if (typeof id === "number" && !openCache.has(id)) openCache.set(id, fixedOpen ?? (await teamOpen(id, now)));
  }
  const d = evaluateRules(rules, facts, { severity, teamName, openFor: (id) => (id === null ? true : openCache.get(id) ?? true) });
  const parts: string[] = [];
  const teamId = d.team_id ?? facts.team_id;
  if (d.team_id && d.team_id !== facts.team_id) parts.push(`moves to ${teamName(d.team_id)}`);
  if (d.priority && d.priority !== facts.priority) parts.push(`sets ${HD_PRIORITY_LABEL[d.priority as keyof typeof HD_PRIORITY_LABEL] ?? d.priority}`);
  if (d.add_tags.length) parts.push(`tags ${d.add_tags.join(", ")}`);
  let how = "";
  const seniors = d.min_role ? ` (${roleLabel(d.min_role)} or above)` : "";
  if (teamId === null && d.assign !== "user") how = "stays without a team, in the queue";
  else {
    const name = teamId !== null ? teamName(teamId) : "";
    const s = teamId !== null ? await getTeamAssignment(teamId) : null;
    const kind =
      d.assign === "team_mode" ? (s?.mode ?? "manual") : d.assign === "round_robin_in_team" ? "round_robin" : d.assign === "load_balanced_in_team" ? "load_balanced" : d.assign;
    if (kind === "manual") how = `waits in ${name}'s queue (the team assigns by hand)`;
    else if (kind === "leave_unassigned") how = `waits in ${name}'s queue`;
    else if (kind === "user") {
      const u = d.user_id ? await hqOne<{ name: string }>("SELECT name FROM users WHERE id = $1", [d.user_id]) : undefined;
      how = `goes to ${u?.name ?? "the named person"}`;
    } else if (kind === "on_call") {
      const who = teamId !== null ? await onCallNow(teamId, now) : null;
      const u = who ? await hqOne<{ name: string }>("SELECT name FROM users WHERE id = $1", [who.user_id]) : undefined;
      how = u ? `goes to ${u.name}, on call for ${name} now` : `waits in ${name}'s queue: nobody is on call now`;
    } else if (s) {
      const open = facts.team_id === teamId ? facts.open : openCache.get(teamId!) ?? true;
      const cands = (await teamCandidates(teamId!, s, { minRole: d.min_role, open })).filter((c) => !c.skip);
      const load = await loadOf(cands.map((c) => c.user_id));
      const able = cands.filter((c) => !capacitySkip(s, load.get(c.user_id)?.open_count ?? 0));
      let id: number | null;
      if (kind === "load_balanced") id = pickLeastLoaded(able.map((c) => ({ user_id: c.user_id, weight: c.weight, ...(load.get(c.user_id) ?? { open_count: 0, last_assigned_at: null }) })));
      else {
        const cur = await hqOne<{ last_user_id: number | null; streak: number }>("SELECT last_user_id, streak FROM hd_assignment_cursor WHERE team_id = $1", [teamId]);
        id = pickRoundRobin(able.map((c) => ({ user_id: c.user_id, weight: c.weight })), { last_user_id: cur?.last_user_id ?? null, streak: cur?.streak ?? 0 })?.user_id ?? null;
      }
      const label = kind === "load_balanced" ? `goes to the least busy in ${name}${seniors}` : `goes round robin in ${name}${seniors}`;
      const who = able.find((c) => c.user_id === id);
      how = who ? `${label}: next is ${who.name}` : `${label}, but no one is available now, so it waits in the queue`;
    }
  }
  parts.push(how);
  const lead = d.matched.length ? `Rule “${d.rule?.name ?? d.matched[0].name}” matches` : "No rule matches";
  return {
    matched: d.matched.length ? { id: (d.rule ?? d.matched[0]).id, name: (d.rule ?? d.matched[0]).name } : null,
    trace: d.trace,
    outcome: `${lead}: it ${parts.filter(Boolean).join(", then ")}.`,
  };
}

/** The ticket loader for the test box (by number). */
export async function ticketForTest(number: number): Promise<TicketForAssign | null> {
  const row = await hqOne<{ id: number }>("SELECT id FROM hd_tickets WHERE number = $1", [number]);
  return row ? (await loadTicket(row.id)) ?? null : null;
}
