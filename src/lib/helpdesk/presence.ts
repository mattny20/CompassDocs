// Helpdesk 1.19.1: collision warnings (agent V4). Who else has a ticket
// open ("Sam Lee is viewing" / "is replying"), and the send guard that
// stops a reply when someone else answered while it was being typed.
//
// Presence lives in hd_ticket_presence (presence-schema): one row per agent
// and ticket, refreshed by the desk's heartbeat; rows older than the TTL
// are ignored and the minute sweep (lib/periodic HELPDESK_SWEEPS,
// hd_presence) deletes old ones. Callers have already checked that the
// person works the ticket (routes loadTicketFor "work"): requesters never
// reach any of this.
//
// The send guard is one call for every send path (the messages route and
// a macro's reply): collisionRefusal(ticketId, userId, body) answers 409
// { error, newer } when a public reply or internal note by someone else
// has landed after `expect_last_message_id`, unless `force` is true.
// Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { hq } from "./db-core";
import {
  COLLISION_ERROR,
  NEWER_BODY_MAX,
  PRESENCE_SWEEP_SECONDS,
  PRESENCE_TTL_SECONDS,
  presenceInitials,
  type HdNewerMessage,
  type HdPresence,
  type HdPresenceState,
} from "./presence-shared";

/** Record a heartbeat: the person has the ticket open in `state`. */
export async function touchPresence(ticketId: number, userId: number, state: HdPresenceState): Promise<void> {
  await hq(
    `INSERT INTO hd_ticket_presence (ticket_id, user_id, state, seen_at, since)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (ticket_id, user_id) DO UPDATE
       SET since = CASE WHEN hd_ticket_presence.state = EXCLUDED.state
                         AND hd_ticket_presence.seen_at > now() - make_interval(secs => $4)
                        THEN hd_ticket_presence.since ELSE now() END,
           state = EXCLUDED.state,
           seen_at = now()`,
    [ticketId, userId, state, PRESENCE_TTL_SECONDS]
  );
}

/** The person closed the ticket (or the tab). */
export async function leavePresence(ticketId: number, userId: number): Promise<void> {
  await hq("DELETE FROM hd_ticket_presence WHERE ticket_id = $1 AND user_id = $2", [ticketId, userId]);
}

/** Everyone else seen on the ticket within the TTL, replying first, then the longest there. */
export async function othersPresent(ticketId: number, userId: number): Promise<HdPresence[]> {
  const rows = await hq<{ user_id: number; name: string; state: HdPresenceState; since: string; seen_at: string }>(
    `SELECT p.user_id, COALESCE(NULLIF(u.name, ''), u.username) AS name, p.state, p.since, p.seen_at
       FROM hd_ticket_presence p JOIN users u ON u.id = p.user_id AND u.status = 'active'
      WHERE p.ticket_id = $1 AND p.user_id <> $2 AND p.seen_at > now() - make_interval(secs => $3)
      ORDER BY (p.state = 'replying') DESC, p.since, p.user_id
      LIMIT 20`,
    [ticketId, userId, PRESENCE_TTL_SECONDS]
  );
  return rows.map((r) => ({
    user_id: Number(r.user_id),
    name: r.name,
    initials: presenceInitials(r.name),
    state: r.state,
    since: iso(r.since),
    seen_at: iso(r.seen_at),
  }));
}

/** The periodic sweep: drop rows nobody has refreshed for five minutes. */
export async function sweepPresence(now: Date = new Date()): Promise<number> {
  const rows = await hq<{ ticket_id: number }>(
    "DELETE FROM hd_ticket_presence WHERE seen_at < $1::timestamptz - make_interval(secs => $2) RETURNING ticket_id",
    [now.toISOString(), PRESENCE_SWEEP_SECONDS]
  );
  return rows.length;
}

/**
 * Public replies and internal notes by anyone but `userId` after message
 * `sinceId`: what the person had not seen when they started typing. Timeline
 * lines (system, and agent-only lines written via 'system') and a newbie's
 * reply still held for review (not sent) do not count.
 */
export async function newerMessages(ticketId: number, sinceId: number, userId: number): Promise<HdNewerMessage[]> {
  const rows = await hq<{
    id: number;
    author_id: number | null;
    author_name: string;
    author_email: string;
    kind: "public" | "internal";
    body: string;
    created_at: string;
    requester_id: number | null;
  }>(
    `SELECT m.id, m.author_id, m.author_name, m.author_email, m.kind, m.body, m.created_at, t.requester_id
       FROM hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id
      WHERE m.ticket_id = $1 AND m.id > $2
        AND m.kind IN ('public', 'internal') AND m.via <> 'system'
        AND m.author_id IS DISTINCT FROM $3::int
        AND COALESCE(m.review_state, '') NOT IN ('pending', 'returned')
      ORDER BY m.id
      LIMIT 10`,
    [ticketId, sinceId, userId]
  );
  return rows.map((r) => {
    const name = r.author_name || r.author_email || "Someone";
    return {
      id: Number(r.id),
      author_id: r.author_id == null ? null : Number(r.author_id),
      author_name: name,
      initials: presenceInitials(name),
      kind: r.kind,
      from_requester: r.kind === "public" && (r.author_id == null || (r.requester_id != null && Number(r.author_id) === Number(r.requester_id))),
      body: r.body.length > NEWER_BODY_MAX ? `${r.body.slice(0, NEWER_BODY_MAX - 1)}…` : r.body,
      created_at: iso(r.created_at),
    };
  });
}

/**
 * The send guard for a request body carrying `expect_last_message_id`
 * (a message id, or null/0 when the ticket had none the composer knew of)
 * and `force`. Null = go ahead: no expectation sent (older clients, the
 * MCP connector's drafts), `force: true`, or nothing newer by anyone else.
 * Otherwise the 409 to return; nothing has been written.
 */
export async function collisionRefusal(ticketId: number, userId: number, body: Record<string, unknown> | null | undefined): Promise<NextResponse | null> {
  if (!body || !("expect_last_message_id" in body) || body.force === true) return null;
  const raw = body.expect_last_message_id;
  const since = raw === null || raw === undefined ? 0 : Number(raw);
  if (!Number.isSafeInteger(since) || since < 0) return NextResponse.json({ error: "expect_last_message_id is a message id." }, { status: 400 });
  const newer = await newerMessages(ticketId, since, userId);
  if (!newer.length) return null;
  return NextResponse.json({ error: COLLISION_ERROR, newer }, { status: 409 });
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const s = String(v ?? "");
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}
