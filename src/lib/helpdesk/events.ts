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
      await notifyReply(ticketId, messageId, { origin: ctx.origin, actorId: ctx.actorId, actorName: ctx.actorName, reopened: info.reopened });
    });
  }
  if (info.fromRequester && info.kind === "public") await rules("requester_message", ticketId, ctx);
  // Followers hear of it; an agent who wrote it follows (1.19.1, agent V3, lib/helpdesk/ccs).
  await safely("ccs.afterMessage", async () => {
    const { notifyFollowers, autoFollowOnReply } = await import("./ccs");
    if (!ctx.silent) await notifyFollowers(ticketId, { kind: "message", messageId }, ctx);
    await autoFollowOnReply(ticketId, messageId);
  });
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
  if (change.solved) await afterTicketSolved(ticketId, ctx);
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
  await safely("engine.onTicketSolved", async () => {
    const { onTicketSolved } = await import("./engine");
    await onTicketSolved(ticketId);
  });
  if (!ctx.silent) {
    await safely("notify.solved", async () => {
      const { notifySolvedCsat } = await import("./notify");
      await notifySolvedCsat(ticketId, { origin: ctx.origin, actorId: ctx.actorId, actorName: ctx.actorName });
    });
  }
}
