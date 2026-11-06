// Helpdesk 1.19.0: the workflow engine. A request of a type linked to a
// published workflow starts a run (startWorkflowForRequest, called by
// lib/helpdesk/events afterTicketCreated); the run walks the definition it
// pinned at start, one top-level step at a time:
//
//   approval  an hd_approvals row for the approver (lib/helpdesk/approvals
//             says who); approve → next step; decline → on_decline: close
//             (the request is solved with the note, the run is 'declined')
//             or continue
//   task      a child ticket for the task's team (source 'workflow',
//             parent_ticket_id = the request, subject "<title>: <subject>",
//             resolve_due from the form date or after_hours). The team may
//             be routed by an answer or the requester's directory entry.
//             The team finishes it by recording an outcome
//             (recordTaskOutcome: done, with the task's hand-off outputs,
//             or "can't be done" with a note) or by solving the ticket
//             (onTicketSolved, from events afterTicketSolved; refused while
//             required outputs are missing: validateTaskSolve). "Can't be
//             done" either carries on or blocks the run for the
//             coordinating team (the request type's team), who retry the
//             step, skip it or cancel the run
//   parallel  its tasks all at once; done when every one is finished
//   wait      until a form date or for some hours; the sweep moves it on
//   notify    bell + email to the requester, a person or a team
//   finish    solves the request (and asks for CSAT when it is on); a
//             "Request access" run (its workflow asks the space's owner)
//             whose approvals were all approved, the space-owner ones
//             asked about the request's own space, also gives read on that
//             space (lib/helpdesk/space-access runMayGrantSpace)
// Any step may carry a condition (`when`); a false one skips the step with
// a note on the request. Running out of steps without a Finish ends the run
// and leaves the request open for its team.
//
// Pinning: the run stores the definition it started with under
// current.definition (and the version in workflow_version); publishing a
// new version never changes a run on its way.
//
// Idempotency and locks: every advance runs in one transaction holding the
// run's row lock (SELECT … FOR UPDATE), so concurrent events (two tasks of
// a group solved at once, a double-clicked Approve, the sweep and a
// decision) serialise; a step's runtime row is unique per (run, key), so a
// step is started once. Notices and mail are queued as effects and sent
// after the commit, never while a client is held (the pool has five).
//
// Time per team (reports): a task's hd_workflow_steps row keeps
// started_at / finished_at, result.started_team_id, result.team_id and
// team_name (current), result.transfers [{from_team_id, from_team_name,
// to_team_id, to_team_name, at}], result.outcome ('done' | 'cant_do'),
// result.note, result.outputs, result.handoff_note, result.solved_by(_id),
// result.attempts and result.attempt_log (retries).
//
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { claimPeriod } from "../db";
import { featureEnabled } from "../ee";
import { audit } from "../audit";
import type { AuditActor } from "../audit";
import { logEvent } from "../log";
import { hq, hqOne, withTx } from "./db-core";
import { resolveManager, spaceOwner, teamLeadIds } from "./approvals";
import { answerText } from "./request-types";
import { insertTicketTx, updateTicket } from "./tickets";
import {
  evaluateWhen,
  outputDefsOf,
  outputText,
  pickRouteTeam,
  renderTemplate,
  requesterFacts,
  taskDueAt,
  validateOutputs,
  waitUntil,
} from "./workflows";
import type { FactSource } from "./workflows";
import { afterGrant, grantReadInTx, requestedSpaceId, runMayGrantSpace, SPACE_APPROVER_PUBLIC_LABEL } from "./space-access";
import type { SpaceGrant } from "./space-access";
import type {
  HdApprovalStepDef,
  HdFormAnswers,
  HdFormField,
  HdNotifyStepDef,
  HdRunStep,
  HdRunStepKind,
  HdTicketRow,
  HdWaitStepDef,
  HdWorkflowRun,
} from "./types";
import type {
  HdApproverDefB,
  HdApproverKindB,
  HdHandoff,
  HdMissingOutput,
  HdOutputValue,
  HdProgressStepB,
  HdRunStepStateB,
  HdTaskOutcomeInput,
  HdTaskOutputDef,
  HdTaskStepDefB,
  HdTaskTransfer,
  HdWorkflowDefinitionB,
  HdWorkflowProgressB,
  HdWorkflowRunStateB,
  HdWorkflowStepB,
} from "./types";

type RunState = HdWorkflowRunStateB;
type StepState = HdRunStepStateB;
type Run = Omit<HdWorkflowRun, "state"> & { state: RunState };
type Row = Omit<HdRunStep, "state" | "kind"> & { state: StepState; kind: HdRunStepKind | "parallel" };

const OPEN_STATES: readonly RunState[] = ["running", "waiting"];
const LIVE_STATES: readonly RunState[] = ["running", "waiting", "blocked"];
const DONE_TICKET = new Set(["solved", "closed"]);
const SYSTEM_AUTHOR = "Workflow";
export const TASK_NOTE_MAX = 2_000;

type Effect = () => Promise<unknown>;

interface Blocked {
  step_key: string;
  title: string;
  note: string;
  at: string;
}

interface Cursor {
  definition: HdWorkflowDefinitionB;
  index: number;
  workflow_title: string;
  blocked?: Blocked | null;
}

interface TicketCtx extends HdTicketRow {
  request_type_title: string | null;
  rt_team_id: number | null;
  rt_form: HdFormField[] | null;
}

interface Ctx {
  client: PoolClient;
  run: Run;
  cursor: Cursor;
  ticket: TicketCtx;
  rows: Map<string, Row>;
  effects: Effect[];
  now: Date;
  actor: AuditActor | null;
  state: RunState;
  facts?: FactSource;
}

export class EngineRefusal extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
    public missing?: string[]
  ) {
    super(message);
  }
}

// --- Small helpers -------------------------------------------------------------------

function cursorOf(run: Pick<HdWorkflowRun, "current">): Cursor {
  const c = (run.current ?? {}) as Partial<Cursor>;
  return {
    definition: c.definition && Array.isArray(c.definition.steps) ? c.definition : { trigger: {}, steps: [] },
    index: Number.isInteger(c.index) ? (c.index as number) : 0,
    workflow_title: typeof c.workflow_title === "string" ? c.workflow_title : "Workflow",
    blocked: c.blocked ?? null,
  };
}

/** A task definition of a pinned definition by key (top level or in a group). */
function taskDef(def: HdWorkflowDefinitionB, key: string): HdTaskStepDefB | undefined {
  for (const s of def.steps) {
    if (s.kind === "task" && s.key === key) return s;
    if (s.kind === "parallel") {
      const t = s.steps.find((x) => x.key === key);
      if (t) return t;
    }
  }
  return undefined;
}

async function runEffects(effects: Effect[]): Promise<void> {
  for (const fx of effects) {
    try {
      await fx();
    } catch (e) {
      logEvent("error", "helpdesk.workflow_effect_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

const dayText = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

async function sysMsg(client: PoolClient, ticketId: number, body: string, kind: "system" | "internal" = "system"): Promise<void> {
  await client.query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via)
     VALUES ($1, NULL, $2, '', $3, $4, 'system')`,
    [ticketId, SYSTEM_AUTHOR, kind, body.slice(0, 20_000)]
  );
  await client.query("UPDATE hd_tickets SET updated_at = now() WHERE id = $1", [ticketId]);
}

async function loadTicket(client: PoolClient, ticketId: number): Promise<TicketCtx | undefined> {
  return hqOne<TicketCtx>(
    `SELECT t.*, rt.title AS request_type_title, rt.team_id AS rt_team_id, rt.form AS rt_form
       FROM hd_tickets t LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id
      WHERE t.id = $1`,
    [ticketId],
    client
  );
}

async function teamName(client: PoolClient, teamId: number | null): Promise<string | null> {
  if (!teamId) return null;
  return (await hqOne<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [teamId], client))?.name ?? null;
}

async function userName(client: PoolClient, userId: number): Promise<string | null> {
  return (
    (await hqOne<{ name: string }>(
      "SELECT coalesce(nullif(name, ''), username) AS name FROM users WHERE id = $1 AND status = 'active'",
      [userId],
      client
    ))?.name ?? null
  );
}

async function insertStep(
  c: Ctx,
  key: string,
  kind: Row["kind"],
  state: StepState,
  result: Record<string, unknown>,
  extra: { task_ticket_id?: number | null; wait_until?: Date | null } = {}
): Promise<Row> {
  // Unique (run_id, step_key): a step that somehow exists already is read back, never started twice.
  const row = await hqOne<Row>(
    `INSERT INTO hd_workflow_steps (run_id, step_key, kind, state, task_ticket_id, wait_until, started_at, finished_at, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 IN ('done', 'skipped') THEN $7::timestamptz END, $8::jsonb)
     ON CONFLICT (run_id, step_key) DO NOTHING
     RETURNING *`,
    [c.run.id, key, kind, state, extra.task_ticket_id ?? null, extra.wait_until ?? null, c.now, JSON.stringify(result)],
    c.client
  );
  const out = row ?? (await hqOne<Row>("SELECT * FROM hd_workflow_steps WHERE run_id = $1 AND step_key = $2", [c.run.id, key], c.client))!;
  c.rows.set(key, out);
  return out;
}

async function setStep(client: PoolClient, row: Row, state: StepState, now: Date, result: Record<string, unknown> = {}, rows?: Map<string, Row>): Promise<Row> {
  const r = await hqOne<Row>(
    `UPDATE hd_workflow_steps
        SET state = $2,
            finished_at = CASE WHEN $2 IN ('done', 'declined', 'skipped', 'cancelled', 'failed') THEN $3::timestamptz ELSE finished_at END,
            result = result || $4::jsonb
      WHERE id = $1 RETURNING *`,
    [row.id, state, now, JSON.stringify(result)],
    client
  );
  if (r && rows) rows.set(r.step_key, r);
  return r ?? row;
}

async function solveRequest(c: Ctx): Promise<boolean> {
  // A request paused (waiting on the requester, on hold) resumes its SLA
  // clock as it is solved, as the core's updateTicket does: the paused time
  // is banked and sla_paused_at cleared, so a later reopen counts again.
  const r = await c.client.query(
    `UPDATE hd_tickets SET status = 'solved', solved_at = coalesce(solved_at, $2), updated_at = now(),
            sla_paused_ms = sla_paused_ms + CASE WHEN sla_paused_at IS NULL THEN 0
                              ELSE greatest(0, floor(extract(epoch FROM ($2::timestamptz - sla_paused_at)) * 1000))::bigint END,
            sla_paused_at = NULL
      WHERE id = $1 AND status NOT IN ('solved', 'closed')`,
    [c.ticket.id, c.now]
  );
  return (r.rowCount ?? 0) > 0;
}

async function endRun(c: Ctx, state: RunState): Promise<void> {
  c.state = state;
  await c.client.query(
    `UPDATE hd_workflow_runs SET state = $2, finished_at = $3, current = (current - 'blocked') || jsonb_build_object('index', $4::int) WHERE id = $1`,
    [c.run.id, state, c.now, c.cursor.index]
  );
}

async function notifyMod() {
  return import("./notify");
}

/** What conditions and routes read: answers, the requester's directory entry, hand-offs so far. Loaded once per advance. */
async function factsOf(c: Ctx): Promise<FactSource> {
  if (!c.facts) {
    const form = c.ticket.rt_form ?? [];
    const answers = c.ticket.form_answers ?? {};
    const people = form.filter((f) => f.type === "user" && typeof answers[f.key] === "number").map((f) => answers[f.key] as number);
    const names = new Map<number, string>();
    if (people.length) {
      for (const r of await hq<{ id: number; name: string }>(
        "SELECT id, coalesce(nullif(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])",
        [people],
        c.client
      )) {
        names.set(r.id, r.name);
      }
    }
    c.facts = {
      form,
      answers,
      names,
      requester: await requesterFacts(c.ticket.requester_id, c.client),
      outputs: {},
      outputDefs: outputDefsOf(c.cursor.definition),
    };
  }
  // Hand-offs move during an advance: always current.
  const outputs: Record<string, Record<string, HdOutputValue>> = {};
  for (const r of c.rows.values()) {
    const o = r.result?.outputs as Record<string, HdOutputValue> | undefined;
    if (r.kind === "task" && o && typeof o === "object") outputs[r.step_key] = o;
  }
  c.facts.outputs = outputs;
  return c.facts;
}

/** Answers and hand-offs as text, for templates ({{start_date}}, {{outputs.it.asset_tag}}). */
async function templateParts(c: Ctx): Promise<{ vars: Record<string, string>; answers: Record<string, string>; outputs: Record<string, Record<string, string>> }> {
  const f = await factsOf(c);
  const answers: Record<string, string> = {};
  for (const field of f.form) answers[field.key] = answerText(field, f.answers[field.key], f.names);
  const outputs: Record<string, Record<string, string>> = {};
  for (const [step, values] of Object.entries(f.outputs)) {
    const defs = f.outputDefs.get(step) ?? [];
    outputs[step] = {};
    for (const [k, v] of Object.entries(values)) outputs[step][k] = outputText(defs.find((d) => d.key === k), v);
  }
  return {
    vars: {
      requester: c.ticket.requester_name || "the requester",
      subject: c.ticket.subject,
      number: String(c.ticket.number),
      request_type: c.ticket.request_type_title ?? "",
      workflow: c.cursor.workflow_title,
      tasks: tasksSummary(c),
    },
    answers,
    outputs,
  };
}

/** A condition said no: the step is skipped, with the reason on the request. */
async function skipForCondition(c: Ctx, key: string, kind: Row["kind"], title: string, reason: string): Promise<void> {
  await insertStep(c, key, kind, "skipped", { title, skip_reason: reason });
  await sysMsg(c.client, c.ticket.id, `Skipped: ${title} (${reason}).`);
}

// --- Approval --------------------------------------------------------------------------

interface ApproverTarget {
  kind: HdApproverKindB;
  user_id: number | null;
  team_id: number | null;
  /** "Sara Haddad", "any one member of HR", "the leads of IT". */
  label: string;
  /** A second system message: who stands in, and why. */
  note?: string;
  /** What the requester reads instead of `label` (a space-owner step: never the owner's name). */
  public_label?: string;
  /** A space-owner step: the space it was asked about (the grant checks it). */
  space_id?: number;
}

/** Nobody named: the request type's (else the ticket's) team leads, any member when it has none, else helpdesk admins. */
async function fallbackTarget(c: Ctx, why: string): Promise<ApproverTarget> {
  return fallbackFor(c.client, c.ticket, why);
}

async function fallbackFor(client: PoolClient, ticket: { rt_team_id: number | null; team_id: number | null }, why: string): Promise<ApproverTarget> {
  const teamId = ticket.rt_team_id ?? ticket.team_id;
  const name = await teamName(client, teamId);
  if (teamId && name) {
    const leads = await teamLeadIds(teamId, client);
    const label = leads.length ? `the leads of ${name}` : `any one member of ${name}`;
    return { kind: "manager", user_id: null, team_id: teamId, label, note: `${why}, so ${label} will decide.` };
  }
  return { kind: "manager", user_id: null, team_id: null, label: "the helpdesk admins", note: `${why}, so the helpdesk admins will decide.` };
}

async function resolveApprover(c: Ctx, step: HdApprovalStepDef): Promise<ApproverTarget> {
  const approver = step.approver as HdApproverDefB;
  const requester = c.ticket.requester_id;
  switch (approver.kind) {
    case "user": {
      const name = await userName(c.client, approver.user_id);
      if (!name) return fallbackTarget(c, "The named approver is no longer an active account");
      if (approver.user_id === requester) return fallbackTarget(c, `${name} sent this request and cannot approve it`);
      return { kind: "user", user_id: approver.user_id, team_id: null, label: name };
    }
    case "team": {
      const name = await teamName(c.client, approver.team_id);
      if (!name) return fallbackTarget(c, "The approving team no longer exists");
      return { kind: "team", user_id: null, team_id: approver.team_id, label: `any one member of ${name}` };
    }
    case "space_owner": {
      // Whoever it resolves to, the requester reads the same words
      // (SPACE_APPROVER_PUBLIC_LABEL): an owner's name, or who stands in,
      // would tell them which spaces exist and who owns them.
      const named = requestedSpaceId(c.ticket);
      const space = named
        ? await hqOne<{ id: number }>("SELECT id FROM spaces WHERE id = $1 AND visibility = 'private'", [named], c.client)
        : undefined;
      if (space) {
        const owner = await spaceOwner(space.id, c.client);
        if (owner && owner.user_id !== requester) {
          return { kind: "user", user_id: owner.user_id, team_id: null, label: owner.name, public_label: SPACE_APPROVER_PUBLIC_LABEL, space_id: space.id };
        }
        return { kind: "space", user_id: null, team_id: null, label: "the people who manage space access", public_label: SPACE_APPROVER_PUBLIC_LABEL, space_id: space.id };
      }
      return { ...(await fallbackTarget(c, "This request does not name a private space")), public_label: SPACE_APPROVER_PUBLIC_LABEL };
    }
    case "manager":
    default: {
      const mgr = await resolveManager(requester, c.client);
      if (mgr) return { kind: "manager", user_id: mgr.user_id, team_id: null, label: mgr.name };
      const who = c.ticket.requester_name || "the requester";
      return fallbackTarget(c, `No manager is set for ${who} in the directory`);
    }
  }
}

async function evalApproval(c: Ctx, s: HdApprovalStepDef): Promise<"advance" | "blocked" | "ended"> {
  const row = c.rows.get(s.key);
  if (!row) {
    const target = await resolveApprover(c, s);
    const created = await insertStep(c, s.key, "approval", "active", {
      title: s.title,
      on_decline: s.on_decline,
      remind_after_hours: s.remind_after_hours ?? null,
      approver_label: target.label,
      ...(target.public_label ? { approver_public_label: target.public_label } : {}),
      ...(target.space_id ? { space_id: target.space_id } : {}),
    });
    const a = await hqOne<{ id: number }>(
      `INSERT INTO hd_approvals (run_id, step_id, ticket_id, approver_kind, approver_team_id, approver_user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [c.run.id, created.id, c.ticket.id, target.kind, target.team_id, target.user_id],
      c.client
    );
    if (target.public_label) {
      // The requester reads the generic words; agents read who was asked (and why).
      await sysMsg(c.client, c.ticket.id, `Waiting for approval from ${target.public_label}: ${s.title}.`);
      await sysMsg(c.client, c.ticket.id, target.note ?? `Asked: ${target.label}.`, "internal");
    } else {
      await sysMsg(c.client, c.ticket.id, `Waiting for approval from ${target.label}: ${s.title}.`);
      if (target.note) await sysMsg(c.client, c.ticket.id, target.note);
    }
    const approvalId = a!.id;
    c.effects.push(async () => (await notifyMod()).notifyApprovalNeeded(approvalId, {}));
    return "blocked";
  }
  if (row.state === "done" || row.state === "skipped") return "advance";
  const decisions = await hq<{ decision: string }>("SELECT decision FROM hd_approvals WHERE step_id = $1 ORDER BY id", [row.id], c.client);
  if (decisions.some((d) => d.decision === "approved")) {
    await setStep(c.client, row, "done", c.now, { decision: "approved" }, c.rows);
    return "advance";
  }
  const declined = decisions.find((d) => d.decision === "declined");
  if (!declined || decisions.some((d) => d.decision === "pending")) return "blocked";
  if (s.on_decline === "continue") {
    await setStep(c.client, row, "done", c.now, { decision: "declined" }, c.rows);
    return "advance";
  }
  // Close: the request is solved with the note, the run ends declined, nothing after it starts.
  await setStep(c.client, row, "declined", c.now, { decision: "declined" }, c.rows);
  await sysMsg(c.client, c.ticket.id, `The request was closed because it was declined.`);
  await solveRequest(c);
  await endRun(c, "declined");
  return "ended";
}

// --- Tasks ---------------------------------------------------------------------------

const md = (s: string) => s.replace(/[*_`]/g, "");

function answersMarkdown(form: HdFormField[] | null, answers: HdFormAnswers, names?: Map<number, string>): string {
  const lines: string[] = [];
  for (const f of form ?? []) {
    const v = answerText(f, answers[f.key], names);
    if (v) lines.push(`- **${md(f.label)}**: ${v.replace(/\s+/g, " ").slice(0, 500)}`);
  }
  return lines.join("\n");
}

/** One task's hand-off as lines ("- Asset tag: LT-1234"), from its row. */
function handoffLines(defs: HdTaskOutputDef[] | undefined, row: Row): string[] {
  const outputs = (row.result?.outputs ?? {}) as Record<string, HdOutputValue>;
  const lines = (defs ?? [])
    .filter((d) => outputs[d.key] !== undefined && outputs[d.key] !== null && outputs[d.key] !== "")
    .map((d) => `- ${md(d.label)}: ${outputText(d, outputs[d.key])}`);
  const note = String(row.result?.handoff_note ?? "").trim();
  if (note) lines.push(`- Note: ${note.replace(/\s+/g, " ")}`);
  return lines;
}

/** Hand-offs recorded so far, as a markdown block for a later task's opening note. */
function handoffsSoFar(c: Ctx): string {
  const blocks: string[] = [];
  for (const r of c.rows.values()) {
    if (r.kind !== "task" || r.state !== "done") continue;
    const lines = handoffLines(taskDef(c.cursor.definition, r.step_key)?.outputs, r);
    if (lines.length) blocks.push(`**${md(String(r.result?.team_name ?? "A team"))}: ${md(String(r.result?.title ?? r.step_key))}**\n${lines.join("\n")}`);
  }
  return blocks.length ? `**Hand-offs so far**\n\n${blocks.join("\n\n")}` : "";
}

function tasksSummary(c: Ctx): string {
  const lines: string[] = [];
  for (const row of c.rows.values()) {
    if (row.kind !== "task") continue;
    const team = (row.result?.team_name as string | undefined) ?? "A team";
    const by = row.result?.solved_by as string | undefined;
    const state =
      row.state === "done" ? `done${by ? ` by ${by}` : ""}` : row.state === "skipped" ? "skipped" : row.state === "failed" ? "could not be done" : "in progress";
    lines.push(`- ${team}: ${row.result?.title ?? row.step_key} (${state})`);
  }
  return lines.join("\n");
}

/**
 * Start a task: its team (routed when the task routes), its child ticket
 * and the step row (inserted, or, on a retry, the existing row reused).
 */
async function startTask(c: Ctx, t: HdTaskStepDefB, retryRow?: Row): Promise<void> {
  const facts = await factsOf(c);
  const keepTeam = retryRow ? (retryRow.result?.team_id as number | undefined) : undefined;
  const routed = keepTeam ? { team_id: keepTeam, reason: "", routed: false } : pickRouteTeam(t.route, facts, t.team_id);
  const name = await teamName(c.client, routed.team_id);
  const teamId = name ? routed.team_id : null;
  const due = taskDueAt(t.due, c.ticket.form_answers ?? {}, c.now);
  const subject = `${t.title}: ${c.ticket.subject}`.slice(0, 300);
  // The core's own insert (number, SLA policy, reply token), inside this
  // transaction; no hooks run for a task ticket (no acknowledgement to a
  // requester who never asked for it). A task answers no requester, so it
  // has no first-reply target, and its due date is the task's.
  const child = await insertTicketTx(c.client, {
    subject,
    requester: { id: null, name: c.ticket.requester_name, email: "" },
    team_id: teamId,
    priority: c.ticket.priority,
    category: c.ticket.category,
    source: "workflow",
    source_ref: { parent_number: c.ticket.number, run_id: c.run.id, step_key: t.key },
    parent_ticket_id: c.ticket.id,
    created_at: c.now,
  });
  await c.client.query("UPDATE hd_tickets SET first_reply_due = NULL, resolve_due = coalesce($2::timestamptz, resolve_due) WHERE id = $1", [child.id, due]);
  const base = {
    title: t.title,
    team_id: teamId,
    team_name: name,
    on_cant_do: t.on_cant_do ?? "stop",
    route_reason: t.route ? routed.reason : null,
  };
  if (retryRow) {
    const attempts = Number(retryRow.result?.attempts ?? 1) + 1;
    const r = await hqOne<Row>(
      `UPDATE hd_workflow_steps
          SET state = 'active', task_ticket_id = $2, finished_at = NULL,
              result = (result - 'needs_ticket' - 'outcome' - 'note' - 'outputs' - 'handoff_note' - 'solved_by' - 'solved_by_id' - 'outcome_at')
                       || $3::jsonb
        WHERE id = $1 RETURNING *`,
      [retryRow.id, child.id, JSON.stringify({ ...base, attempts })],
      c.client
    );
    if (r) c.rows.set(r.step_key, r);
  } else {
    await insertStep(
      c,
      t.key,
      "task",
      "active",
      { ...base, started_team_id: teamId, transfers: [], attempts: 1 },
      { task_ticket_id: child.id }
    );
  }
  const parts = await templateParts(c);
  const description = t.description ? renderTemplate(t.description, parts.vars, parts.answers, parts.outputs) : "";
  await sysMsg(
    c.client,
    child.id,
    `Task from the ${c.cursor.workflow_title} workflow for request #${c.ticket.number} (${c.ticket.subject}). Record the outcome (or solve this ticket) when it's done; the workflow then moves on.`
  );
  const answers = answersMarkdown(c.ticket.rt_form, c.ticket.form_answers ?? {}, facts.names);
  const outputsAsked = t.outputs?.length ? `**Hand back when done**\n\n${t.outputs.map((o) => `- ${md(o.label)}${o.required ? " (required)" : ""}`).join("\n")}` : "";
  const note = [description, answers ? `**Answers on the request**\n\n${answers}` : "", handoffsSoFar(c), outputsAsked].filter(Boolean).join("\n\n");
  if (note) await sysMsg(c.client, child.id, note, "internal");
  if (t.route && name) await sysMsg(c.client, c.ticket.id, `Routed to ${name} (${routed.reason}): ${t.title}.`);
  await sysMsg(c.client, c.ticket.id, retryRow ? `Trying again: ${t.title}${name ? ` (${name})` : ""}.` : name ? `${name} is on it: ${t.title}.` : `Task started: ${t.title}.`);
  if (!name) await sysMsg(c.client, c.ticket.id, `The team for "${t.title}" no longer exists, so its task is in no queue yet.`, "internal");
  const childId = child.id;
  const dueLabel = due ? dayText(due) : undefined;
  c.effects.push(async () => (await notifyMod()).notifyTaskAssigned(childId, { dueLabel }));
}

type TaskState = "done" | "open" | "stop";

/** Start a task or check it: done (finished, or failed and carrying on), open, or stop (failed, the run blocks). */
async function evalTask(c: Ctx, t: HdTaskStepDefB): Promise<TaskState> {
  const row = c.rows.get(t.key);
  if (!row || row.result?.needs_ticket) {
    if (!row && t.when) {
      const cond = evaluateWhen(t.when, await factsOf(c));
      if (!cond.pass) {
        await skipForCondition(c, t.key, "task", t.title, cond.reason);
        return "done";
      }
    }
    await startTask(c, t, row);
    return "open";
  }
  if (row.state === "done" || row.state === "skipped" || row.state === "cancelled") return "done";
  if (row.state === "failed") return (row.result?.on_cant_do ?? t.on_cant_do) === "continue" ? "done" : "stop";
  const team = (row.result?.team_name as string | undefined) ?? null;

  if (row.result?.outcome === "cant_do") {
    const note = String(row.result?.note ?? "");
    await setStep(c.client, row, "failed", c.now, {}, c.rows);
    await sysMsg(c.client, c.ticket.id, `${team ?? "The team"} couldn't do it: ${t.title}. "${note.replace(/\s+/g, " ").slice(0, 500)}"`, "internal");
    if ((t.on_cant_do ?? "stop") === "continue") {
      await sysMsg(c.client, c.ticket.id, `Carrying on without it: ${t.title}.`);
      return "done";
    }
    return "stop";
  }

  let child: { status: string; number: number; assignee_id: number | null; assignee_name: string | null } | undefined;
  if (row.task_ticket_id) {
    child = await hqOne(
      `SELECT t.status, t.number, t.assignee_id, coalesce(nullif(u.name, ''), u.username) AS assignee_name
         FROM hd_tickets t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = $1`,
      [row.task_ticket_id],
      c.client
    );
  }
  // Finished: an outcome recorded, or its ticket solved or closed (a task
  // ticket deleted by an admin counts too: nothing is left to wait for).
  if (row.result?.outcome !== "done" && child && !DONE_TICKET.has(child.status)) return "open";
  const deleted = row.result?.outcome !== "done" && !child;
  const done = await setStep(
    c.client,
    row,
    "done",
    c.now,
    {
      outcome: "done",
      solved_by: (row.result?.solved_by as string | undefined) ?? child?.assignee_name ?? null,
      solved_by_id: (row.result?.solved_by_id as number | undefined) ?? child?.assignee_id ?? null,
      ticket_number: child?.number ?? null,
      ...(deleted ? { ticket_deleted: true } : {}),
    },
    c.rows
  );
  if (deleted) {
    await sysMsg(c.client, c.ticket.id, `The task ticket for "${t.title}" was deleted, so the workflow carries on without it.`, "internal");
    await sysMsg(c.client, c.ticket.id, `Finished: ${t.title}.`);
  } else await sysMsg(c.client, c.ticket.id, `${team ? `${team} finished` : "Finished"}: ${t.title}.`);
  const lines = handoffLines(t.outputs, done);
  if (lines.length) await sysMsg(c.client, c.ticket.id, `Hand-off from ${team ?? "the team"}: ${t.title}\n\n${lines.join("\n")}`);
  return "done";
}

/** "Can't be done" with on_cant_do stop: the run waits for the coordinating team. */
async function blockRun(c: Ctx, t: HdTaskStepDefB): Promise<void> {
  const row = c.rows.get(t.key)!;
  const note = String(row.result?.note ?? "");
  const coordTeam = c.ticket.rt_team_id ?? c.ticket.team_id;
  const coordName = await teamName(c.client, coordTeam);
  const blocked: Blocked = { step_key: t.key, title: t.title, note, at: c.now.toISOString() };
  c.state = "blocked";
  await c.client.query(
    `UPDATE hd_workflow_runs SET state = 'blocked', current = current || jsonb_build_object('index', $2::int, 'blocked', $3::jsonb) WHERE id = $1`,
    [c.run.id, c.cursor.index, JSON.stringify(blocked)]
  );
  // Back to the coordinating team, open.
  await c.client.query(
    `UPDATE hd_tickets SET team_id = coalesce($2, team_id), status = CASE WHEN status = 'new' THEN 'open' ELSE status END, updated_at = now()
      WHERE id = $1 AND status NOT IN ('solved', 'closed')`,
    [c.ticket.id, coordTeam]
  );
  await sysMsg(
    c.client,
    c.ticket.id,
    `The workflow is on hold: ${(row.result?.team_name as string | undefined) ?? "a team"} couldn't do "${t.title}". ${coordName ?? "The coordinating team"} decides: try the step again, skip it or stop the workflow.`,
    "internal"
  );
  const number = c.ticket.number;
  const ticketTeam = coordTeam;
  const title = t.title;
  c.effects.push(() => notifyBlocked(number, ticketTeam, title, note));
}

/** Tell the coordinating team's leads (its members when it has none) that a run is blocked. */
async function notifyBlocked(number: number, teamId: number | null, title: string, note: string): Promise<void> {
  if (!teamId) return;
  let ids = await teamLeadIds(teamId);
  if (!ids.length) {
    ids = (
      await hq<{ user_id: number }>(
        "SELECT m.user_id FROM hd_team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active' WHERE m.team_id = $1",
        [teamId]
      )
    ).map((r) => r.user_id);
  }
  const { deliverAgentNotification } = await import("./notify-prefs");
  for (const id of ids) {
    await deliverAgentNotification(id, "workflow_blocked", {
      ticketNumber: number,
      title: `Workflow on hold on #${number}: ${title}`,
      body: note.slice(0, 300),
      url: `/desk/tickets/${number}`,
      teamId,
    });
  }
}

// --- Wait, notify, finish --------------------------------------------------------------

async function evalWait(c: Ctx, s: HdWaitStepDef): Promise<"advance" | "waiting"> {
  let row = c.rows.get(s.key);
  if (!row) {
    const until = waitUntil(s.until, c.ticket.form_answers ?? {}, c.now);
    row = await insertStep(c, s.key, "wait", "active", { title: s.title }, { wait_until: until });
    if (until > c.now) await sysMsg(c.client, c.ticket.id, `Waiting until ${dayText(until)}: ${s.title}.`);
  }
  if (row.state !== "active") return "advance";
  if (row.wait_until && new Date(row.wait_until) > c.now) return "waiting";
  await setStep(c.client, row, "done", c.now, {}, c.rows);
  return "advance";
}

async function recipientsOf(c: Ctx, s: HdNotifyStepDef): Promise<"requester" | number[]> {
  if (s.to === "requester") return "requester";
  if ("user_id" in s.to) return [s.to.user_id];
  const rows = await hq<{ user_id: number }>(
    `SELECT m.user_id FROM hd_team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active'
      WHERE m.team_id = $1 ORDER BY m.user_id`,
    [s.to.team_id],
    c.client
  );
  return rows.map((r) => r.user_id);
}

async function evalNotify(c: Ctx, s: HdNotifyStepDef): Promise<void> {
  if (c.rows.get(s.key)) return;
  const to = await recipientsOf(c, s);
  const parts = await templateParts(c);
  const message = renderTemplate(s.message, parts.vars, parts.answers, parts.outputs);
  await insertStep(c, s.key, "notify", "done", { title: s.title, to: to === "requester" ? "requester" : to.length });
  const ticketId = c.ticket.id;
  const title = s.title;
  c.effects.push(async () => (await notifyMod()).notifyWorkflowMessage(ticketId, to, title, message, { actorName: SYSTEM_AUTHOR }));
}

async function evalFinish(c: Ctx, s: HdWorkflowStepB & { kind: "finish" }): Promise<void> {
  if (!c.rows.get(s.key)) await insertStep(c, s.key, "finish", "done", { title: s.title });
  // "Request access": read on the space, only for a "Request access" run
  // whose space-owner approvals were asked about this same space, and only
  // when every approval of the run was approved (runMayGrantSpace).
  const spaceId = requestedSpaceId(c.ticket);
  let grant: SpaceGrant | null = null;
  if (spaceId && c.ticket.requester_id && c.ticket.request_type_id) {
    if (await runMayGrantSpace(c.client, c.run.id, c.cursor.definition, spaceId)) {
      grant = await grantReadInTx(c.client, spaceId, c.ticket.requester_id);
      if (grant) await sysMsg(c.client, c.ticket.id, `Access granted: ${c.ticket.requester_name || "the requester"} can now read ${grant.space_name}.`);
    } else {
      await sysMsg(c.client, c.ticket.id, "No access was granted: the space's owner did not approve access to this space.", "internal");
    }
  }
  const solved = await solveRequest(c);
  if (solved) await sysMsg(c.client, c.ticket.id, `Solved by the workflow: ${s.title}.`);
  await endRun(c, "done");
  const ticketId = c.ticket.id;
  const csat = s.csat !== false;
  const actor = c.actor;
  if (grant) {
    const g = grant;
    const info = { actor, ticketNumber: c.ticket.number, ticketId, requesterName: c.ticket.requester_name };
    c.effects.push(() => afterGrant(g, info));
  }
  if (solved) c.effects.push(async () => (await notifyMod()).notifySolvedCsat(ticketId, { csat, actorName: SYSTEM_AUTHOR }));
}

// --- The loop ------------------------------------------------------------------------

async function drive(c: Ctx): Promise<void> {
  const steps = c.cursor.definition.steps;
  for (let guard = 0; guard < 500; guard++) {
    if (!OPEN_STATES.includes(c.state)) return;
    if (c.cursor.index >= steps.length) {
      await sysMsg(c.client, c.ticket.id, `The ${c.cursor.workflow_title} workflow has finished.`);
      await endRun(c, "done");
      return;
    }
    const s = steps[c.cursor.index];
    // A step not started yet runs only when its condition holds (a task's is checked in evalTask).
    if (s.kind !== "task" && s.when && !c.rows.has(s.key)) {
      const cond = evaluateWhen(s.when, await factsOf(c));
      if (!cond.pass) {
        await skipForCondition(c, s.key, s.kind === "parallel" ? "parallel" : s.kind, s.kind === "parallel" ? s.title || "At the same time" : s.title, cond.reason);
        c.cursor.index++;
        continue;
      }
    }
    const marker = c.rows.get(s.key);
    if (marker && marker.state === "skipped") {
      c.cursor.index++;
      continue;
    }
    let next: "advance" | "blocked" | "waiting" | "ended" | "stop";
    switch (s.kind) {
      case "approval":
        next = await evalApproval(c, s);
        break;
      case "task": {
        const st = await evalTask(c, s);
        next = st === "done" ? "advance" : st === "stop" ? "stop" : "blocked";
        break;
      }
      case "parallel": {
        // Every task starts (or is checked) before the group decides; one
        // stopped task blocks the run while the others carry on.
        const states: TaskState[] = [];
        let stopped: HdTaskStepDefB | null = null;
        for (const t of s.steps) {
          const st = await evalTask(c, t);
          states.push(st);
          if (st === "stop" && !stopped) stopped = t;
        }
        if (stopped) {
          await blockRun(c, stopped);
          return;
        }
        next = states.every((x) => x === "done") ? "advance" : "blocked";
        break;
      }
      case "wait":
        next = await evalWait(c, s);
        break;
      case "notify":
        await evalNotify(c, s);
        next = "advance";
        break;
      case "finish":
        await evalFinish(c, s);
        next = "ended";
        break;
      default:
        next = "advance";
    }
    if (next === "ended") return;
    if (next === "stop") {
      await blockRun(c, s as HdTaskStepDefB);
      return;
    }
    if (next === "advance") {
      c.cursor.index++;
      continue;
    }
    const state: RunState = next === "waiting" ? "waiting" : "running";
    c.state = state;
    await c.client.query(
      `UPDATE hd_workflow_runs SET state = $2, current = (current - 'blocked') || jsonb_build_object('index', $3::int) WHERE id = $1`,
      [c.run.id, state, c.cursor.index]
    );
    return;
  }
  throw new Error(`workflow run ${c.run.id} did not settle`);
}

export interface AdvanceOptions {
  /** The clock (tests; the sweep passes its own). */
  now?: Date;
  /** Who caused this advance (an approver's decision), for the audit of what follows (a space grant). */
  actor?: AuditActor | null;
  /**
   * Runs first, under the run's lock, in the same transaction; throw an
   * EngineRefusal to refuse (nothing is written). It may queue effects,
   * and may move a blocked run back to running (set run.state).
   */
  mutate?: (client: PoolClient, run: Run, effects: Effect[]) => Promise<void>;
}

/**
 * Move a run as far as it can go now, idempotently: calling it twice, or
 * from two places at once, starts nothing twice. Returns the run's state
 * afterwards (undefined when the run is gone).
 */
export async function advanceRun(runId: number, opts: AdvanceOptions = {}): Promise<RunState | undefined> {
  const effects: Effect[] = [];
  const state = await withTx(async (client) => {
    const run = await hqOne<Run>("SELECT * FROM hd_workflow_runs WHERE id = $1 FOR UPDATE", [runId], client);
    if (!run) {
      if (opts.mutate) throw new EngineRefusal(404, "Not found.");
      return undefined;
    }
    if (opts.mutate) await opts.mutate(client, run, effects);
    if (!OPEN_STATES.includes(run.state)) return run.state;
    const ticket = await loadTicket(client, run.ticket_id);
    if (!ticket) return run.state;
    const rows = await hq<Row>("SELECT * FROM hd_workflow_steps WHERE run_id = $1", [run.id], client);
    const c: Ctx = {
      client,
      run,
      cursor: cursorOf(run),
      ticket,
      rows: new Map(rows.map((r) => [r.step_key, r])),
      effects,
      now: opts.now ?? new Date(),
      actor: opts.actor ?? null,
      state: run.state,
    };
    await drive(c);
    return c.state;
  });
  await runEffects(effects);
  return state;
}

// --- Entry points ----------------------------------------------------------------------

/**
 * Start the workflow of a new request, when its type links a published
 * workflow (hd_request_types.workflow_id; else a published workflow whose
 * trigger names the type). No-op for a request that has a run already, a
 * workflow task ticket, or a type without one. Call after the request's
 * insert has committed (lib/helpdesk/events afterTicketCreated does).
 */
export async function startWorkflowForRequest(ticketId: number, opts: { now?: Date } = {}): Promise<{ run_id: number } | null> {
  const runId = await withTx(async (client) => {
    const t = await hqOne<{ id: number; request_type_id: number | null; parent_ticket_id: number | null; workflow_run_id: number | null; source: string; status: string }>(
      "SELECT id, request_type_id, parent_ticket_id, workflow_run_id, source, status FROM hd_tickets WHERE id = $1 FOR UPDATE",
      [ticketId],
      client
    );
    if (!t || !t.request_type_id || t.parent_ticket_id || t.workflow_run_id || t.source === "workflow" || DONE_TICKET.has(t.status)) return null;
    if (await hqOne("SELECT 1 FROM hd_workflow_runs WHERE ticket_id = $1", [ticketId], client)) return null;
    const w = await hqOne<{ id: number; title: string; version: number; definition: HdWorkflowDefinitionB }>(
      `SELECT w.id, w.title, w.version, w.definition FROM hd_workflows w
        WHERE w.published = 1
          AND (w.id = (SELECT rt.workflow_id FROM hd_request_types rt WHERE rt.id = $1)
               OR ((SELECT rt.workflow_id FROM hd_request_types rt WHERE rt.id = $1) IS NULL
                   AND (w.definition->'trigger'->>'request_type_id')::int = $1))
        ORDER BY w.id LIMIT 1`,
      [t.request_type_id],
      client
    );
    if (!w || !Array.isArray(w.definition?.steps) || w.definition.steps.length === 0) return null;
    const cursor: Cursor = { definition: w.definition, index: 0, workflow_title: w.title };
    const run = await hqOne<{ id: number }>(
      `INSERT INTO hd_workflow_runs (workflow_id, workflow_version, ticket_id, state, current, started_at)
       VALUES ($1, $2, $3, 'running', $4::jsonb, $5) RETURNING id`,
      [w.id, w.version, ticketId, JSON.stringify(cursor), opts.now ?? new Date()],
      client
    );
    await client.query("UPDATE hd_tickets SET workflow_run_id = $2 WHERE id = $1", [ticketId, run!.id]);
    return run!.id;
  });
  if (!runId) return null;
  await advanceRun(runId, { now: opts.now });
  return { run_id: runId };
}

/**
 * A ticket was solved or closed (lib/helpdesk/events afterTicketSolved).
 * A workflow task's ticket: its step completes and the run moves on. A
 * request whose run is still going (or blocked): the run stops
 * (cancelled), since someone finished it by hand. Anything else: nothing.
 */
export async function onTicketSolved(ticketId: number, opts: { now?: Date } = {}): Promise<void> {
  const t = await hqOne<{ status: string }>("SELECT status FROM hd_tickets WHERE id = $1", [ticketId]);
  if (!t || !DONE_TICKET.has(t.status)) return;
  const steps = await hq<{ run_id: number }>(
    `SELECT DISTINCT s.run_id FROM hd_workflow_steps s JOIN hd_workflow_runs r ON r.id = s.run_id
      WHERE s.task_ticket_id = $1 AND s.state = 'active' AND r.state IN ('running', 'waiting')`,
    [ticketId]
  );
  for (const s of steps) await advanceRun(s.run_id, { now: opts.now });
  const own = await hq<{ id: number }>("SELECT id FROM hd_workflow_runs WHERE ticket_id = $1 AND state IN ('running', 'waiting', 'blocked')", [ticketId]);
  for (const r of own) await cancelRun(r.id, { reason: "solved", now: opts.now });
}

/**
 * A workflow task's ticket was deleted (the DELETE route, after the
 * delete): its step's task_ticket_id is now NULL, so the run is found from
 * the deleted ticket's source_ref.run_id and moved on (evalTask counts a
 * deleted task ticket as finished). The sweep catches any it misses.
 */
export async function onTaskTicketDeleted(sourceRef: Record<string, unknown> | null | undefined, opts: { now?: Date } = {}): Promise<void> {
  const runId = Number(sourceRef?.run_id);
  if (!Number.isInteger(runId) || runId <= 0) return;
  const run = await hqOne<{ state: RunState }>("SELECT state FROM hd_workflow_runs WHERE id = $1", [runId]);
  if (!run || !OPEN_STATES.includes(run.state)) return;
  await advanceRun(runId, { now: opts.now });
}

/**
 * Stop a run (running, waiting or blocked): open steps cancelled, pending
 * approvals cancelled, a system message on the request. Task tickets
 * already created stay with their teams (an agent closes them if the work
 * is no longer wanted).
 */
export async function cancelRun(
  runId: number,
  opts: { reason?: "solved" | "cancelled"; now?: Date; actorName?: string; note?: string } = {}
): Promise<boolean> {
  const now = opts.now ?? new Date();
  return withTx(async (client) => {
    const run = await hqOne<Run>("SELECT * FROM hd_workflow_runs WHERE id = $1 FOR UPDATE", [runId], client);
    if (!run || !LIVE_STATES.includes(run.state)) return false;
    await client.query(`UPDATE hd_workflow_steps SET state = 'cancelled', finished_at = $2 WHERE run_id = $1 AND state IN ('pending', 'active')`, [runId, now]);
    await client.query(`UPDATE hd_approvals SET decision = 'cancelled' WHERE run_id = $1 AND decision = 'pending'`, [runId]);
    await client.query(`UPDATE hd_workflow_runs SET state = 'cancelled', finished_at = $2, current = current - 'blocked' WHERE id = $1`, [runId, now]);
    const title = cursorOf(run).workflow_title;
    const by = opts.actorName ? ` by ${opts.actorName}` : "";
    const note = opts.note ? ` "${opts.note.replace(/\s+/g, " ").slice(0, 500)}"` : "";
    await sysMsg(
      client,
      run.ticket_id,
      opts.reason === "solved" ? `The ${title} workflow stopped because the request was solved.` : `The ${title} workflow was stopped${by}.${note}`
    );
    return true;
  });
}

/** The approval decision, applied under the run's lock (lib/helpdesk/approvals decideApproval calls this). */
export async function decide(
  approvalId: number,
  user: { id: number; name: string; username: string; role?: string },
  decision: "approved" | "declined",
  note: string,
  mayDecide: (client: PoolClient) => Promise<boolean>,
  opts: { now?: Date } = {}
): Promise<{ ok: true; run_state: RunState } | { ok: false; status: 400 | 404 | 409; error: string }> {
  const a = await hqOne<{ run_id: number }>("SELECT run_id FROM hd_approvals WHERE id = $1", [approvalId]);
  if (!a) return { ok: false, status: 404, error: "Not found." };
  const name = user.name || user.username;
  const actor: AuditActor = { id: user.id, name, role: user.role ?? null };
  let final: RunState | undefined;
  let number = 0;
  let stepTitle = "";
  try {
    final = await advanceRun(a.run_id, {
      now: opts.now,
      actor,
      mutate: async (client, run, effects) => {
        const row = await hqOne<{ id: number; decision: string; ticket_id: number; title: string | null; number: number }>(
          `SELECT a.id, a.decision, a.ticket_id, s.result->>'title' AS title, t.number
             FROM hd_approvals a JOIN hd_workflow_steps s ON s.id = a.step_id JOIN hd_tickets t ON t.id = a.ticket_id
            WHERE a.id = $1 FOR UPDATE OF a`,
          [approvalId],
          client
        );
        if (!row) throw new EngineRefusal(404, "Not found.");
        if (row.decision !== "pending" || !OPEN_STATES.includes(run.state) || !(await mayDecide(client))) {
          throw new EngineRefusal(409, "This approval has already been decided.");
        }
        number = row.number;
        stepTitle = row.title ?? "Approval";
        await client.query(`UPDATE hd_approvals SET decision = $2, note = $3, decided_by = $4, decided_by_name = $5, decided_at = $6 WHERE id = $1`, [
          approvalId,
          decision,
          note,
          user.id,
          name,
          opts.now ?? new Date(),
        ]);
        const quoted = note ? ` "${note.replace(/\s+/g, " ").slice(0, 500)}"` : "";
        await sysMsg(client, row.ticket_id, `${name} ${decision === "approved" ? "approved" : "declined"}: ${stepTitle}.${quoted}`);
        effects.push(async () => {
          // Effects run after the commit but before advanceRun returns, so
          // the state the run reached is read back here (not `final`, which
          // is still unset while effects run).
          const reached = (await hqOne<{ state: RunState }>("SELECT state FROM hd_workflow_runs WHERE id = $1", [run.id]))?.state;
          const nextLine =
            reached === "declined"
              ? "Your request has been closed."
              : reached === "done"
                ? "Your request is complete."
                : decision === "approved"
                  ? "We'll carry on with your request."
                  : "Your request carries on to the next step.";
          await (await notifyMod()).notifyApprovalDecided(approvalId, { actorId: user.id, actorName: name, nextLine });
        });
        effects.push(() =>
          audit({
            actor,
            action: decision === "approved" ? "helpdesk.approval.approved" : "helpdesk.approval.declined",
            targetType: "helpdesk_ticket",
            targetId: number,
            targetLabel: `#${number}`,
            details: { approval_id: approvalId, step: stepTitle, note: note.slice(0, 500), run_id: run.id },
          })
        );
      },
    });
  } catch (e) {
    if (e instanceof EngineRefusal) return { ok: false, status: e.status === 400 ? 409 : e.status, error: e.message };
    throw e;
  }
  return { ok: true, run_state: final ?? "running" };
}

// --- Task outcomes, hand-offs, transfers ----------------------------------------------

interface TaskRowRef {
  id: number;
  run_id: number;
  step_key: string;
  state: StepState;
  result: Record<string, unknown>;
  current: Record<string, unknown>;
  run_state: RunState;
}

async function taskRowFor(childTicketId: number, client?: PoolClient, lock = false): Promise<TaskRowRef | undefined> {
  return hqOne<TaskRowRef>(
    `SELECT s.id, s.run_id, s.step_key, s.state, s.result, r.current, r.state AS run_state
       FROM hd_workflow_steps s JOIN hd_workflow_runs r ON r.id = s.run_id
      WHERE s.task_ticket_id = $1 ORDER BY s.id DESC LIMIT 1 ${lock ? "FOR UPDATE OF s" : ""}`,
    [childTicketId],
    client
  );
}

/** Keys of a task's hand-off fields with their labels, in the definition's order (the 409/400 `missing`). */
function labelled(defs: HdTaskOutputDef[] | undefined, keys: string[]): HdMissingOutput[] {
  const known = (defs ?? []).filter((d) => keys.includes(d.key)).map((d) => ({ key: d.key, label: d.label || d.key }));
  return [...known, ...keys.filter((k) => !known.some((d) => d.key === k)).map((k) => ({ key: k, label: k }))];
}

/** A refusal's `missing` (labelled) and `missing_keys` (keys only, the earlier contract). */
export type TaskMissing = { missing: HdMissingOutput[]; missing_keys: string[] };

/**
 * May this task ticket be solved by a plain status change? Null when yes
 * (not a task, already finished, or nothing required); otherwise the
 * required hand-off fields still missing, labelled (the desk opens the
 * outcome form with them marked).
 */
export async function validateTaskSolve(ticketId: number, client?: PoolClient): Promise<null | ({ error: string } & TaskMissing)> {
  const ref = await taskRowFor(ticketId, client);
  if (!ref || ref.state !== "active" || ref.result?.outcome) return null;
  const def = taskDef(cursorOf({ current: ref.current }).definition, ref.step_key);
  const required = (def?.outputs ?? []).filter((o) => o.required);
  if (!required.length) return null;
  const have = (ref.result?.outputs ?? {}) as Record<string, unknown>;
  const missing = required.filter((o) => have[o.key] === undefined || have[o.key] === null || have[o.key] === "");
  if (!missing.length) return null;
  return {
    error: `Record the hand-off before solving: ${missing.map((o) => o.label).join(", ")}.`,
    missing: missing.map((o) => ({ key: o.key, label: o.label || o.key })),
    missing_keys: missing.map((o) => o.key),
  };
}

export type TaskOutcomeResult =
  | { ok: true; run_state: RunState; step_state: StepState }
  | ({ ok: false; status: 400 | 404 | 409; error: string } & Partial<TaskMissing>);

/**
 * A task team records how its task went: done (with the task's hand-off
 * outputs and an optional note) or can't be done (a note is required).
 * Recorded under the run's lock, then the run moves on (or blocks); the
 * task ticket is solved afterwards, through the core, with the outcome on
 * it. The caller checks the person may work the task ticket.
 */
export async function recordTaskOutcome(
  user: { id: number; name: string; username: string },
  childTicketId: number,
  input: HdTaskOutcomeInput | Record<string, unknown>,
  opts: { now?: Date } = {}
): Promise<TaskOutcomeResult> {
  const ref = await taskRowFor(childTicketId);
  if (!ref) return { ok: false, status: 404, error: "This ticket is not a workflow task." };
  const raw = input as Record<string, unknown>;
  const outcome = raw.outcome;
  if (outcome !== "done" && outcome !== "cant_do") return { ok: false, status: 400, error: "Say whether it's done or can't be done." };
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== "string") return { ok: false, status: 400, error: "The note is text." };
  if (note.length > TASK_NOTE_MAX) return { ok: false, status: 400, error: `The note is longer than ${TASK_NOTE_MAX} characters.` };
  if (outcome === "cant_do" && !note) return { ok: false, status: 400, error: "Say why it can't be done: the coordinating team reads it." };
  const handoffNote = typeof raw.handoff_note === "string" ? raw.handoff_note.trim() : "";
  if (handoffNote.length > TASK_NOTE_MAX) return { ok: false, status: 400, error: `The hand-off note is longer than ${TASK_NOTE_MAX} characters.` };
  const def = taskDef(cursorOf({ current: ref.current }).definition, ref.step_key);
  const outputs = validateOutputs(def?.outputs ?? [], raw.outputs, outcome === "done");
  if (!outputs.ok) {
    const keys = outputs.missing ?? [];
    return { ok: false, status: 400, error: outputs.error, ...(keys.length ? { missing: labelled(def?.outputs, keys), missing_keys: keys } : {}) };
  }

  const name = user.name || user.username;
  const now = opts.now ?? new Date();
  let stepState: StepState = "active";
  let childNumber = 0;
  let final: RunState | undefined;
  try {
    final = await advanceRun(ref.run_id, {
      now,
      mutate: async (client, run) => {
        const row = await taskRowFor(childTicketId, client, true);
        if (!row || row.state !== "active" || row.result?.outcome) throw new EngineRefusal(409, "This task is already finished.");
        if (!LIVE_STATES.includes(run.state)) throw new EngineRefusal(409, "The workflow has ended.");
        await client.query(`UPDATE hd_workflow_steps SET result = result || $2::jsonb WHERE id = $1`, [
          row.id,
          JSON.stringify({
            outcome,
            note,
            outputs: outputs.value,
            handoff_note: handoffNote,
            solved_by: name,
            solved_by_id: user.id,
            outcome_at: now.toISOString(),
          }),
        ]);
        const t = await hqOne<{ number: number }>("SELECT number FROM hd_tickets WHERE id = $1", [childTicketId], client);
        childNumber = t?.number ?? 0;
        const lines = handoffLines(def?.outputs, { result: { outputs: outputs.value, handoff_note: handoffNote } } as unknown as Row);
        const body =
          outcome === "done"
            ? `${name} recorded the outcome: done.${note ? ` "${note.replace(/\s+/g, " ").slice(0, 500)}"` : ""}${lines.length ? `\n\n${lines.join("\n")}` : ""}`
            : `${name} recorded the outcome: can't be done. "${note.replace(/\s+/g, " ").slice(0, 500)}"`;
        await sysMsg(client, childTicketId, body, "internal");
      },
    });
  } catch (e) {
    if (e instanceof EngineRefusal)
      return { ok: false, status: e.status, error: e.message, ...(e.missing?.length ? { missing: labelled(def?.outputs, e.missing), missing_keys: e.missing } : {}) };
    throw e;
  }
  const after = await hqOne<{ state: StepState }>("SELECT state FROM hd_workflow_steps WHERE id = $1", [ref.id]);
  stepState = after?.state ?? stepState;
  // The task ticket closes as solved, through the core (its hooks; the
  // engine's own onTicketSolved finds the step finished and does nothing).
  const child = await hqOne<{ status: string }>("SELECT status FROM hd_tickets WHERE id = $1", [childTicketId]);
  if (child && !DONE_TICKET.has(child.status)) {
    try {
      await updateTicket(childTicketId, { status: "solved" }, { id: user.id, name }, { actorId: user.id, actorName: name, silent: true });
    } catch (e) {
      logEvent("error", "helpdesk.task_solve_failed", { ticket: childNumber, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok: true, run_state: final ?? ref.run_state, step_state: stepState };
}

/**
 * A task ticket moved team (lib/helpdesk/tickets after commit): the step
 * follows it (team_id, team_name, a transfers entry for time per team,
 * with who moved it and their note when known) and the request says so.
 */
export async function onTaskTransferred(
  childTicketId: number,
  fromTeamId: number | null,
  toTeamId: number | null,
  opts: { now?: Date; actor?: { id: number | null; name: string } | null; note?: string } = {}
): Promise<void> {
  if (fromTeamId === toTeamId) return;
  const ref = await taskRowFor(childTicketId);
  if (!ref || ref.state !== "active") return;
  const now = opts.now ?? new Date();
  await withTx(async (client) => {
    const run = await hqOne<{ ticket_id: number }>("SELECT ticket_id FROM hd_workflow_runs WHERE id = $1 FOR UPDATE", [ref.run_id], client);
    const row = await taskRowFor(childTicketId, client, true);
    if (!run || !row || row.state !== "active") return;
    const [fromName, toName] = await Promise.all([teamName(client, fromTeamId), teamName(client, toTeamId)]);
    const transfer: HdTaskTransfer = { from_team_id: fromTeamId, from_team_name: fromName, to_team_id: toTeamId, to_team_name: toName, at: now.toISOString() };
    const actor = opts.actor && (opts.actor.id || opts.actor.name) ? opts.actor : null;
    if (actor) {
      transfer.actor_id = actor.id ?? null;
      transfer.actor_name = actor.name || (actor.id ? await userName(client, actor.id) : null);
    }
    const note = (opts.note ?? "").trim().slice(0, TASK_NOTE_MAX);
    if (note) transfer.note = note;
    const transfers = [...((row.result?.transfers as HdTaskTransfer[] | undefined) ?? []), transfer].slice(-50);
    await client.query(`UPDATE hd_workflow_steps SET result = result || $2::jsonb WHERE id = $1`, [
      row.id,
      JSON.stringify({ team_id: toTeamId, team_name: toName, transfers }),
    ]);
    const title = String(row.result?.title ?? row.step_key);
    // A system line (the requester reads it): who moved it and why stay in the agents' transfers record.
    await sysMsg(client, run.ticket_id, `Task moved from ${fromName ?? "no team"} to ${toName ?? "no team"}: ${title}.`);
  });
}

export type CoordinatorResult = { ok: true; run_state: RunState } | { ok: false; status: 400 | 404 | 409; error: string };

/** The blocked run's failed step (the given key, else the one that blocked it). */
async function failedRowFor(client: PoolClient, run: Run, stepKey?: string): Promise<Row> {
  const key = stepKey ?? cursorOf(run).blocked?.step_key;
  if (!key) throw new EngineRefusal(409, "This workflow is not on hold.");
  const row = await hqOne<Row>("SELECT * FROM hd_workflow_steps WHERE run_id = $1 AND step_key = $2 FOR UPDATE", [run.id, key], client);
  if (!row || row.state !== "failed") throw new EngineRefusal(409, "That step has not failed.");
  return row;
}

async function coordinate(runId: number, apply: (client: PoolClient, run: Run) => Promise<void>, now?: Date): Promise<CoordinatorResult> {
  try {
    const state = await advanceRun(runId, {
      now,
      mutate: async (client, run) => {
        if (run.state !== "blocked") throw new EngineRefusal(409, "This workflow is not on hold.");
        await apply(client, run);
        await client.query(`UPDATE hd_workflow_runs SET state = 'running', current = current - 'blocked' WHERE id = $1`, [run.id]);
        run.state = "running";
        run.current = { ...(run.current ?? {}), blocked: null };
      },
    });
    if (state === undefined) return { ok: false, status: 404, error: "Not found." };
    return { ok: true, run_state: state };
  } catch (e) {
    if (e instanceof EngineRefusal) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
}

/** Coordinator: try the failed task again (a new task ticket for the same team). */
export async function retryStep(user: { id: number; name: string; username: string }, runId: number, stepKey?: string, opts: { now?: Date } = {}): Promise<CoordinatorResult> {
  const name = user.name || user.username;
  return coordinate(
    runId,
    async (client, run) => {
      const row = await failedRowFor(client, run, stepKey);
      const log = [
        ...((row.result?.attempt_log as unknown[] | undefined) ?? []),
        { ticket_id: row.task_ticket_id, note: row.result?.note ?? "", by: row.result?.solved_by ?? null, at: row.finished_at, team_id: row.result?.team_id ?? null },
      ].slice(-20);
      await client.query(
        `UPDATE hd_workflow_steps SET result = result || $2::jsonb WHERE id = $1`,
        [row.id, JSON.stringify({ needs_ticket: true, attempt_log: log, retried_by: name })]
      );
      await sysMsg(client, run.ticket_id, `${name} asked for "${String(row.result?.title ?? row.step_key)}" to be tried again.`, "internal");
    },
    opts.now
  );
}

/** Coordinator: carry on without the failed task. */
export async function skipStep(
  user: { id: number; name: string; username: string },
  runId: number,
  stepKey?: string,
  note = "",
  opts: { now?: Date } = {}
): Promise<CoordinatorResult> {
  const name = user.name || user.username;
  const clean = note.trim().slice(0, TASK_NOTE_MAX);
  return coordinate(
    runId,
    async (client, run) => {
      const row = await failedRowFor(client, run, stepKey);
      await client.query(`UPDATE hd_workflow_steps SET state = 'skipped', result = result || $2::jsonb WHERE id = $1`, [
        row.id,
        JSON.stringify({ skip_reason: clean || `Skipped by ${name}`, skipped_by: name }),
      ]);
      await sysMsg(client, run.ticket_id, `Skipped by ${name}: ${String(row.result?.title ?? row.step_key)}.${clean ? ` "${clean.replace(/\s+/g, " ")}"` : ""}`);
    },
    opts.now
  );
}

// --- The sweep -----------------------------------------------------------------------

export interface SweepResult {
  advanced: number;
  reminded: number;
  /** Approvals whose approver was deleted (or deactivated), moved to a stand-in. */
  reassigned?: number;
}

/** SQL over `a` (hd_approvals): a pending approval whose named team or person is gone (deleted, or no longer active). */
const ORPHANED_APPROVAL = `(
  a.decision = 'pending'
  AND ((a.approver_kind = 'team' AND a.approver_team_id IS NULL)
       OR (a.approver_kind = 'user' AND a.approver_user_id IS NULL)
       OR (a.approver_kind IN ('user', 'manager') AND a.approver_user_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.approver_user_id AND u.status = 'active'))))`;

/**
 * Approvals that wait for a team or person who no longer exists (an admin
 * deleted the team or the account, or deactivated it) would wait forever:
 * like a request with no manager, they go to the request type's team leads
 * (any member when it has none), else the helpdesk admins, with a system
 * note on the request saying so, and the stand-ins are notified. A
 * space-owner step whose owner went goes to whoever manages space access
 * (approver kind 'space'), so its grant still names the same space. Each
 * one under its run's lock, re-checked there.
 */
async function reassignOrphanedApprovals(only: number[] | null): Promise<number> {
  const rows = await hq<{ id: number; run_id: number }>(
    `SELECT a.id, a.run_id FROM hd_approvals a JOIN hd_workflow_runs r ON r.id = a.run_id AND r.state IN ('running', 'waiting')
      WHERE ${ORPHANED_APPROVAL} AND ($1::int[] IS NULL OR a.run_id = ANY($1::int[]))
      ORDER BY a.id LIMIT 200`,
    [only]
  );
  let n = 0;
  for (const row of rows) {
    try {
      const moved = await withTx(async (client) => {
        await client.query("SELECT 1 FROM hd_workflow_runs WHERE id = $1 FOR UPDATE", [row.run_id]);
        const a = await hqOne<{ id: number; ticket_id: number; step_id: number; title: string | null; space_id: string | null }>(
          `SELECT a.id, a.ticket_id, a.step_id, s.result->>'title' AS title, s.result->>'space_id' AS space_id
             FROM hd_approvals a JOIN hd_workflow_steps s ON s.id = a.step_id
            WHERE a.id = $1 AND ${ORPHANED_APPROVAL} FOR UPDATE OF a`,
          [row.id],
          client
        );
        if (!a) return false;
        const ticket = await loadTicket(client, a.ticket_id);
        if (!ticket) return false;
        const title = a.title ?? "Approval";
        let target: ApproverTarget;
        if (a.space_id) {
          target = { kind: "space", user_id: null, team_id: null, label: "the people who manage space access", note: "The space's owner is no longer an active account, so the people who manage space access will decide." };
        } else {
          target = await fallbackFor(client, ticket, "The approver for this step no longer exists");
        }
        await client.query(
          `UPDATE hd_approvals SET approver_kind = $2, approver_team_id = $3, approver_user_id = $4, reminded_at = NULL WHERE id = $1`,
          [a.id, target.kind, target.team_id, target.user_id]
        );
        await client.query(`UPDATE hd_workflow_steps SET result = result || $2::jsonb WHERE id = $1`, [a.step_id, JSON.stringify({ approver_label: target.label })]);
        // A space-owner step stays generic for the requester (who stands in is for agents).
        await sysMsg(client, a.ticket_id, `${title}: ${target.note ?? `${target.label} will decide.`}`, a.space_id ? "internal" : "system");
        return true;
      });
      if (moved) {
        n++;
        await (await notifyMod()).notifyApprovalNeeded(row.id, {});
      }
    } catch (e) {
      logEvent("error", "helpdesk.approval_reassign_failed", { approval_id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return n;
}

/** "2026-11-06T14:05": the minute a sweep claims (one instance per minute; the helpdesk tick is a minute). */
function bucketId(d: Date): string {
  return d.toISOString().slice(0, 16);
}

/**
 * The periodic step (src/lib/periodic.ts, helpdesk sweeps): waits whose
 * time has come move on, task steps whose ticket was solved without the
 * hook firing catch up, and approvals past their step's "remind after"
 * are reminded once. Licensed only. One instance per minute (a settings
 * claim, so no client is held across the work); each run is advanced
 * under its own lock and each reminder claimed by a conditional UPDATE, so
 * overlapping sweeps still do everything once. Blocked runs wait for their
 * coordinator.
 */
export async function sweepWorkflows(opts: { now?: Date; claim?: boolean; runIds?: number[] } = {}): Promise<SweepResult> {
  const result: SweepResult = { advanced: 0, reminded: 0 };
  if (!(await featureEnabled("helpdesk"))) return result;
  const now = opts.now ?? new Date();
  if (opts.claim !== false && !(await claimPeriod("hd_workflow_sweep", bucketId(now)))) return result;
  const only = opts.runIds ?? null;

  const due = await hq<{ run_id: number }>(
    `SELECT DISTINCT s.run_id FROM hd_workflow_steps s
       JOIN hd_workflow_runs r ON r.id = s.run_id AND r.state IN ('running', 'waiting')
       LEFT JOIN hd_tickets t ON t.id = s.task_ticket_id
      WHERE s.state = 'active' AND ($2::int[] IS NULL OR s.run_id = ANY($2::int[]))
        AND ((s.kind = 'wait' AND s.wait_until <= $1)
             OR (s.kind = 'task' AND (s.result ? 'outcome'
                                       OR (s.task_ticket_id IS NOT NULL AND t.status IN ('solved', 'closed'))
                                       -- Its ticket was deleted (task_ticket_id is ON DELETE SET NULL): nothing is left to wait for.
                                       OR (s.task_ticket_id IS NULL AND NOT (s.result ? 'needs_ticket')))))
      LIMIT 500`,
    [now, only]
  );
  for (const d of due) {
    try {
      await advanceRun(d.run_id, { now });
      result.advanced++;
    } catch (e) {
      logEvent("error", "helpdesk.workflow_sweep_failed", { run_id: d.run_id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  result.reassigned = await reassignOrphanedApprovals(only);

  const reminders = await hq<{ id: number }>(
    `UPDATE hd_approvals a SET reminded_at = $1
       FROM hd_workflow_steps s, hd_workflow_runs r
      WHERE s.id = a.step_id AND r.id = a.run_id
        AND a.decision = 'pending' AND a.reminded_at IS NULL AND r.state IN ('running', 'waiting')
        AND ($2::int[] IS NULL OR a.run_id = ANY($2::int[]))
        AND jsonb_typeof(s.result->'remind_after_hours') = 'number'
        AND a.created_at + make_interval(hours => (s.result->>'remind_after_hours')::int) <= $1
      RETURNING a.id`,
    [now, only]
  );
  const mod = reminders.length ? await notifyMod() : null;
  for (const r of reminders) {
    await mod!.notifyApprovalNeeded(r.id, { reminder: true });
    result.reminded++;
  }
  return result;
}

// --- Progress (the request page's tracker, the desk's side panel) ---------------------

interface ProgressApproval {
  step_id: number;
  decision: string;
  decided_by_name: string;
  decided_at: string | null;
  note: string;
}

interface ProgressTask {
  id: number;
  number: number;
  resolve_due: string | null;
  status: string;
  assignee_name: string | null;
}

/**
 * The tracker for a request: each step of the pinned definition with its
 * state, team, assignee, outcome and hand-off. For the requester
 * (`audience: "requester"`) task ticket numbers, assignees and the notes
 * of failed or skipped-by-hand steps are left out; who approved and their
 * note are the outcome, so both see them, and hand-offs appear on the
 * request anyway. Null when the request has no run.
 */
export async function getWorkflowProgress(ticketId: number, audience: "requester" | "agent" = "requester"): Promise<HdWorkflowProgressB | null> {
  const run = await hqOne<Run>(`SELECT r.* FROM hd_workflow_runs r WHERE r.ticket_id = $1 ORDER BY r.id DESC LIMIT 1`, [ticketId]);
  if (!run) return null;
  const cursor = cursorOf(run);
  const [rows, approvals, tasks] = await Promise.all([
    hq<Row>("SELECT * FROM hd_workflow_steps WHERE run_id = $1", [run.id]),
    hq<ProgressApproval>("SELECT step_id, decision, decided_by_name, decided_at, note FROM hd_approvals WHERE run_id = $1 ORDER BY id", [run.id]),
    hq<ProgressTask>(
      `SELECT t.id, t.number, t.resolve_due, t.status, coalesce(nullif(u.name, ''), u.username) AS assignee_name
         FROM hd_tickets t JOIN hd_workflow_steps s ON s.task_ticket_id = t.id LEFT JOIN users u ON u.id = t.assignee_id
        WHERE s.run_id = $1`,
      [run.id]
    ),
  ]);
  const byKey = new Map(rows.map((r) => [r.step_key, r]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const stopped = !LIVE_STATES.includes(run.state);
  const agent = audience === "agent";

  const line = (key: string, kind: HdRunStepKind, title: string, detail: (r: Row) => string): HdProgressStepB => {
    const r = byKey.get(key);
    const state: StepState = r ? r.state : stopped ? "skipped" : "pending";
    const out: HdProgressStepB = {
      key,
      kind,
      title,
      state,
      detail: r ? (r.state === "skipped" && r.result?.skip_reason ? `Skipped: ${r.result.skip_reason}` : detail(r)) : "",
      started_at: r?.started_at ?? null,
      finished_at: r?.finished_at ?? null,
    };
    if (r?.state === "skipped" && r.result?.skip_reason && (agent || !r.result?.skipped_by)) out.reason = String(r.result.skip_reason);
    if (r?.result?.skipped_by) {
      out.actor = String(r.result.skipped_by);
      out.acted_at = r.finished_at;
    } else if (r?.result?.solved_by && (r.state === "done" || r.state === "failed")) {
      out.actor = String(r.result.solved_by);
      out.acted_at = r.finished_at;
    }
    return out;
  };
  const taskLine = (t: HdTaskStepDefB): HdProgressStepB => {
    const r = byKey.get(t.key);
    const child = r?.task_ticket_id ? taskById.get(r.task_ticket_id) : undefined;
    const out = line(t.key, "task", t.title, (row) => {
      const team = (row.result?.team_name as string | undefined) ?? "";
      if (row.state === "done") return [team, row.result?.solved_by ? `done by ${row.result.solved_by}` : "done"].filter(Boolean).join(" · ");
      if (row.state === "failed") return [team, agent ? "can't be done" : "delayed"].filter(Boolean).join(" · ");
      if (row.state === "cancelled") return [team, "stopped"].filter(Boolean).join(" · ");
      const due = child?.resolve_due;
      return [team, due ? `due ${dayText(new Date(due))}` : ""].filter(Boolean).join(" · ");
    });
    if (!r) return out;
    out.team_id = (r.result?.team_id as number | null | undefined) ?? null;
    out.team_name = (r.result?.team_name as string | null | undefined) ?? null;
    out.outcome = (r.result?.outcome as "done" | "cant_do" | undefined) ?? null;
    const defs = t.outputs ?? [];
    const values = (r.result?.outputs ?? {}) as Record<string, HdOutputValue>;
    const outputs = defs.filter((d) => values[d.key] !== undefined && values[d.key] !== null && values[d.key] !== "").map((d) => ({ key: d.key, label: d.label, value: outputText(d, values[d.key]) }));
    if (outputs.length) out.outputs = outputs;
    if (r.result?.handoff_note) out.handoff_note = String(r.result.handoff_note);
    if (!out.reason && r.result?.route_reason) out.reason = `Routed: ${r.result.route_reason}`;
    if (agent) {
      out.task_ticket_number = child?.number ?? null;
      out.assignee_name = child?.assignee_name ?? null;
      if (r.result?.note) out.note = String(r.result.note);
      const transfers = (r.result?.transfers as HdTaskTransfer[] | undefined) ?? [];
      if (transfers.length) out.transfers = transfers;
    }
    return out;
  };

  const steps: HdProgressStepB[] = [];
  for (const s of cursor.definition.steps) {
    switch (s.kind) {
      case "approval": {
        const r = byKey.get(s.key);
        const decided = r ? approvals.find((x) => x.step_id === r.id && (x.decision === "approved" || x.decision === "declined")) : undefined;
        const l = line(s.key, "approval", s.title, (row) => {
          if (decided) return `${decided.decision === "approved" ? "Approved" : "Declined"} by ${decided.decided_by_name}${decided.note ? `: "${decided.note}"` : ""}`;
          if (row.state === "cancelled") return "Stopped";
          // A space-owner step: the requester reads the generic words, never the owner's name.
          const label = (!agent && (row.result?.approver_public_label as string | undefined)) || (row.result?.approver_label as string | undefined);
          return `Waiting for ${label ?? "approval"}`;
        });
        if (decided) {
          l.actor = decided.decided_by_name;
          l.acted_at = decided.decided_at;
        }
        steps.push(l);
        break;
      }
      case "task":
        steps.push(taskLine(s));
        break;
      case "parallel": {
        const marker = byKey.get(s.key);
        if (marker?.state === "skipped") {
          steps.push({ ...line(s.key, "task", s.title || "At the same time", () => ""), children: s.steps.map(taskLine) });
          break;
        }
        const children = s.steps.map(taskLine);
        const states = children.map((x) => x.state);
        const finished = (x: StepState) => x === "done" || x === "skipped";
        let state: StepState;
        if (states.every(finished)) state = "done";
        else if (states.some((x) => x === "failed") && run.state === "blocked") state = "failed";
        else if (states.some((x) => x === "active" || finished(x) || x === "failed")) state = stopped ? "cancelled" : "active";
        else state = stopped ? "skipped" : "pending";
        const done = states.filter(finished).length;
        steps.push({
          key: s.key,
          kind: "task",
          title: s.title || "At the same time",
          state,
          detail: state === "pending" || state === "skipped" ? "" : `${done} of ${children.length} done`,
          started_at: children.map((x) => x.started_at).filter((x): x is string => Boolean(x)).sort()[0] ?? null,
          finished_at: state === "done" ? (children.map((x) => x.finished_at).filter((x): x is string => Boolean(x)).sort().pop() ?? null) : null,
          children,
        });
        break;
      }
      case "wait":
        steps.push(line(s.key, "wait", s.title, (r) => (r.wait_until ? `Until ${dayText(new Date(r.wait_until))}` : "")));
        break;
      case "notify":
        steps.push(line(s.key, "notify", s.title, () => "Sent"));
        break;
      case "finish":
        steps.push(line(s.key, "finish", s.title, () => "Solved"));
        break;
    }
  }
  const blocked = run.state === "blocked" && cursor.blocked ? cursor.blocked : null;
  return {
    run_id: run.id,
    workflow_title: cursor.workflow_title,
    state: run.state,
    steps,
    blocked: blocked ? { ...blocked, note: agent ? blocked.note : "" } : null,
  };
}

/** Hand-offs recorded on a run, in step order (the request's "Hand-offs" and the task context). */
export async function getHandoffs(runId: number): Promise<HdHandoff[]> {
  const run = await hqOne<Run>("SELECT * FROM hd_workflow_runs WHERE id = $1", [runId]);
  if (!run) return [];
  const def = cursorOf(run).definition;
  const rows = await hq<Row>("SELECT * FROM hd_workflow_steps WHERE run_id = $1 AND kind = 'task' AND state = 'done' ORDER BY finished_at, id", [runId]);
  const out: HdHandoff[] = [];
  for (const r of rows) {
    const t = taskDef(def, r.step_key);
    const values = (r.result?.outputs ?? {}) as Record<string, HdOutputValue>;
    const outputs = (t?.outputs ?? [])
      .filter((d) => values[d.key] !== undefined && values[d.key] !== null && values[d.key] !== "")
      .map((d) => ({ key: d.key, label: d.label, value: outputText(d, values[d.key]) }));
    const note = String(r.result?.handoff_note ?? "");
    if (!outputs.length && !note) continue;
    out.push({ step_key: r.step_key, title: String(r.result?.title ?? t?.title ?? r.step_key), team_name: (r.result?.team_name as string | null) ?? null, outputs, note, at: r.finished_at });
  }
  return out;
}

/** The run of a request (latest), for callers that need its state. */
export async function getRunForTicket(ticketId: number): Promise<Run | undefined> {
  return hqOne<Run>("SELECT * FROM hd_workflow_runs WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [ticketId]);
}

/** A run by id with its request (the coordinator routes). */
export async function getRun(runId: number): Promise<(Run & { ticket_number: number }) | undefined> {
  return hqOne<Run & { ticket_number: number }>(
    "SELECT r.*, t.number AS ticket_number FROM hd_workflow_runs r JOIN hd_tickets t ON t.id = r.ticket_id WHERE r.id = $1",
    [runId]
  );
}
