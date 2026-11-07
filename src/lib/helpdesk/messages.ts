// Helpdesk 1.19.0: the conversation and the timeline of a ticket.
//
//   public    the requester sees it (portal, email, desk replies)
//   internal  agents only, never in a requester's read (lib/helpdesk/access
//             requesterMessages); with via 'system' it is an agent-only
//             timeline line ("Auto-assigned to IT by the rule …")
//   system    a requester-visible timeline line ("Status changed …",
//             workflow steps)
//
// An agent's first public message stamps first_replied_at (the first-reply
// clock). A requester's public message on a ticket waiting on them, or on a
// solved one, reopens it (open), which also resumes the SLA clocks. An
// agent's reply can change the status in the same step (then_status:
// "send and mark pending/solved"). Server-only.

import "server-only";
import { hq, hqOne, withTx } from "./db-core";
import { afterMessageAdded } from "./events";
import type { HdHookContext } from "./events";
import { assertNotMergedTx, getTicketRow, HdTicketError, TICKET_LIMITS, updateTicket } from "./tickets";
import { isChecklistBlock, solvesForChecklists } from "./checklists-shared";
import type { HdAttachment, HdMessage, HdMessageKind, HdMessageVia, HdReviewState, HdStatus } from "./types";

export const MESSAGE_LIMITS = { body: TICKET_LIMITS.body, page: 1000 } as const;

const MSG_COLS =
  "id, ticket_id, author_id, author_name, author_email, kind, body, via, attachments, email_message_id, created_at, review_state, reviewed_by, reviewed_at, review_note";

export async function listMessages(ticketId: number, opts: { includeInternal?: boolean } = {}): Promise<HdMessage[]> {
  const cols = MSG_COLS.split(", ").map((c) => `m.${c}`).join(", ");
  return hq<HdMessage>(
    `SELECT ${cols},
            CASE WHEN m.kind = 'system' OR m.author_id IS NULL OR m.author_id IS NOT DISTINCT FROM t.requester_id THEN NULL
                 ELSE (SELECT tm.name FROM hd_team_members mm JOIN hd_teams tm ON tm.id = mm.team_id
                        WHERE mm.user_id = m.author_id
                        ORDER BY (mm.team_id IS NOT DISTINCT FROM t.team_id) DESC, tm.position, tm.id LIMIT 1) END AS author_team_name,
            -- 1.19.4 (C6, lib/helpdesk/share-schema): a feature's own timeline marker, internal lines only.
            CASE WHEN m.kind = 'internal' THEN m.event END AS event
       FROM hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id
      WHERE m.ticket_id = $1 ${opts.includeInternal === false ? "AND m.kind <> 'internal'" : ""}
      ORDER BY m.created_at, m.id LIMIT ${MESSAGE_LIMITS.page}`,
    [ticketId]
  );
}

export async function getMessage(id: number): Promise<HdMessage | undefined> {
  return hqOne<HdMessage>(`SELECT ${MSG_COLS} FROM hd_messages WHERE id = $1`, [id]);
}

export interface AddMessageInput {
  kind: Exclude<HdMessageKind, "system">;
  body: string;
  author: { id: number | null; name: string; email: string };
  via: HdMessageVia;
  /** The author is acting as the requester (their own ticket), not as an agent. Default false. */
  asRequester?: boolean;
  attachments?: HdAttachment[];
  email_message_id?: string | null;
  /** Agents only: the status to set in the same step ("send and mark solved"). */
  then_status?: HdStatus;
}

export interface AddMessageResult {
  message: HdMessage;
  reopened: boolean;
  status: HdStatus;
  /** A newbie's public reply held for review (review_state 'pending'): not sent yet. */
  held: boolean;
  /** 1.19.2: then_status was refused for required checklist items after the reply was stored (it was still sent); the sentence. */
  status_unchanged?: string;
}

/**
 * Add a message and apply its effects (first reply, the requester's reopen,
 * then_status), then the after-commit hooks (notices; the requester_message
 * rules). Undefined when the ticket does not exist. A requester can only
 * write public messages; an internal note from asRequester is refused.
 */
export async function addMessage(ticketId: number, input: AddMessageInput, ctx: HdHookContext = {}): Promise<AddMessageResult | undefined> {
  if (input.asRequester && input.kind !== "public") throw new Error("A requester can only write public messages.");
  const body = input.body.slice(0, MESSAGE_LIMITS.body);
  const asRequester = input.asRequester === true;
  // Newbie review (lib/helpdesk/review, agent J): a public reply by an
  // agent whose desk role holds tickets.reply_needs_review is stored
  // 'pending' and not sent: no first reply, no new → open, no then_status.
  // Asked before the transaction (it reads on its own connection).
  let reviewState: HdReviewState | null = null;
  if (input.kind === "public" && !asRequester && input.author.id) {
    const pre = await getTicketRow(ticketId);
    if (!pre) return undefined;
    const { prepareReply } = await import("./review");
    reviewState = (await prepareReply({ id: input.author.id }, pre, { kind: input.kind, asRequester })).review_state;
  }
  const held = reviewState === "pending";
  const res = await withTx(async (client) => {
    const t = await getTicketRow(ticketId, client, true);
    if (!t) return undefined;
    // 1.19.1: re-checked under the lock a merge takes (HdTicketError 409, messageUnsent).
    await assertNotMergedTx(client, t, { messageUnsent: true });
    // 1.19.2: "Send and set Solved" with required checklist items open is refused before anything is written (agent W3).
    if (!held && !asRequester && solvesForChecklists(t.status, input.then_status)) {
      const blocked = await (await import("./checklists")).checklistSolveRefusal(ticketId, client);
      if (blocked) {
        const err = new HdTicketError(blocked.error, 409);
        err.messageUnsent = true;
        throw err;
      }
    }
    const ins = await hq<HdMessage>(
      `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via, attachments, email_message_id, review_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${MSG_COLS}`,
      [
        ticketId,
        input.author.id,
        input.author.name.slice(0, 200),
        input.author.email.slice(0, 320),
        input.kind,
        body,
        input.via,
        JSON.stringify(input.attachments ?? []),
        input.email_message_id ?? null,
        reviewState,
      ],
      client
    );
    const firstReply = !held && !asRequester && input.kind === "public" && !t.first_replied_at;
    await client.query(
      `UPDATE hd_tickets SET updated_at = now()${firstReply ? ", first_replied_at = now()" : ""}
         ${!held && !asRequester && input.kind === "public" && t.status === "new" && !input.then_status ? ", status = 'open'" : ""}
        WHERE id = $1`,
      [ticketId]
    );
    return { message: ins[0], ticket: t };
  });
  if (!res) return undefined;

  // Status effects go through updateTicket (the SLA pause/resume, the
  // timeline line, the solve hooks), after the message has committed.
  let reopened = false;
  let statusUnchanged: string | undefined;
  let status = res.ticket.status;
  const actor = { id: input.author.id, name: input.author.name };
  if (asRequester && (status === "pending" || status === "solved")) {
    const r = await updateTicket(ticketId, { status: "open" }, actor, { ...ctx, fromAutomation: ctx.fromAutomation });
    reopened = status === "solved";
    status = r?.ticket.status ?? status;
  } else if (!held && !asRequester && input.then_status && input.then_status !== status) {
    try {
      const r = await updateTicket(ticketId, { status: input.then_status }, actor, ctx);
      status = r?.ticket.status ?? status;
    } catch (e) {
      // 1.19.2: a required item unticked since the check above. The reply is stored, so it is
      // still sent (the hooks below); the status stays and the caller is told (agent W3).
      if (!(e instanceof HdTicketError) || !isChecklistBlock(e.message)) throw e;
      statusUnchanged = e.message;
    }
  } else if (!held && !asRequester && input.kind === "public" && status === "new") {
    status = "open";
  }
  await afterMessageAdded(
    ticketId,
    res.message.id,
    { kind: input.kind, fromRequester: asRequester, reopened },
    { actorId: input.author.id, actorName: input.author.name, ...ctx }
  );
  if (held) {
    const { notifyReviewRequested } = await import("./review");
    await notifyReviewRequested(ticketId, res.message.id).catch((e) => console.error("[helpdesk] review notice:", e));
  }
  return { message: res.message, reopened, status, held, ...(statusUnchanged ? { status_unchanged: statusUnchanged } : {}) };
}

/**
 * A timeline line. `internal` keeps it agent-only (kind 'internal', via
 * 'system'); otherwise kind 'system', which the requester sees. Runs no
 * hooks. Pass a client to write inside the caller's transaction.
 */
export async function addSystemMessage(
  ticketId: number,
  body: string,
  opts: { internal?: boolean; author?: { id: number | null; name: string }; client?: import("./db-core").HdQueryable } = {}
): Promise<HdMessage | undefined> {
  return hqOne<HdMessage>(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via)
     VALUES ($1, $2, $3, $4, $5, 'system') RETURNING ${MSG_COLS}`,
    [ticketId, opts.author?.id ?? null, opts.author?.name ?? "", opts.internal ? "internal" : "system", body.slice(0, MESSAGE_LIMITS.body)],
    opts.client
  );
}
