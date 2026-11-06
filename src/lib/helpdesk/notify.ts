// Helpdesk notifications (1.19.0): the bell and the hd_* emails for every
// helpdesk event, one function per event. Agents A (tickets, messages, the
// SLA sweep) and B (workflows, approvals) call these after their writes
// commit; each loads what it needs by id, never throws, and never holds a
// database client while it mails (fire-and-forget: `void notifyX(...)`).
//
// Two audiences, two paths:
//   requester-facing (received, an agent's reply, approval decided, solved +
//     CSAT) go straight to the bell (kind "hd_request") and to email, the
//     per-event email choice honoured the way training's notices honour it
//     (Account → Notifications; a missing preference is "on"). A requester
//     without an account (an outside sender, when that setting is on) is
//     mailed at the address the ticket was opened from.
//   agent-facing (assigned, new in my teams, the requester replied, an
//     internal note, a workflow task, SLA nearing / breached, reopened, and
//     approval needed for any approver) go through deliverToAgent(), the
//     adapter onto agent F's per-agent preferences (lib/helpdesk/notify-prefs
//     deliverAgentNotification: quiet hours, pause, channels, Web Push).
//     Until that module lands the adapter does bell + email itself.
//
// Links: requesters land on /help/requests/[n], agents on /desk/tickets/[n],
// approvers on /help/approvals. Nobody is notified of their own action.
// Server-only.

import "server-only";
import { notify, notifyPrefAllows } from "../notifications";
import type { HdEmailTemplate } from "./notify-prefs";
import { getNotifyPrefsFor } from "../db";
import { logEvent } from "../log";
import { hq, hqOne } from "./db-core";
import { getHelpdeskSettings } from "./settings";
import { hdLinks, helpdeskOrigin, sendHelpdeskTemplate, userEmails, type HelpdeskThread } from "./email";
import { markdownToPlain } from "./inbound-parse";
import { csatBlock } from "./csat";
import { HD_PRIORITY_LABEL } from "./types";
import type { HdPriority, HdSource, HdStatus } from "./types";

// --- Kinds -----------------------------------------------------------------------

/**
 * The bell kinds the helpdesk writes, which are also its rows in
 * Account → Notifications (NotificationEvent["kind"] in lib/notifications
 * carries the same four).
 */
export const HD_NOTIFY_KINDS = ["hd_request", "hd_ticket", "hd_approval", "hd_sla"] as const;
export type HdNotifyKind = (typeof HD_NOTIFY_KINDS)[number];

/** Agent F's event names (lib/helpdesk/notify-prefs). */
export type HdAgentEvent =
  | "assigned_to_me"
  | "new_in_my_teams"
  | "requester_replied"
  | "mention_or_note"
  | "sla_warning"
  | "sla_breach"
  | "approval_needed"
  | "task_assigned"
  | "reopened"
  | "followed_update";

export interface HdAgentPayload {
  ticketNumber: number;
  title: string;
  body: string;
  urgent: boolean;
  /** In-app path. */
  url: string;
  /** The ticket's team (F's per-team switch for "new in my teams"). */
  teamId?: number | null;
  /** The email this event sends, when it sends one: F's email channel passes it to sendHelpdeskEmail. */
  email?: { template: HdEmailTemplate; vars: Record<string, string> };
}

export interface NotifyContext {
  /** Absolute origin for links (the request's); omitted in sweeps. */
  origin?: string;
  /** Who did it: never notified of their own action. */
  actorId?: number | null;
  actorName?: string;
  /**
   * 1.19.2 (agent W5): the addresses an inbound email (a reply-all) already
   * reached directly. The requester and CCs among them get the bell but no
   * mailed copy of it.
   */
  directRecipients?: string[];
}


/** Test hook: record agent deliveries (they are still delivered). */
let agentSpy: ((userId: number, event: HdAgentEvent, payload: HdAgentPayload) => void) | null = null;
export function setAgentDeliverySpyForTests(spy: typeof agentSpy): void {
  agentSpy = spy;
}

/**
 * The one place agent-facing notices leave this module: agent F's
 * deliverAgentNotification (lib/helpdesk/notify-prefs) applies the agent's
 * matrix, quiet hours and pause, and fans out to the bell, email (back
 * through email.sendHelpdeskEmail) and Web Push. Nobody hears of their own
 * action.
 */
export async function deliverToAgent(userId: number, event: HdAgentEvent, payload: HdAgentPayload, ctx: NotifyContext = {}): Promise<void> {
  if (userId === ctx.actorId) return;
  agentSpy?.(userId, event, payload);
  const { deliverAgentNotification } = await import("./notify-prefs");
  await deliverAgentNotification(userId, event, {
    ticketNumber: payload.ticketNumber,
    title: payload.title,
    body: payload.body,
    urgent: payload.urgent,
    url: payload.url,
    teamId: payload.teamId ?? null,
    actorName: ctx.actorName,
    origin: ctx.origin,
    email: payload.email,
  });
}

// --- Shared plumbing -------------------------------------------------------------

async function bell(
  userIds: number[],
  kind: HdNotifyKind,
  title: string,
  body: string,
  link: string,
  ctx: NotifyContext,
  event?: RequesterNotifyEvent
): Promise<void> {
  const ids = userIds.filter((id) => id !== ctx.actorId);
  if (!ids.length) return;
  await notify(ids, {
    kind,
    // The catalog id agent I's per-event bell locks key on.
    event: event ?? kind,
    title: title.slice(0, 300),
    body: body ? body.slice(0, 500) : undefined,
    link,
    actorName: ctx.actorName,
    origin: ctx.origin,
  }).catch((e) => logEvent("error", "helpdesk.notify_failed", { kind, error: String(e) }));
}

/** Email each user who has not switched this kind's email off. */
async function emailUsers(
  userIds: number[],
  kind: HdNotifyKind,
  template: string,
  vars: Record<string, string>,
  ticketNumber: number | null,
  ctx: NotifyContext,
  cc: string[] = []
): Promise<boolean> {
  const ids = [...new Set(userIds.filter((id) => id !== ctx.actorId))];
  if (!ids.length) return false;
  let mailed = false;
  const [emails, prefs] = await Promise.all([userEmails(ids), getNotifyPrefsFor(ids).catch(() => new Map())]);
  const thread = ticketNumber ? await threadFor(ticketNumber) : null;
  for (const id of ids) {
    const u = emails.get(id);
    if (!u?.email) continue;
    if (!notifyPrefAllows(prefs.get(id), kind, "email")) continue;
    if (await sendHelpdeskTemplate(u.email, template, vars, thread, ctx.origin, { cc })) mailed = true;
  }
  return mailed;
}

async function threadFor(number: number): Promise<HelpdeskThread | null> {
  const t = await hqOne<{ id: number; number: number; team_id: number | null }>("SELECT id, number, team_id FROM hd_tickets WHERE number = $1", [number]);
  return t ? { ticketId: t.id, number: t.number, teamId: t.team_id } : null;
}

interface TicketCtx {
  id: number;
  number: number;
  subject: string;
  requester_id: number | null;
  requester_name: string;
  requester_email: string;
  team_id: number | null;
  team_name: string | null;
  assignee_id: number | null;
  assignee_name: string | null;
  status: HdStatus;
  priority: HdPriority;
  source: HdSource;
  parent_ticket_id: number | null;
  parent_number: number | null;
  request_type_title: string | null;
  eta_label: string | null;
  csat_score: number | null;
  reply_token: string | null;
  first_reply_due: string | null;
  resolve_due: string | null;
  /** 1 = opened by a monitoring/API integration (lib/helpdesk/intake): no human requester to notify. */
  automated: number;
}

async function loadTicket(ticketId: number): Promise<TicketCtx | undefined> {
  return hqOne<TicketCtx>(
    `SELECT t.id, t.number, t.subject, t.requester_id, t.requester_name, t.requester_email,
            t.team_id, tm.name AS team_name, t.assignee_id, COALESCE(NULLIF(u.name, ''), u.username) AS assignee_name,
            t.status, t.priority, t.source, t.parent_ticket_id, p.number AS parent_number,
            rt.title AS request_type_title, rt.eta_label, t.csat_score, t.reply_token,
            t.first_reply_due, t.resolve_due, COALESCE((to_jsonb(t) ->> 'automated')::int, 0) AS automated
       FROM hd_tickets t
       LEFT JOIN hd_teams tm ON tm.id = t.team_id
       LEFT JOIN users u ON u.id = t.assignee_id
       LEFT JOIN hd_tickets p ON p.id = t.parent_ticket_id
       LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id
      WHERE t.id = $1`,
    [ticketId]
  );
}

/** Team members (optionally leads only), active accounts. */
export async function teamMemberIds(teamId: number | null, opts: { leadsOnly?: boolean } = {}): Promise<number[]> {
  if (!teamId) return [];
  const rows = await hq<{ user_id: number }>(
    `SELECT m.user_id FROM hd_team_members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = $1 AND u.status = 'active' ${opts.leadsOnly ? "AND m.role = 'lead'" : ""}
      ORDER BY m.user_id`,
    [teamId]
  );
  return rows.map((r) => r.user_id);
}

const excerpt = (s: string, n = 280) => {
  const t = markdownToPlain(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// --- Requester events and the notification policy (agent I) -------------------

/**
 * The requester-facing events, for the notification catalog (agent I's
 * lib/notify-policy): each requester notice is one of these.
 */
export const REQUESTER_NOTIFY_EVENTS = [
  "hd_request_received",
  "hd_desk_replied",
  "hd_waiting_on_you",
  "hd_solved",
  "hd_approval_needed",
  "hd_approval_decided",
  "hd_workflow_message",
  "hd_merged",
  "hd_incident_update",
] as const;
export type RequesterNotifyEvent = (typeof REQUESTER_NOTIFY_EVENTS)[number];

function requesterEvent(template: string, status: HdStatus): RequesterNotifyEvent {
  switch (template) {
    case "hd_request_received":
      return "hd_request_received";
    case "hd_reply":
      return status === "pending" ? "hd_waiting_on_you" : "hd_desk_replied";
    case "hd_solved_csat":
      return "hd_solved";
    case "hd_approval_decided":
      return "hd_approval_decided";
    case "hd_approval_needed":
      return "hd_approval_needed";
    case "hd_merged":
      return "hd_merged";
    case "hd_incident_update":
      return "hd_incident_update";
    default:
      return "hd_workflow_message";
  }
}

/** Requester delivery: the bell and email through the notification policy (agent I's lib/notify-policy: per-event locks, digests), or the ticket's address for a requester without an account. */
async function toRequester(
  t: TicketCtx,
  title: string,
  body: string,
  template: string,
  vars: Record<string, string>,
  ctx: NotifyContext,
  opts: { skipRequester?: boolean; excludeEmail?: string; excludeUserIds?: number[]; excludeEmails?: string[] } = {}
): Promise<void> {
  // An automated ticket (an alert or an API integration) has no person
  // behind it: no receipt, reply, "waiting on you", CSAT or workflow notice.
  if (t.automated) return;
  const link = hdLinks.request(t.number);
  const thread = { ticketId: t.id, number: t.number, teamId: t.team_id };
  const event = requesterEvent(template, t.status);
  // 1.19.1 (agent V3, lib/helpdesk/ccs): a public reply also reaches the
  // people copied on the request, on Cc of the requester's mail.
  // 1.19.2 (agent W1): a major incident's update reaches them the same way.
  // 1.19.2 (agent W5): people the reply-all itself went to get no mailed copy of it (the bell stays).
  const onMail = new Set((ctx.directRecipients ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean));
  const ccs = template === "hd_reply" || template === "hd_incident_update" ? await import("./ccs").then((m) => m.planCcNotice(t.id, event, ctx.actorId ?? null, opts.excludeEmail, { excludeUserIds: opts.excludeUserIds, alreadyMailed: onMail })) : null;
  // 1.19.2 (agent W1): addresses an incident update already reached on another linked ticket.
  if (ccs && opts.excludeEmails?.length) {
    const told = new Set(opts.excludeEmails.map((a) => a.toLowerCase()));
    ccs.cc = ccs.cc.filter((a) => !told.has(a.toLowerCase()));
  }
  let mailed = false;
  if (opts.skipRequester) {
    // The requester wrote it: only the CCs hear.
  } else if (t.requester_id) {
    const userId = t.requester_id;
    if (userId !== ctx.actorId) {
      const { shouldNotify, routeEmail } = await import("../notify-policy");
      if ((await shouldNotify(userId, event, "bell")).send) await bell([userId], "hd_request", title, body, link, ctx, event);
      // routeEmail sends now, queues for the person's digest, or skips.
      if (!onMail.size || !(await requesterOnMail(t, onMail))) {
        await routeEmail(userId, event, { title, body, link }, async () => {
          mailed = await emailUsers([userId], "hd_request", template, { ...vars, ticket_url: link }, t.number, ctx, ccs?.cc);
        });
      }
    }
  } else if (t.requester_email && onMail.has(t.requester_email.toLowerCase())) {
    // 1.19.2 (agent W5): the outside requester or portal contact was on the email itself.
  } else if (t.requester_email && (await (await import("./portal-hooks")).portalRequesterNotice(t.id, template, vars, ctx.origin))) {
    // 1.19.1 (agent V6, lib/helpdesk/portal-hooks): a customer-portal
    // contact's notice went by email from the portal, with a sign-in link.
  } else if (t.requester_email) {
    // An outside sender (no account): the address the ticket came from. No
    // Get help link works for them, so the link is the reply address's job.
    mailed = await sendHelpdeskTemplate(t.requester_email, template, { ...vars, ticket_url: link }, thread, ctx.origin, { cc: ccs?.cc });
  }
  if (ccs) {
    const { finishCcNotice } = await import("./ccs");
    await finishCcNotice(ccs, { event, title, body, link, template, vars: { ...vars, ticket_url: link }, thread, mailedWithRequester: mailed, ctx });
  }
}

/** 1.19.2 (agent W5): is the account requester's address (or the ticket's) among an email's own recipients? */
async function requesterOnMail(t: TicketCtx, onMail: Set<string>): Promise<boolean> {
  if (t.requester_email && onMail.has(t.requester_email.toLowerCase())) return true;
  if (!t.requester_id) return false;
  const u = await hqOne<{ email: string }>("SELECT email FROM users WHERE id = $1", [t.requester_id]);
  return !!u?.email && onMail.has(u.email.toLowerCase());
}

function baseVars(t: TicketCtx): Record<string, string> {
  return {
    ticket_number: String(t.number),
    subject: t.subject,
    requester_name: t.requester_name || "Someone",
    team_name: t.team_name || "The helpdesk",
    priority_label: HD_PRIORITY_LABEL[t.priority] ?? t.priority,
  };
}

function guarded<A extends unknown[]>(name: string, fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      logEvent("error", "helpdesk.notify_failed", { event: name, error: e instanceof Error ? e.message : String(e) });
    }
  };
}

// --- Events ----------------------------------------------------------------------

/**
 * A new request or ticket: the requester's acknowledgement (not for a
 * workflow's task tickets, whose "requester" never asked for them) and a
 * "new in my teams" notice to the team's agents when nobody is assigned.
 */
export const notifyRequestReceived = guarded("request_received", async (ticketId: number, ctx: NotifyContext = {}) => {
  const t = await loadTicket(ticketId);
  if (!t) return;
  ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin) };
  if (t.source !== "workflow" && !t.parent_ticket_id) {
    await toRequester(
      t,
      `Request #${t.number} received`,
      t.subject,
      "hd_request_received",
      {
        ...baseVars(t),
        request_type: t.request_type_title ?? "",
        eta_line: t.eta_label ? `Expected: ${t.eta_label}.` : "",
      },
      // The requester is told even when they raised it themselves.
      { ...ctx, actorId: null }
    );
  }
  if (!t.assignee_id && t.source !== "workflow") {
    for (const id of await teamMemberIds(t.team_id)) {
      if (id === ctx.actorId || id === t.requester_id) continue;
      await deliverToAgent(
        id,
        "new_in_my_teams",
        {
          ticketNumber: t.number,
          title: `New in ${t.team_name ?? "your team"}: #${t.number} ${t.subject}`,
          body: t.requester_name ? `From ${t.requester_name}` : "",
          urgent: t.priority === "urgent",
          url: hdLinks.ticket(t.number),
          teamId: t.team_id,
        },
        ctx
      );
    }
  }
});

/**
 * A message on a ticket. Public from an agent: the requester. Public from
 * the requester: the assignee, else the team (as "reopened" when
 * `ctx.reopened`). Internal: the assignee when someone else wrote it.
 * System messages notify nobody.
 */
export const notifyReply = guarded(
  "reply",
  async (ticketId: number, messageId: number, ctx: NotifyContext & { reopened?: boolean; approvedReview?: boolean } = {}) => {
    const t = await loadTicket(ticketId);
    // review_state (agent J's desk roles) is read through to_jsonb so this
    // works on a database that predates the column.
    const m = await hqOne<{ author_id: number | null; author_name: string; author_email: string; kind: string; body: string; via: string; review_state: string | null }>(
      `SELECT author_id, author_name, author_email, kind, body, via, to_jsonb(m) ->> 'review_state' AS review_state
         FROM hd_messages m WHERE id = $1 AND ticket_id = $2`,
      [messageId, ticketId]
    );
    if (!t || !m || m.kind === "system") return;
    // A reply waiting for a lead's review (or sent back) reaches nobody yet;
    // notifyPublicReply sends it once it is approved.
    if (!ctx.approvedReview && (m.review_state === "pending" || m.review_state === "returned")) return;
    ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin), actorId: ctx.actorId ?? m.author_id, actorName: ctx.actorName ?? m.author_name };
    const author = m.author_name || "Someone";
    const fromRequester =
      (t.requester_id != null && m.author_id === t.requester_id) ||
      (t.requester_id == null && !!t.requester_email && m.author_email.toLowerCase() === t.requester_email.toLowerCase());
    const vars = { ...baseVars(t), author_name: author, message: markdownToPlain(m.body).slice(0, 8000) };

    if (m.kind === "internal") {
      if (!t.assignee_id || t.assignee_id === m.author_id) return;
      await deliverToAgent(
        t.assignee_id,
        "mention_or_note",
        {
          ticketNumber: t.number,
          title: `${author} added a note on #${t.number}`,
          body: excerpt(m.body),
          urgent: false,
          url: hdLinks.ticket(t.number),
          // Its own template: marked internal, no "reply to this email"
          // (lib/helpdesk/email sends it with no Reply-To token, and
          // inbound files an agent's answer to it as an internal note).
          email: { template: "hd_internal_note", vars: { ...vars, ticket_url: hdLinks.ticket(t.number) } },
        },
        ctx
      );
      return;
    }
    // 1.19.1 (agent V3): someone copied on the request writes as the requester does.
    const fromCc = !fromRequester && m.via !== "desk" && (await import("./ccs").then((c) => c.isCcAuthor(t.id, m.author_id, m.author_email)));
    if (fromRequester || fromCc) {
      const targets = t.assignee_id ? [t.assignee_id] : await teamMemberIds(t.team_id);
      for (const id of targets) {
        if (id === m.author_id) continue;
        await deliverToAgent(
          id,
          ctx.reopened ? "reopened" : "requester_replied",
          {
            ticketNumber: t.number,
            title: ctx.reopened ? `${author} reopened #${t.number}` : `${author} replied on #${t.number}`,
            body: excerpt(m.body),
            urgent: t.priority === "urgent",
            url: hdLinks.ticket(t.number),
            email: { template: "hd_reply", vars: { ...vars, ticket_url: hdLinks.ticket(t.number) } },
          },
          ctx
        );
      }
      // The requester and the people copied hear each other's replies (agent V3).
      await toRequester(t, `${author} replied on #${t.number}`, excerpt(m.body), "hd_reply", vars, ctx, {
        skipRequester: fromRequester,
        excludeEmail: m.author_email,
        // An agent who is also a CC already had the desk notice above.
        excludeUserIds: targets,
      });
      return;
    }
    await toRequester(t, `${author} replied on #${t.number}`, excerpt(m.body), "hd_reply", vars, ctx);
  }
);

/**
 * A reply a lead approved (agent J's review): the notice the reply would
 * have sent when it was written, now. `ctx.actorId` should be the reply's
 * author (the default), so they are not told of their own reply.
 */
export async function notifyPublicReply(ticketId: number, messageId: number, ctx: NotifyContext = {}): Promise<void> {
  await notifyReply(ticketId, messageId, { ...ctx, approvedReview: true });
}

/** A ticket was assigned to someone (not when they took it themselves). */
export const notifyAssigned = guarded("assigned", async (ticketId: number, assigneeId: number, ctx: NotifyContext = {}) => {
  if (!assigneeId || assigneeId === ctx.actorId) return;
  const t = await loadTicket(ticketId);
  if (!t) return;
  ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin) };
  const by = ctx.actorName || "Automation";
  await deliverToAgent(
    assigneeId,
    "assigned_to_me",
    {
      ticketNumber: t.number,
      title: `${by} assigned you #${t.number}`,
      body: t.subject,
      urgent: t.priority === "urgent",
      url: hdLinks.ticket(t.number),
      email: { template: "hd_assigned", vars: { ...baseVars(t), assigner_name: by, ticket_url: hdLinks.ticket(t.number) } },
    },
    ctx
  );
});

interface ApprovalCtx {
  id: number;
  ticket_id: number;
  approver_kind: string;
  approver_team_id: number | null;
  approver_user_id: number | null;
  decided_by: number | null;
  decided_by_name: string;
  decision: string;
  note: string;
  step_key: string;
  run_current: Record<string, unknown> | null;
}

async function loadApproval(approvalId: number): Promise<ApprovalCtx | undefined> {
  return hqOne<ApprovalCtx>(
    `SELECT a.id, a.ticket_id, a.approver_kind, a.approver_team_id, a.approver_user_id, a.decided_by,
            a.decided_by_name, a.decision, a.note, s.step_key, r.current AS run_current
       FROM hd_approvals a
       JOIN hd_workflow_steps s ON s.id = a.step_id
       JOIN hd_workflow_runs r ON r.id = a.run_id
      WHERE a.id = $1`,
    [approvalId]
  );
}

/** The step's title from the run's pinned definition (top level or inside a parallel group). */
function stepTitle(current: Record<string, unknown> | null, key: string): string {
  const def = (current?.definition ?? null) as { steps?: { key: string; title?: string; steps?: { key: string; title?: string }[] }[] } | null;
  for (const s of def?.steps ?? []) {
    if (s.key === key) return s.title ?? "";
    for (const c of s.steps ?? []) if (c.key === key) return c.title ?? "";
  }
  return "";
}

/**
 * An approval waits: everyone who may decide it (approvals.approverUserIds).
 * Also the reminder sweep's notice (`reminder: true`).
 */
export const notifyApprovalNeeded = guarded(
  "approval_needed",
  async (approvalId: number, ctx: NotifyContext & { reminder?: boolean } = {}) => {
    const a = await loadApproval(approvalId);
    if (!a || a.decision !== "pending") return;
    const t = await loadTicket(a.ticket_id);
    if (!t) return;
    ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin) };
    // Who decides is B's rule (lib/helpdesk/approvals): the named user, the
    // team's members, a manager fallback's team leads, space access managers.
    const { approverUserIds } = await import("./approvals");
    const approvers = await approverUserIds(approvalId);
    const answers = await answerLines(t.id);
    const title = stepTitle(a.run_current, a.step_key) || "Approval";
    for (const id of approvers) {
      await deliverToAgent(
        id,
        "approval_needed",
        {
          ticketNumber: t.number,
          title: `${ctx.reminder ? "Reminder: " : ""}${t.requester_name || "Someone"} needs your approval: #${t.number}`,
          body: t.subject,
          urgent: false,
          url: hdLinks.approvals(),
          email: {
            template: "hd_approval_needed",
            vars: {
              ...baseVars(t),
              request_type: t.request_type_title ?? "Request",
              step_title: title,
              answers,
              approvals_url: hdLinks.approvals(),
              reminder_prefix: ctx.reminder ? "Reminder: " : "",
            },
          },
        },
        ctx
      );
    }
  }
);

/** The request's form answers as "- Label: value" lines (approvers see the answers they approve). */
async function answerLines(ticketId: number): Promise<string> {
  const row = await hqOne<{ form: { key: string; label: string; type: string; options?: { value: string; label: string }[] }[] | null; answers: Record<string, unknown> }>(
    `SELECT rt.form, t.form_answers AS answers FROM hd_tickets t LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id WHERE t.id = $1`,
    [ticketId]
  );
  if (!row?.form?.length) return "";
  const lines: string[] = [];
  for (const f of row.form) {
    const v = row.answers?.[f.key];
    if (v === undefined || v === null || v === "") continue;
    let shown = typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
    const opt = f.options?.find((o) => o.value === shown);
    if (opt) shown = opt.label;
    if (f.type === "user" && /^\d+$/.test(shown)) {
      const u = await hqOne<{ name: string }>("SELECT COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = $1", [Number(shown)]);
      shown = u?.name ?? shown;
    }
    lines.push(`- ${f.label}: ${shown.replace(/\s+/g, " ").slice(0, 300)}`);
    if (lines.length >= 15) break;
  }
  return lines.join("\n");
}

/** An approver decided: the requester hears it, with the note. `nextLine` says what happens now. */
export const notifyApprovalDecided = guarded(
  "approval_decided",
  async (approvalId: number, ctx: NotifyContext & { nextLine?: string } = {}) => {
    const a = await loadApproval(approvalId);
    if (!a || a.decision === "pending") return;
    const t = await loadTicket(a.ticket_id);
    if (!t) return;
    ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin), actorId: ctx.actorId ?? a.decided_by };
    const approved = a.decision === "approved";
    const who = a.decided_by_name || "Your approver";
    const nextLine = ctx.nextLine ?? (approved ? "We'll carry on with your request." : "Your request won't go ahead as it is. Reply if you'd like to talk it through.");
    await toRequester(
      t,
      `${who} ${approved ? "approved" : "declined"} #${t.number}`,
      a.note || t.subject,
      "hd_approval_decided",
      {
        ...baseVars(t),
        decision_label: approved ? "Approved" : "Declined",
        decision_verb: approved ? "approved" : "declined",
        approver_name: who,
        note: a.note,
        next_line: nextLine,
      },
      // The requester is told even when they approved it themselves (an approver of their own team's request).
      { ...ctx, actorId: null }
    );
  }
);

/** A workflow created a task ticket: its assignee, else its team. */
export const notifyTaskAssigned = guarded("task_assigned", async (taskTicketId: number, ctx: NotifyContext & { dueLabel?: string } = {}) => {
  const t = await loadTicket(taskTicketId);
  if (!t) return;
  ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin) };
  const targets = t.assignee_id ? [t.assignee_id] : await teamMemberIds(t.team_id);
  const due = ctx.dueLabel ?? (t.resolve_due ? new Date(t.resolve_due).toUTCString().slice(0, 16) : "");
  for (const id of targets) {
    await deliverToAgent(
      id,
      "task_assigned",
      {
        ticketNumber: t.number,
        title: `New task for ${t.team_name ?? "your team"}: #${t.number}`,
        body: t.subject,
        urgent: false,
        url: hdLinks.ticket(t.number),
        email: {
          template: "hd_task_assigned",
          vars: {
            ...baseVars(t),
            parent_number: t.parent_number ? String(t.parent_number) : String(t.number),
            due_line: due ? `Due by ${due}.` : "",
            ticket_url: hdLinks.ticket(t.number),
          },
        },
      },
      ctx
    );
  }
});

/**
 * A request was solved: the requester hears it, with the one-question
 * survey when CSAT is on and the request is not rated yet. Not for task
 * tickets (the request's own finish step tells the requester).
 */
export const notifySolvedCsat = guarded("solved", async (ticketId: number, ctx: NotifyContext & { csat?: boolean } = {}) => {
  const t = await loadTicket(ticketId);
  if (!t || t.parent_ticket_id || t.source === "workflow") return;
  ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin) };
  const settings = await getHelpdeskSettings();
  const ask =
    settings.csat_enabled &&
    ctx.csat !== false &&
    t.csat_score == null &&
    // 1.19.2 (agent W5, lib/helpdesk/portal-csat): a customer-portal contact is asked too, with portal links.
    (t.requester_id != null || (await import("./portal-csat").then((m) => m.portalSurveyApplies(t.id))));
  const block = ask ? await csatBlock(t.id, ctx.origin) : "";
  const by = ctx.actorName || t.assignee_name || "The helpdesk";
  await toRequester(
    t,
    `#${t.number} is solved`,
    ask ? "How did we do? Rate it from 1 to 5." : t.subject,
    "hd_solved_csat",
    { ...baseVars(t), agent_name: by, csat_block: block },
    { ...ctx, actorId: null }
  );
});

/**
 * A workflow's Notify step (agent B): `to` is "requester" or user ids. The
 * requester gets the bell (hd_request) and hd_workflow_notify by email with
 * the Get help link; anyone else goes through deliverToAgent with the desk
 * link. `markdown` is the step's message with its placeholders filled; the
 * email quotes it as text.
 */
export const notifyWorkflowMessage = guarded(
  "workflow_message",
  async (ticketId: number, to: "requester" | number[], title: string, markdown: string, ctx: NotifyContext = {}) => {
    const t = await loadTicket(ticketId);
    if (!t) return;
    ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin) };
    const vars = { ...baseVars(t), title: title.slice(0, 200), message: markdownToPlain(markdown).slice(0, 8000) };
    if (to === "requester") {
      await toRequester(t, title || `Update on #${t.number}`, excerpt(markdown), "hd_workflow_notify", vars, { ...ctx, actorId: null });
      return;
    }
    for (const id of [...new Set(to)].slice(0, 200)) {
      if (id === t.requester_id) {
        await toRequester(t, title || `Update on #${t.number}`, excerpt(markdown), "hd_workflow_notify", vars, { ...ctx, actorId: null });
        continue;
      }
      await deliverToAgent(
        id,
        "mention_or_note",
        {
          ticketNumber: t.number,
          title: title || `Update on #${t.number}`,
          body: excerpt(markdown),
          urgent: false,
          url: hdLinks.ticket(t.number),
          email: { template: "hd_workflow_notify", vars: { ...vars, ticket_url: hdLinks.ticket(t.number) } },
        },
        ctx
      );
    }
  }
);

export type SlaTarget = "first_reply" | "resolve";

const TARGET_LABEL: Record<SlaTarget, string> = { first_reply: "first reply", resolve: "resolution" };

async function slaNotice(ticketId: number, target: SlaTarget, breach: boolean, ctx: NotifyContext): Promise<void> {
  const t = await loadTicket(ticketId);
  if (!t) return;
  ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin) };
  const leads = await teamMemberIds(t.team_id, { leadsOnly: true });
  // Nearing: the assignee, else the leads, else the team. Breached: the assignee and the leads (the team when it has neither).
  let targets: number[];
  if (breach) targets = [...new Set([...(t.assignee_id ? [t.assignee_id] : []), ...leads])];
  else targets = t.assignee_id ? [t.assignee_id] : leads;
  if (!targets.length) targets = await teamMemberIds(t.team_id);
  const dueIso = target === "first_reply" ? t.first_reply_due : t.resolve_due;
  const settings = await getHelpdeskSettings();
  const dueTime = dueIso
    ? new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(dueIso))
    : "now";
  for (const id of targets) {
    await deliverToAgent(
      id,
      breach ? "sla_breach" : "sla_warning",
      {
        ticketNumber: t.number,
        title: breach ? `#${t.number} missed its ${TARGET_LABEL[target]} target` : `#${t.number}: ${TARGET_LABEL[target]} due soon`,
        body: t.subject,
        urgent: breach || t.priority === "urgent",
        url: hdLinks.ticket(t.number),
        email: {
          template: breach ? "hd_sla_breach" : "hd_sla_warning",
          vars: { ...baseVars(t), target_label: TARGET_LABEL[target], due_time: dueTime, ticket_url: hdLinks.ticket(t.number) },
        },
      },
      ctx
    );
  }
}

/** The SLA sweep found a target close (A's sweep claims the warning once per ticket and target). */
export const notifySlaWarning = guarded("sla_warning", (ticketId: number, target: SlaTarget = "first_reply", ctx: NotifyContext = {}) =>
  slaNotice(ticketId, target, false, ctx)
);

/** The SLA sweep found a target missed. */
export const notifySlaBreach = guarded("sla_breach", (ticketId: number, target: SlaTarget = "first_reply", ctx: NotifyContext = {}) =>
  slaNotice(ticketId, target, true, ctx)
);

/**
 * The sweep's one-line hook: notify, then run the matching automations
 * (sla_nearing / sla_breached). Call after the sweep has claimed the event.
 *   await (await import("./helpdesk/notify")).onSlaEvent(ticketId, "warning", "first_reply");
 */
export async function onSlaEvent(ticketId: number, kind: "warning" | "breach", target: SlaTarget = "first_reply"): Promise<void> {
  if (kind === "warning") await notifySlaWarning(ticketId, target);
  else await notifySlaBreach(ticketId, target);
  try {
    const { runAutomations } = await import("./automations");
    await runAutomations(kind === "warning" ? "sla_nearing" : "sla_breached", ticketId);
  } catch (e) {
    logEvent("error", "helpdesk.automation_failed", { event: kind, error: e instanceof Error ? e.message : String(e) });
  }
}

/** An automation's notify action: the assignee, the team, or one person. */
export const notifyFromAutomation = guarded(
  "automation",
  async (ticketId: number, to: "assignee" | "team" | { user_id: number }, ruleName: string) => {
    const t = await loadTicket(ticketId);
    if (!t) return;
    const targets =
      to === "assignee" ? (t.assignee_id ? [t.assignee_id] : []) : to === "team" ? await teamMemberIds(t.team_id) : [to.user_id];
    const ctx = { origin: await helpdeskOrigin(), actorName: ruleName };
    for (const id of targets) {
      await deliverToAgent(
        id,
        "mention_or_note",
        {
          ticketNumber: t.number,
          title: `${ruleName}: #${t.number} ${t.subject}`,
          body: t.requester_name ? `From ${t.requester_name}` : "",
          urgent: t.priority === "urgent",
          url: hdLinks.ticket(t.number),
        },
        ctx
      );
    }
  }
);

/**
 * 1.19.1 (agent V2, lib/helpdesk/merge): a request was merged into another
 * ticket and the agent chose to tell the requester. Bell and hd_merged by
 * email through the policy (event hd_merged), threaded on the merged
 * ticket so a reply lands on the kept one (inbound follows merged_into).
 * The link is the merged request's own page, which the requester can
 * always open.
 */
export const notifyMerged = guarded("merged", async (ticketId: number, keepNumber: number, ctx: NotifyContext = {}) => {
  const t = await loadTicket(ticketId);
  if (!t || t.parent_ticket_id || t.source === "workflow") return;
  ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin) };
  await toRequester(
    t,
    `#${t.number} was joined with #${keepNumber}`,
    `Your request has been joined with #${keepNumber} so one person can help with both.`,
    "hd_merged",
    { ...baseVars(t), target_number: String(keepNumber) },
    ctx
  );
});

// --- Major incidents (1.19.2, agent W1, lib/helpdesk/incidents) ---------------

/**
 * An incident's update (or the "we know about this" notice when a ticket is
 * linked) to one linked ticket's requester and CCs: hd_incident_update
 * through the notification policy (bell and email, never a digest), the
 * portal's own mail for a customer-portal contact, the ticket's address
 * for an outside sender, nothing for an automated ticket. The caller tells
 * each person once per update across the incident's tickets:
 * `skipRequester` when this ticket's requester already heard on another,
 * `excludeUserIds` for CCs who did. Replies to the email land on the ticket.
 */
export const notifyIncidentUpdate = guarded(
  "incident_update",
  async (
    ticketId: number,
    n: { incidentTitle: string; message: string; teamName: string | null },
    ctx: NotifyContext & { skipRequester?: boolean; excludeUserIds?: number[]; excludeEmails?: string[] } = {}
  ) => {
    const t = await loadTicket(ticketId);
    if (!t || t.source === "workflow") return;
    ctx = { ...ctx, origin: await helpdeskOrigin(ctx.origin) };
    const team = n.teamName || t.team_name || "The helpdesk";
    await toRequester(
      t,
      `Update: ${n.incidentTitle}`,
      excerpt(n.message),
      "hd_incident_update",
      {
        ...baseVars(t),
        team_name: team,
        incident_title: n.incidentTitle,
        message: n.message,
        request_line: ` (your request #${t.number} is part of it)`,
        link_label: "Open your request",
        reply_line: " or reply to this email.",
      },
      { actorId: ctx.actorId, actorName: ctx.actorName, origin: ctx.origin },
      { skipRequester: ctx.skipRequester, excludeUserIds: ctx.excludeUserIds, excludeEmails: ctx.excludeEmails }
    );
  }
);
