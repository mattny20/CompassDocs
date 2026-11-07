// Helpdesk 1.19.0: what happens after a ticket write commits. The core
// (tickets, messages) calls these once its transaction is done and no
// pool client is held; each step loads what it needs by id and never
// throws (a failing notice or rule must not fail the write that caused it).
//
//   created    workflow start (B, engine), the acknowledgement and "new in
//              my teams" notices (C, notify), the ticket_created rules (C)
//   message    the reply notices (C), the requester_message rules (C)
//   updated    the assignment notice (C), the ticket_updated rules (C)
//   solved     the workflow (B, onTicketSolved: a task's step completes, a
//              request's run stops) and the solved + CSAT notice (C)
//
// Automations apply their own actions through updateTicket/addMessage with
// `fromAutomation`, which skips the rules here so a rule cannot trigger
// itself. Server-only.

import "server-only";
import { logEvent } from "../log";

export interface HdHookContext {
  /** Who did it (never notified of their own action). */
  actorId?: number | null;
  actorName?: string;
  /** Absolute origin for links in notices (the request's). */
  origin?: string;
  /** The write came from an automation: run no rules, so none can loop. */
  fromAutomation?: boolean;
  /** Skip the notices (seed, imports, tests). */
  silent?: boolean;
  /** 1.19.2: a message posted for a major incident: its author doesn't start following the ticket (lib/helpdesk/incidents). */
  noAutoFollow?: boolean;
  /** 1.19.2 (agent W5): an email's own To/Cc (lower-case): those people already have it, so the notice mails them no copy. */
  directRecipients?: string[];
}

async function safely(step: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    logEvent("error", "helpdesk.hook_failed", { step, error: e instanceof Error ? e.message : String(e) });
  }
}

async function rules(event: "ticket_created" | "ticket_updated" | "requester_message", ticketId: number, ctx: HdHookContext) {
  if (ctx.fromAutomation) return;
  await safely(`automations.${event}`, async () => {
    const { runAutomations } = await import("./automations");
    await runAutomations(event, ticketId);
  });
}

export async function afterTicketCreated(
  ticket: { id: number; request_type_id: number | null; source: string; parent_ticket_id: number | null },
  ctx: HdHookContext = {}
): Promise<void> {
  // 1.19.4: outgoing webhooks first (C2, lib/helpdesk/webhooks), so ticket.created is queued before anything
  // below can change the ticket (assignment, rules: ticket.updated) or open its task tickets (their own ticket.created).
  await safely("webhooks.created", async () => (await import("./webhooks")).emitHelpdeskWebhookEvent("ticket.created", { ticketId: ticket.id, actor: { id: ctx.actorId, name: ctx.actorName }, origin: ctx.origin }));
  // 1.19.2: the request type's checklists before anything can solve it (agent W3, lib/helpdesk/checklists).
  if (ticket.request_type_id && ticket.parent_ticket_id === null) {
    await safely("checklists.requestType", async () => (await import("./checklists")).addRequestTypeChecklists(ticket.id));
  }
  // 1.19.2: the ticket's language before assignment, so its rules can route on it (agent W2, lib/helpdesk/skills).
  await safely("skills.language", async () => (await import("./skills/store")).assignLanguageOnCreate(ticket.id));
  // Auto-assignment first (agent N), then rules, so a rule can override the
  // owner and both are in place for the notices.
  await safely("assignment.created", async () => {
    const { assignTicket } = await import("./assignment/engine");
    await assignTicket(ticket.id, { trigger: "created" });
  });
  await rules("ticket_created", ticket.id, ctx);
  if (ticket.request_type_id && ticket.parent_ticket_id === null) {
    await safely("engine.startWorkflowForRequest", async () => {
      const { startWorkflowForRequest } = await import("./engine");
      await startWorkflowForRequest(ticket.id);
    });
  }
  if (!ctx.silent && ticket.source !== "workflow") {
    await safely("notify.requestReceived", async () => {
      const { notifyRequestReceived } = await import("./notify");
      await notifyRequestReceived(ticket.id, { origin: ctx.origin, actorId: ctx.actorId, actorName: ctx.actorName });
    });
  }
  // 1.19.2: an open major incident's rule links a matching new ticket (agent W1, lib/helpdesk/incidents).
  if (!ctx.silent && ticket.source !== "workflow") {
    await safely("incidents.autoLink", async () => (await import("./incidents")).autoLinkNewTicket(ticket.id, { origin: ctx.origin }));
  }
}

export async function afterMessageAdded(
  ticketId: number,
  messageId: number,
  info: { kind: string; fromRequester: boolean; reopened: boolean },
  ctx: HdHookContext = {}
): Promise<void> {
  if (info.kind === "system") return;
  if (!ctx.silent) {
    await safely("notify.reply", async () => {
      const { notifyReply } = await import("./notify");
      await notifyReply(ticketId, messageId, { origin: ctx.origin, actorId: ctx.actorId, actorName: ctx.actorName, reopened: info.reopened, directRecipients: ctx.directRecipients });
    });
  }
  if (info.fromRequester && info.kind === "public") await rules("requester_message", ticketId, ctx);
  // Followers hear of it; an agent who wrote it follows (1.19.1, agent V3, lib/helpdesk/ccs).
  await safely("ccs.afterMessage", async () => {
    const { notifyFollowers, autoFollowOnReply } = await import("./ccs");
    if (!ctx.silent) await notifyFollowers(ticketId, { kind: "message", messageId }, ctx);
    if (!ctx.noAutoFollow) await autoFollowOnReply(ticketId, messageId);
  });
  // 1.19.4: outgoing webhooks; a reply held for review is skipped there and sent on approval (C2, lib/helpdesk/webhooks).
  await safely("webhooks.message", async () =>
    (await import("./webhooks")).emitHelpdeskWebhookEvent(info.kind === "internal" ? "note.created" : "message.created", {
      ticketId,
      messageId,
      actor: { id: ctx.actorId, name: ctx.actorName },
      origin: ctx.origin,
    })
  );
}

export async function afterTicketUpdated(
  ticketId: number,
  change: {
    assigneeChangedTo: number | null | undefined;
    solved: boolean;
    changed: string[];
    /** A team move: from → to (B's task transfer). */
    team?: { from: number | null; to: number | null; source: string };
    reopened?: boolean;
  },
  ctx: HdHookContext = {}
): Promise<void> {
  // 1.19.4: outgoing webhooks, queued before ticket.solved (C2, lib/helpdesk/webhooks).
  if (change.changed.length) {
    await safely("webhooks.updated", async () =>
      (await import("./webhooks")).emitHelpdeskWebhookEvent("ticket.updated", {
        ticketId,
        changed: change.changed,
        previousTeamId: change.team?.from,
        actor: { id: ctx.actorId, name: ctx.actorName },
        origin: ctx.origin,
      })
    );
  }
  if (change.solved) await afterTicketSolved(ticketId, ctx);
  // 1.19.2: a major incident's own ticket reopened opens the incident again (agent W1, lib/helpdesk/incidents).
  if (change.reopened) await safely("incidents.reopened", async () => (await import("./incidents")).onIncidentTicketReopened(ticketId, ctx.actorName));
  // A new team, or a reopened ticket, finds an owner when nobody has it (agent N).
  if (!ctx.fromAutomation && (change.team || change.reopened)) {
    const trigger = change.team ? "team_changed" : "reopened";
    await safely(`assignment.${trigger}`, async () => {
      const { assignTicket } = await import("./assignment/engine");
      await assignTicket(ticketId, { trigger });
    });
  }
  if (change.team && change.team.source === "workflow") {
    const { from, to } = change.team;
    await safely("engine.onTaskTransferred", async () => {
      const { onTaskTransferred } = await import("./engine");
      await onTaskTransferred(ticketId, from, to, { actor: ctx.actorId || ctx.actorName ? { id: ctx.actorId ?? null, name: ctx.actorName ?? "" } : null });
    });
  }
  if (!ctx.silent && change.assigneeChangedTo) {
    const to = change.assigneeChangedTo;
    await safely("notify.assigned", async () => {
      const { notifyAssigned } = await import("./notify");
      await notifyAssigned(ticketId, to, { origin: ctx.origin, actorId: ctx.actorId, actorName: ctx.actorName });
    });
  }
  if (change.changed.length) await rules("ticket_updated", ticketId, ctx);
  // A status change reaches the ticket's followers (1.19.1, agent V3, lib/helpdesk/ccs).
  if (!ctx.silent && change.changed.includes("status")) {
    await safely("ccs.followersStatus", async () => {
      const { notifyFollowers } = await import("./ccs");
      await notifyFollowers(ticketId, { kind: "status" }, ctx);
    });
  }
}

/** Every path that sets a ticket to solved ends here, after its commit. */
export async function afterTicketSolved(ticketId: number, ctx: HdHookContext = {}): Promise<void> {
  // 1.19.2: a major incident's own ticket solved or closed ends the incident (its Status page incident too; agent W1).
  await safely("incidents.ended", async () => (await import("./incidents")).onIncidentTicketEnded(ticketId, ctx.actorName));
  await safely("engine.onTicketSolved", async () => {
    const { onTicketSolved } = await import("./engine");
    await onTicketSolved(ticketId);
  });
  if (!ctx.silent) {
    await safely("notify.solved", async () => {
      const { notifySolvedCsat } = await import("./notify");
      // 1.19.2: a workflow Finish without the survey, held open by its checklist, keeps that choice (agent W3).
      const csat = await (await import("./checklists")).heldFinishCsat(ticketId).catch(() => undefined);
      await notifySolvedCsat(ticketId, { origin: ctx.origin, actorId: ctx.actorId, actorName: ctx.actorName, ...(csat === false ? { csat } : {}) });
    });
  }
  // 1.19.4: outgoing webhooks (C2, lib/helpdesk/webhooks).
  await safely("webhooks.solved", async () => (await import("./webhooks")).emitHelpdeskWebhookEvent("ticket.solved", { ticketId, actor: { id: ctx.actorId, name: ctx.actorName }, origin: ctx.origin }));
}
