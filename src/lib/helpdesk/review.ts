// Helpdesk 1.19.0: newbie reply review (agent J). A public reply by someone
// whose desk role holds tickets.reply_needs_review (Newbie by default) is
// stored with review_state 'pending': the requester doesn't see it
// (access requesterMessages), it isn't emailed (notify notifyReply skips
// it), and the first-reply clock doesn't stop. A reviewer (replies.review:
// the ticket team's leads, else Managers) then
//   approves  — optionally editing the text first: the reply is sent now
//               (review_state 'approved', the requester's notice and email,
//               first reply stamped), or
//   returns   — with a note: review_state 'returned', the note as an
//               internal message on the ticket and a bell to the newbie.
// Every path that adds a public agent message (desk, portal, inbound email)
// goes through A's addMessage, which asks prepareReply. Server-only.

import "server-only";
import { audit } from "../audit";
import { insertNotifications } from "../db";
import type { Role } from "../types";
import { hq, hqOne, withTx } from "./db-core";
import { hdCan, hdRoleOf, roleFacts } from "./roles";
import { listDeskAgents } from "./roles-agents";
import { HD_ROLE_RANK, type HdPendingReview, type HdReviewState } from "./roles-shared";

type U = { id: number; role: Role };
type Author = { id: number; role?: Role };

export type { HdPendingReview, HdReviewState };

export const REVIEW_LIMITS = { note: 2000, body: 50_000, list: 200 } as const;

export class ReviewError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

async function asUser(a: Author): Promise<U | null> {
  if (a.role) return { id: a.id, role: a.role };
  const row = await hqOne<{ id: number; role: Role }>("SELECT id, role FROM users WHERE id = $1", [a.id]);
  return row ?? null;
}

/**
 * The review state a new message gets. Only a public reply by an agent
 * (not the requester on their own ticket) whose role holds
 * tickets.reply_needs_review is held. Call it before opening the insert's
 * transaction (it reads on its own connection).
 */
export async function prepareReply(
  author: Author,
  ticket: { id?: number; requester_id?: number | null; team_id?: number | null },
  input: { kind: string; asRequester?: boolean }
): Promise<{ review_state: HdReviewState | null }> {
  if (input.kind !== "public" || input.asRequester) return { review_state: null };
  if (ticket.requester_id != null && ticket.requester_id === author.id) return { review_state: null };
  const user = await asUser(author);
  if (!user) return { review_state: null };
  // Not team-scoped: a newbie's reply is held wherever they write it.
  const held = await hdCan(user, "tickets.reply_needs_review");
  return { review_state: held ? "pending" : null };
}

// --- Notices ------------------------------------------------------------------------

/** The two review events, in the notification catalog's spelling (desk_review_*; the desk's matrix says review_*). */
export type HdReviewEvent = "desk_review_requested" | "desk_review_returned";

/** Test hook: record review notices. */
let reviewSpy: ((userId: number, event: HdReviewEvent, title: string) => void) | null = null;
export function setReviewNoticeSpyForTests(spy: typeof reviewSpy): void {
  reviewSpy = spy;
}

async function reviewNotice(userIds: number[], event: HdReviewEvent, n: { title: string; body: string; url: string; ticketNumber: number; teamId: number | null; actorName?: string }): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  for (const id of ids) reviewSpy?.(id, event, n.title);
  try {
    const prefs = await import("./notify-prefs");
    // Through the agent's matrix and the workspace policy: agentEventName
    // reads either spelling (a bare HD_NOTIFY_EVENTS check never matched).
    const name = prefs.agentEventName(event);
    if (name) {
      for (const id of ids) {
        await prefs.deliverAgentNotification(id, name, {
          ticketNumber: n.ticketNumber,
          title: n.title,
          body: n.body,
          url: n.url,
          teamId: n.teamId,
          actorName: n.actorName,
        });
      }
      return;
    }
  } catch (e) {
    console.error("helpdesk review: notice via preferences failed:", e);
  }
  try {
    await insertNotifications(ids, { kind: "hd_ticket", title: n.title, body: n.body, link: n.url, actor_name: n.actorName });
  } catch (e) {
    console.error("helpdesk review: bell failed:", e);
  }
}

function excerpt(s: string, n = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Who reviews a ticket's held replies: members of its team who hold
 * replies.review there (its leads, by default), else every Manager and
 * Admin. Never the author.
 */
export async function reviewersFor(teamId: number | null, authorId: number | null): Promise<number[]> {
  const out: number[] = [];
  if (teamId != null) {
    const members = await hq<{ id: number; role: Role }>(
      `SELECT u.id, u.role FROM hd_team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active' WHERE m.team_id = $1 ORDER BY u.id`,
      [teamId]
    );
    for (const m of members) {
      if (m.id === authorId) continue;
      const r = await hdRoleOf(m);
      // Managers and Admins in the team are the fallback, not the first call.
      if (r && HD_ROLE_RANK[r.role] < HD_ROLE_RANK.manager && (await hdCan(m, "replies.review", { teamId }))) out.push(m.id);
    }
  }
  if (out.length) return out;
  const agents = await listDeskAgents();
  for (const a of agents) {
    if (a.user_id === authorId || HD_ROLE_RANK[a.role] < HD_ROLE_RANK.manager) continue;
    out.push(a.user_id);
  }
  return out;
}

/** After a held reply commits: tell its reviewers. Never throws. */
export async function notifyReviewRequested(ticketId: number, messageId: number): Promise<void> {
  try {
    const row = await hqOne<{ number: number; subject: string; team_id: number | null; author_id: number | null; author_name: string; body: string; review_state: string | null }>(
      `SELECT t.number, t.subject, t.team_id, m.author_id, m.author_name, m.body, m.review_state
         FROM hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id WHERE m.id = $1 AND m.ticket_id = $2`,
      [messageId, ticketId]
    );
    if (!row || row.review_state !== "pending") return;
    const to = await reviewersFor(row.team_id, row.author_id);
    await reviewNotice(to, "desk_review_requested", {
      title: `${row.author_name || "A newbie"}'s reply on #${row.number} needs review`,
      body: excerpt(row.body),
      url: `/desk/reviews?message=${messageId}`,
      ticketNumber: row.number,
      teamId: row.team_id,
      actorName: row.author_name,
    });
  } catch (e) {
    console.error("helpdesk review: review-requested notice failed:", e);
  }
}

// --- The list -------------------------------------------------------------------------

/** Held replies this person may review, oldest first. */
export async function pendingReviews(user: U): Promise<HdPendingReview[]> {
  if (!(await hdCan(user, "replies.review"))) return [];
  const [all, facts] = await Promise.all([hdCan(user, "tickets.view_all"), roleFacts(user)]);
  return hq<HdPendingReview>(
    `SELECT m.id AS message_id, t.id AS ticket_id, t.number AS ticket_number, t.subject AS ticket_subject,
            t.team_id, tm.name AS team_name, COALESCE(t.requester_name, '') AS requester_name,
            m.author_id, m.author_name, m.body, m.created_at
       FROM hd_messages m
       JOIN hd_tickets t ON t.id = m.ticket_id
       LEFT JOIN hd_teams tm ON tm.id = t.team_id
      WHERE m.review_state = 'pending'
        AND (m.author_id IS NULL OR m.author_id <> $1)
        AND ($2::boolean OR t.team_id = ANY($3::int[]))
      ORDER BY m.created_at, m.id
      LIMIT ${REVIEW_LIMITS.list}`,
    [user.id, all, facts.teams]
  );
}

/** How many held replies wait for this person (the desk's badge). */
export async function pendingReviewCount(user: U): Promise<number> {
  return (await pendingReviews(user)).length;
}

// --- Deciding ----------------------------------------------------------------------------

export interface ReviewDecision {
  decision: "approve" | "return";
  edited_body?: string;
  note?: string;
}

export interface ReviewOutcome {
  message_id: number;
  ticket_id: number;
  ticket_number: number;
  review_state: "approved" | "returned";
  edited: boolean;
  author_id: number | null;
}

/** Validate a decision body; the clean decision or an error sentence. */
export function parseDecision(raw: Record<string, unknown>): { ok: true; value: ReviewDecision } | { ok: false; error: string } {
  if (raw.decision !== "approve" && raw.decision !== "return") return { ok: false, error: "The decision is approve or return." };
  const out: ReviewDecision = { decision: raw.decision };
  if (raw.edited_body !== undefined && raw.edited_body !== null) {
    if (typeof raw.edited_body !== "string") return { ok: false, error: "The edited reply must be text." };
    if (raw.decision !== "approve") return { ok: false, error: "Only an approved reply can be edited." };
    const b = raw.edited_body.trim();
    if (!b) return { ok: false, error: "The edited reply is empty." };
    if (b.length > REVIEW_LIMITS.body) return { ok: false, error: "The edited reply is too long." };
    out.edited_body = b;
  }
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== "string") return { ok: false, error: "The note must be text." };
    const n = raw.note.trim();
    if (n.length > REVIEW_LIMITS.note) return { ok: false, error: `Keep the note under ${REVIEW_LIMITS.note} characters.` };
    out.note = n;
  }
  if (out.decision === "return" && !out.note) return { ok: false, error: "Say what to change: a returned reply needs a note." };
  return { ok: true, value: out };
}

/**
 * Approve (send, optionally edited) or return (with a note) a held reply.
 * Throws ReviewError (404 unknown, 403 not theirs to review, 409 already
 * decided). Audits helpdesk.reply.reviewed.
 */
export async function decideReview(
  user: U & { name?: string; username?: string },
  messageId: number,
  d: ReviewDecision,
  ctx: { origin?: string; ip?: string | null } = {}
): Promise<ReviewOutcome> {
  const reviewerName = user.name || user.username || "A reviewer";
  const head = await hqOne<{ team_id: number | null; author_id: number | null }>(
    "SELECT t.team_id, m.author_id FROM hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id WHERE m.id = $1",
    [messageId]
  );
  if (!head) throw new ReviewError("That reply doesn't exist.", 404);
  if (head.author_id === user.id) throw new ReviewError("You can't review your own reply.", 403);
  if (!(await hdCan(user, "replies.review", { teamId: head.team_id }))) throw new ReviewError("You don't have permission for that.", 403);

  const res = await withTx(async (client) => {
    const m = await hqOne<{ id: number; ticket_id: number; author_id: number | null; author_name: string; body: string; review_state: string | null }>(
      "SELECT id, ticket_id, author_id, author_name, body, review_state FROM hd_messages WHERE id = $1 FOR UPDATE",
      [messageId],
      client
    );
    if (!m) throw new ReviewError("That reply doesn't exist.", 404);
    if (m.review_state !== "pending") throw new ReviewError("This reply has already been reviewed.", 409);
    const t = await hqOne<{ id: number; number: number; status: string; team_id: number | null }>(
      "SELECT id, number, status, team_id FROM hd_tickets WHERE id = $1 FOR UPDATE",
      [m.ticket_id],
      client
    );
    if (!t) throw new ReviewError("That reply doesn't exist.", 404);
    const edited = d.decision === "approve" && d.edited_body !== undefined && d.edited_body !== m.body;
    if (d.decision === "approve") {
      // Sent now: it takes its place in the conversation at the time it was sent.
      await client.query(
        `UPDATE hd_messages SET review_state = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3,
                body = $4, created_at = now() WHERE id = $1`,
        [messageId, user.id, d.note ?? null, edited ? d.edited_body : m.body]
      );
      await client.query("UPDATE hd_tickets SET updated_at = now(), first_replied_at = COALESCE(first_replied_at, now()) WHERE id = $1", [t.id]);
      await client.query(
        `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via) VALUES ($1, $2, $3, 'internal', $4, 'system')`,
        [t.id, user.id, reviewerName, `${reviewerName} approved ${m.author_name || "the"}'s reply${edited ? " with edits" : ""}.`]
      );
    } else {
      await client.query(
        "UPDATE hd_messages SET review_state = 'returned', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1",
        [messageId, user.id, d.note]
      );
      await client.query(
        `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via) VALUES ($1, $2, $3, 'internal', $4, 'desk')`,
        [t.id, user.id, reviewerName, `Returned ${m.author_name || "a"}'s reply for changes: ${d.note}`]
      );
    }
    return { m, t, edited };
  });

  const outcome: ReviewOutcome = {
    message_id: messageId,
    ticket_id: res.t.id,
    ticket_number: res.t.number,
    review_state: d.decision === "approve" ? "approved" : "returned",
    edited: res.edited,
    author_id: res.m.author_id,
  };

  await audit({
    actor: { id: user.id, name: reviewerName, role: user.role },
    action: "helpdesk.reply.reviewed",
    targetType: "helpdesk_message",
    targetId: messageId,
    targetLabel: `#${res.t.number}`,
    details: { decision: d.decision, edited: res.edited, author_id: res.m.author_id, ticket_number: res.t.number, note: d.note ?? null },
    ip: ctx.ip ?? null,
  });

  if (d.decision === "approve") {
    // A reply that is sent opens a new ticket, like any first agent reply.
    if (res.t.status === "new") {
      try {
        const { updateTicket } = await import("./tickets");
        await updateTicket(res.t.id, { status: "open" }, { id: res.m.author_id, name: res.m.author_name }, { origin: ctx.origin, silent: true });
      } catch (e) {
        console.error("helpdesk review: status update failed:", e);
      }
    }
    try {
      const { notifyPublicReply } = await import("./notify");
      await notifyPublicReply(res.t.id, messageId, { origin: ctx.origin, actorId: res.m.author_id, actorName: res.m.author_name });
    } catch (e) {
      console.error("helpdesk review: reply notice failed:", e);
    }
    // 1.19.1: the followers' notice was held with the reply; it goes now
    // (never to the author, nor to the lead who approved it).
    try {
      const { notifyFollowers } = await import("./ccs");
      await notifyFollowers(res.t.id, { kind: "message", messageId }, { origin: ctx.origin, actorId: user.id, actorName: reviewerName });
    } catch (e) {
      console.error("helpdesk review: followers notice failed:", e);
    }
  } else if (res.m.author_id) {
    await reviewNotice([res.m.author_id], "desk_review_returned", {
      title: `${reviewerName} returned your reply on #${res.t.number}`,
      body: excerpt(d.note ?? ""),
      url: `/desk/tickets/${res.t.number}`,
      ticketNumber: res.t.number,
      teamId: res.t.team_id,
      actorName: reviewerName,
    });
  }
  return outcome;
}
