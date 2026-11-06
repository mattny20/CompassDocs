// Helpdesk 1.19.0: the request as a task team reads it. An agent working
// one task of a workflow (or the request itself) sees, read-only, what the
// other teams of that run see: the requester, the form's answers, the
// public conversation, every step's progress (team, status, assignee,
// outcome, note), the hand-offs so far and the sibling tasks with their
// numbers (a link only when the viewer may work that ticket too). Opened
// from a task ticket it also carries that task's own step as the run
// PINNED it (current.definition, never a newer published version): its
// hand-off fields, what "Can't be done" does and the coordinating team;
// and who the viewer is to it (their teams with a task on it, whether they
// may work the request itself).
//
// Never in it: internal notes, replies still waiting for review, the
// request's internal fields. The access check is this file's own: the
// viewer must be able to work the request or any task ticket of its run
// (lib/helpdesk/access canWorkTicket, the desk's own rule).
//
// Server-only.

import "server-only";
import type { Role } from "../types";
import { canWorkTicket, memberTeamIds, requesterMessages } from "./access";
import { hq } from "./db-core";
import { requesterCard } from "./detail";
import { getHandoffs, getRunForTicket, getWorkflowProgress } from "./engine";
import { listMessages } from "./messages";
import { getTicketById, getTicketByNumber } from "./tickets";
import type { HdFormField, HdStatus, HdTaskStepDefB, HdTicket, HdWorkflowContext, HdWorkflowContextTask, HdWorkflowDefinitionB } from "./types";

interface TaskTicketRow {
  id: number;
  number: number;
  subject: string;
  status: HdStatus;
  requester_id: number | null;
  team_id: number | null;
  assignee_id: number | null;
  team_name: string | null;
  step_key: string | null;
}

/** The request a ticket belongs to: itself when it runs a workflow, its parent when it is a workflow task. */
async function requestOf(t: HdTicket): Promise<HdTicket | undefined> {
  if (t.parent_ticket_id && t.source === "workflow") return getTicketById(t.parent_ticket_id);
  return t;
}

/** A task step of a pinned definition by key (top level or in a parallel group). */
function pinnedTask(def: HdWorkflowDefinitionB | undefined, key: string): HdTaskStepDefB | undefined {
  for (const s of Array.isArray(def?.steps) ? def.steps : []) {
    if (s.kind === "task" && s.key === key) return s;
    if (s.kind === "parallel" && Array.isArray(s.steps)) {
      const t = s.steps.find((x) => x.key === key);
      if (t) return t;
    }
  }
  return undefined;
}

/**
 * The workflow context for the ticket with this number, or null when the
 * ticket is not part of a workflow or the viewer may work none of its
 * tickets (the route answers 404 either way).
 */
export async function getWorkflowContext(user: { id: number; role: Role }, ticketNumber: number): Promise<HdWorkflowContext | null> {
  const t = await getTicketByNumber(ticketNumber);
  if (!t) return null;
  const request = await requestOf(t);
  if (!request) return null;
  const run = await getRunForTicket(request.id);
  if (!run) return null;

  // Every task ticket of the run, retries' earlier tickets included.
  const tasks = await hq<TaskTicketRow>(
    `SELECT t.id, t.number, t.subject, t.status, t.requester_id, t.team_id, t.assignee_id, tm.name AS team_name,
            coalesce(s.step_key, t.source_ref->>'step_key') AS step_key
       FROM hd_tickets t
       LEFT JOIN hd_teams tm ON tm.id = t.team_id
       LEFT JOIN hd_workflow_steps s ON s.task_ticket_id = t.id AND s.run_id = $2
      WHERE t.parent_ticket_id = $1 AND t.source = 'workflow'
      ORDER BY t.id
      LIMIT 200`,
    [request.id, run.id]
  );
  const workable = new Map<number, boolean>();
  for (const x of [request, ...tasks]) workable.set(x.id, await canWorkTicket(user, x));
  if (![...workable.values()].some(Boolean)) return null;

  const [requester, messages, workflow, handoffs, rt, myTeams] = await Promise.all([
    requesterCard(request, user),
    listMessages(request.id, { includeInternal: false }),
    getWorkflowProgress(request.id, "agent"),
    getHandoffs(run.id),
    hq<{ form: HdFormField[]; team_id: number | null }>("SELECT form, team_id FROM hd_request_types WHERE id = $1", [request.request_type_id ?? 0]),
    memberTeamIds(user.id),
  ]);

  // The task this context was opened from, from the definition the run pinned.
  let task: HdWorkflowContextTask | null = null;
  const own = t.id === request.id ? undefined : tasks.find((x) => x.id === t.id);
  const def = own?.step_key ? pinnedTask((run.current as { definition?: HdWorkflowDefinitionB } | null)?.definition, own.step_key) : undefined;
  if (own && def) {
    // Who takes it back: the coordinating team the engine blocks the run for (request type's team, else the request's).
    const coordId = rt[0]?.team_id ?? request.team_id ?? null;
    const coord = coordId ? await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE id = $1", [coordId]) : [];
    task = {
      step_key: def.key,
      title: def.title,
      outputs: Array.isArray(def.outputs) ? def.outputs : [],
      on_cant_do: def.on_cant_do === "continue" ? "continue" : "stop",
      coordinating_team: coord[0] ? { id: coord[0].id, name: coord[0].name } : null,
    };
  }

  // Why the viewer sees it: their teams (or their own assignment) holding a task of the run.
  const teamNames: string[] = [];
  for (const x of tasks) {
    if (!x.team_name || !workable.get(x.id)) continue;
    if (!(x.team_id !== null && myTeams.includes(x.team_id)) && x.assignee_id !== user.id) continue;
    if (!teamNames.includes(x.team_name)) teamNames.push(x.team_name);
  }

  return {
    request: {
      number: request.number,
      subject: request.subject,
      status: request.status,
      request_type_title: request.request_type_title,
      created_at: request.created_at,
    },
    requester,
    form: Array.isArray(rt[0]?.form) ? rt[0].form : [],
    form_answers: request.form_answers ?? {},
    // Public only: requesterMessages drops internal notes and replies waiting for review; system lines go too.
    messages: requesterMessages(messages).filter((m) => m.kind === "public"),
    workflow,
    handoffs,
    siblings: tasks.map((x) => ({
      number: x.number,
      subject: x.subject,
      team_name: x.team_name,
      status: x.status,
      step_key: x.step_key ?? "",
      can_open: workable.get(x.id) ?? false,
    })),
    task,
    viewer: { team_names: teamNames, can_work_request: workable.get(request.id) ?? false },
  };
}

/**
 * The run behind /api/helpdesk/runs/[id]/…, when this person may
 * coordinate it (work its request); undefined otherwise (404).
 */
export async function runForCoordinator(user: { id: number; role: Role }, rawId: string): Promise<{ id: number; ticket_id: number; ticket_number: number; state: string } | undefined> {
  if (!/^\d{1,9}$/.test(rawId)) return undefined;
  const { getRun } = await import("./engine");
  const run = await getRun(Number(rawId));
  if (!run) return undefined;
  const request = await getTicketById(run.ticket_id);
  if (!request || !(await canWorkTicket(user, request))) return undefined;
  return { id: run.id, ticket_id: run.ticket_id, ticket_number: run.ticket_number, state: run.state };
}
