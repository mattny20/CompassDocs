// Helpdesk 1.19.2: reply-all threading (agent W5). A colleague copied on
// the original email who answers it with Reply all before the desk has
// written back has no reply token to quote (no mail of ours is in the
// thread yet), so 1.19.1 opened a second ticket. Now lib/helpdesk/inbound
// asks here first: the mail's In-Reply-To, then its References from the
// newest back, are matched against the Message-IDs of the email that
// opened a ticket and of the emails added to it since
// (hd_messages.email_message_id, stored for every inbound message since
// 1.19.0 and indexed; a merge carries them to the kept ticket). A match
// names the ticket, and inbound then applies exactly the reply-token
// path's rules: verified senders only (agent S2's sender check; this is
// never asked for an unverified From), and only the requester, an agent
// who may work it, a CC, or the portal contact writes into it (a closed
// ticket gets a follow-up). Anyone else still opens a ticket of their own.
//
// Only messages that came in by email and are public count: a Message-ID
// of ours (hd.… / hd-note-…) is the reply-token path's, and a task ticket
// (parent_ticket_id) is never a mail thread. Server-only.
//
// 1.19.2 review: a reply-all already reached the requester and the other
// CCs on it, so the desk's notice about it mails them no copy (the bell
// stays): directRecipients goes with the message to the notice step.

import "server-only";
import { hq } from "./db-core";
import type { InboundEmail } from "./inbound-parse";

/** How many References are looked at (a long thread's oldest ones say nothing newer). */
const MAX_IDS = 50;

/** The Message-IDs to look up, nearest first: In-Reply-To, then References newest-first. */
export function threadIds(email: Pick<InboundEmail, "inReplyTo" | "references" | "messageId">): string[] {
  const out: string[] = [];
  const own = (email.messageId ?? "").trim();
  for (const raw of [email.inReplyTo, ...[...(email.references ?? [])].reverse()]) {
    const id = (raw ?? "").trim().replace(/^<|>$/g, "").slice(0, 500);
    if (!id || id === own || /^hd[.-]/i.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

/**
 * The ticket an email without a reply token answers by its thread headers,
 * or null. The caller (inbound) asks only for a verified sender and then
 * applies the same authority rules as a reply-token reply.
 */
export async function ticketForReplyAll(email: Pick<InboundEmail, "inReplyTo" | "references" | "messageId">): Promise<number | null> {
  const ids = threadIds(email);
  if (!ids.length) return null;
  const rows = await hq<{ ticket_id: number; email_message_id: string }>(
    `SELECT m.ticket_id, m.email_message_id
       FROM hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id
      WHERE m.email_message_id = ANY($1::text[]) AND m.via = 'email' AND m.kind = 'public' AND t.parent_ticket_id IS NULL
      ORDER BY m.id`,
    [ids]
  );
  if (!rows.length) return null;
  for (const id of ids) {
    const hit = rows.find((r) => r.email_message_id === id);
    if (hit) return hit.ticket_id;
  }
  return null;
}

/**
 * The people a reply-all went to directly (To, Cc and the envelope
 * recipients, lower-case): the requester and CCs among them already have it,
 * so the desk's notice gives them the bell but mails them no second copy
 * (lib/helpdesk/notify toRequester, ccs planCcNotice).
 */
export function directRecipients(email: Pick<InboundEmail, "to" | "cc" | "recipients">): string[] {
  const all = [...(email.to ?? []).map((a) => a.email), ...(email.cc ?? []).map((a) => a.email), ...(email.recipients ?? [])];
  return [...new Set(all.map((a) => (a ?? "").trim().toLowerCase()).filter((a) => a.includes("@")))];
}
