// Helpdesk 1.19.4: the chat apps' personal data, for retention, merge and
// the personal data export (lib/helpdesk/retention, lib/helpdesk/merge).
//
//   hd_chat_people   goes with the account (ON DELETE CASCADE); listed in
//                    the person's export (which apps, since when)
//   hd_chat_threads  goes with the ticket, and with the requester's account
//                    (CASCADE); anonymising a ticket deletes its rows (where
//                    the conversation was is the requester's); merging
//                    moves them to the kept ticket (replies keep reaching
//                    the chat the duplicate came from); the export lists the
//                    requests raised in chat
//   hd_chat_drafts   goes with the account; anonymising forgets the
//                    ticket's (its text was the request)
//
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { hq } from "../db-core";
import { HD_CHAT_APP_LABEL, type HdChatApp } from "../chat-shared";

/** Anonymising a ticket (retention.anonymiseTicketTx): its chat threads, cards and focus go. */
export async function anonymiseChatTx(client: PoolClient, ticketId: number): Promise<void> {
  await client.query("DELETE FROM hd_chat_threads WHERE ticket_id = $1", [ticketId]);
  await client.query("DELETE FROM hd_chat_drafts WHERE ticket_id = $1", [ticketId]);
  await client.query("UPDATE hd_chat_people SET focus_ticket_id = NULL, focus_at = NULL WHERE focus_ticket_id = $1", [ticketId]);
}

/** Merging (merge.mergeTickets): the duplicate's chat threads and focus move to the kept ticket. */
export async function moveChatTx(client: PoolClient, fromId: number, toId: number): Promise<void> {
  await client.query("UPDATE hd_chat_threads SET ticket_id = $2 WHERE ticket_id = $1", [fromId, toId]);
  await client.query("UPDATE hd_chat_people SET focus_ticket_id = $2 WHERE focus_ticket_id = $1", [fromId, toId]);
}

export interface HdChatExport {
  accounts: { app: string; linked_at: string }[];
  /** Requests whose conversation is (also) in a chat app. */
  requests: { number: number; app: string; where: "direct chat" | "channel"; at: string }[];
}

/** The personal data export's chat part (only the person's own requests). */
export async function chatForExport(userId: number, ownTicketIds: number[]): Promise<HdChatExport> {
  const accounts = await hq<{ app: HdChatApp; created_at: string }>("SELECT app, created_at FROM hd_chat_people WHERE user_id = $1 ORDER BY created_at", [userId]);
  // The person's own chat threads (user_id), wherever a merge moved them, never someone else's thread
  // on a ticket they requested. A merged request keeps its own number (ticket_number).
  void ownTicketIds;
  const threads = await hq<{ number: number; app: HdChatApp; kind: string; created_at: string }>(
    `SELECT coalesce(c.ticket_number, t.number) AS number, c.app, c.kind, c.created_at
       FROM hd_chat_threads c JOIN hd_tickets t ON t.id = c.ticket_id
      WHERE c.user_id = $1 ORDER BY c.created_at, c.id`,
    [userId]
  );
  return {
    accounts: accounts.map((a) => ({ app: HD_CHAT_APP_LABEL[a.app] ?? a.app, linked_at: a.created_at })),
    requests: threads.map((t) => ({ number: t.number, app: HD_CHAT_APP_LABEL[t.app] ?? t.app, where: t.kind === "channel" ? "channel" : "direct chat", at: t.created_at })),
  };
}
