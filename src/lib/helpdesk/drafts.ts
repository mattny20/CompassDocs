// Helpdesk 1.19.1: reply drafts (agent V1). The Claude connector's
// hd_draft_reply saves one; the desk shows the pending ones above the
// composer ("Draft from Claude"), where an agent moves the text into the
// composer (used) or discards it. A draft is never a message: nothing here
// sends, emails or shows anything to the requester, and nothing here
// writes to hd_messages. Sending is the agent's own reply, under the normal
// rules (desk role, newbie review). Schema: lib/helpdesk/drafts-schema.
// Server-only.

import "server-only";
import { hq, hqOne } from "./db-core";
import { TICKET_LIMITS } from "./tickets";

export const DRAFT_LIMITS = {
  body: TICKET_LIMITS.body,
  /** Pending drafts kept per ticket: a new one past this retires the oldest. */
  pending: 5,
} as const;

export interface HdReplyDraft {
  id: number;
  ticket_id: number;
  created_by: number | null;
  /** The person who asked Claude ("asked by Ana Kowalski"). */
  created_by_name: string;
  source: string;
  body: string;
  created_at: string;
  discarded_at: string | null;
  used_at: string | null;
}

const SELECT = `SELECT d.id, d.ticket_id, d.created_by, COALESCE(NULLIF(u.name, ''), u.username, '') AS created_by_name,
                       d.source, d.body, d.created_at, d.discarded_at, d.used_at
                  FROM hd_reply_drafts d LEFT JOIN users u ON u.id = d.created_by`;

/** Save a draft on a ticket. The caller has checked who may (canWorkTicket, the connector level). */
export async function createReplyDraft(ticketId: number, body: string, createdBy: number | null, source = "claude"): Promise<HdReplyDraft> {
  const row = await hqOne<{ id: number }>(
    "INSERT INTO hd_reply_drafts (ticket_id, created_by, source, body) VALUES ($1, $2, $3, $4) RETURNING id",
    [ticketId, createdBy, source.slice(0, 40), body.slice(0, DRAFT_LIMITS.body)]
  );
  // Keep the pending pile short: the oldest beyond the limit are retired.
  await hq(
    `UPDATE hd_reply_drafts SET discarded_at = now()
      WHERE id IN (SELECT id FROM hd_reply_drafts
                    WHERE ticket_id = $1 AND discarded_at IS NULL AND used_at IS NULL
                    ORDER BY created_at DESC, id DESC OFFSET $2)`,
    [ticketId, DRAFT_LIMITS.pending]
  );
  return (await getReplyDraft(row!.id))!;
}

export async function getReplyDraft(id: number): Promise<HdReplyDraft | undefined> {
  return hqOne<HdReplyDraft>(`${SELECT} WHERE d.id = $1`, [id]);
}

/** A ticket's pending drafts (neither used nor discarded), newest first. */
export async function listPendingDrafts(ticketId: number): Promise<HdReplyDraft[]> {
  return hq<HdReplyDraft>(
    `${SELECT} WHERE d.ticket_id = $1 AND d.discarded_at IS NULL AND d.used_at IS NULL ORDER BY d.created_at DESC, d.id DESC`,
    [ticketId]
  );
}

/**
 * Close a pending draft of this ticket: "used" (moved into the composer)
 * or "discarded". Undefined when it is not this ticket's or is no longer
 * pending (someone else got there first).
 */
export async function closeReplyDraft(ticketId: number, draftId: number, how: "used" | "discarded"): Promise<HdReplyDraft | undefined> {
  const col = how === "used" ? "used_at" : "discarded_at";
  const r = await hqOne<{ id: number }>(
    `UPDATE hd_reply_drafts SET ${col} = now()
      WHERE id = $1 AND ticket_id = $2 AND discarded_at IS NULL AND used_at IS NULL RETURNING id`,
    [draftId, ticketId]
  );
  return r ? getReplyDraft(r.id) : undefined;
}
