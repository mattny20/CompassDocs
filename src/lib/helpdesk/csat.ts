// Helpdesk satisfaction survey (1.19.0): one question, a rating from 1 to 5
// and an optional comment, asked once per request when it is solved (and
// CSAT is on in the helpdesk settings).
//
// The solved email (hd_solved_csat) carries five links,
// /help/requests/<n>?rate=<1..5>&t=<token>. The page opens signed in as
// usual (the requester's own session; nobody rates from a link alone), the
// rating preselected, and posts { score, comment, token } to
// POST /api/helpdesk/requests/<n>/csat. The token (an HMAC of the number
// under the ticket's secret reply token) proves the link came from that
// ticket's mail; it is optional for a rating made from the page itself. The
// rating is written by one UPDATE … WHERE csat_score IS NULL, so it is taken
// once, whatever arrives twice. Server-only.

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { hq, hqOne } from "./db-core";
import { ensureReplyToken, hdLinks, helpdeskOrigin } from "./email";
import { getHelpdeskSettings } from "./settings";

export const CSAT_COMMENT_MAX = 2000;

function sign(token: string, number: number): string {
  return createHmac("sha256", token).update(`csat:${number}`).digest("base64url").slice(0, 22);
}

/** The link token for a ticket's survey (mints the reply token when needed). */
export async function csatToken(ticketId: number): Promise<string | null> {
  const t = await hqOne<{ number: number }>("SELECT number FROM hd_tickets WHERE id = $1", [ticketId]);
  if (!t) return null;
  const token = await ensureReplyToken(ticketId);
  return token ? sign(token, t.number) : null;
}

/** Whether `given` is the survey token of this ticket. */
export function verifyCsatToken(replyToken: string | null, number: number, given: string): boolean {
  if (!replyToken || !given) return false;
  const want = Buffer.from(sign(replyToken, number));
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The survey links' path for one score. */
export function csatPath(number: number, score: number, token: string): string {
  return `${hdLinks.request(number)}?rate=${score}&t=${encodeURIComponent(token)}`;
}

/**
 * The {{csat_block}} of hd_solved_csat: the question and five links, as
 * markdown the sender builds (numbers and our own URLs only).
 */
export async function csatBlock(ticketId: number, origin?: string): Promise<string> {
  const t = await hqOne<{ number: number }>("SELECT number FROM hd_tickets WHERE id = $1", [ticketId]);
  const token = await csatToken(ticketId);
  if (!t || !token) return "";
  const base = await helpdeskOrigin(origin);
  const links = [1, 2, 3, 4, 5].map((s) => `[${s}](${base}${csatPath(t.number, s, token)})`).join(" · ");
  return `**How did we do?** Rate it from 1 to 5 (5 is best): ${links}`;
}

export type CsatResult =
  | { ok: true; score: number; comment: string; at: string }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/**
 * Record the requester's rating. Only the ticket's requester, only once,
 * only while it is solved or closed, only with surveys on. A wrong link
 * token is refused; a missing one is fine (the page's own form).
 */
export async function submitCsat(
  user: { id: number; name?: string; username?: string },
  number: number,
  input: { score: unknown; comment?: unknown; token?: unknown }
): Promise<CsatResult> {
  const score = Number(input.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) return { ok: false, status: 400, error: "Choose a rating from 1 to 5." };
  if (input.comment !== undefined && typeof input.comment !== "string") return { ok: false, status: 400, error: "The comment must be text." };
  const comment = String(input.comment ?? "").replace(/\u0000/g, "").trim();
  if (comment.length > CSAT_COMMENT_MAX) return { ok: false, status: 400, error: `Keep the comment under ${CSAT_COMMENT_MAX} characters.` };
  const t = await hqOne<{ id: number; requester_id: number | null; status: string; csat_score: number | null; reply_token: string | null; parent_ticket_id: number | null }>(
    // 1.19.4 (C7): a request in the recycle bin is "not found".
    "SELECT id, requester_id, status, csat_score, reply_token, parent_ticket_id FROM hd_tickets WHERE number = $1 AND deleted_at IS NULL",
    [number]
  );
  // Somebody else's request is "not found", like every requester route.
  if (!t || t.requester_id !== user.id || t.parent_ticket_id) return { ok: false, status: 404, error: "Request not found." };
  if (input.token !== undefined && input.token !== "" && !verifyCsatToken(t.reply_token, number, String(input.token))) {
    return { ok: false, status: 403, error: "This rating link isn't valid for this request." };
  }
  if (!(await getHelpdeskSettings()).csat_enabled) return { ok: false, status: 409, error: "Satisfaction surveys are turned off." };
  if (t.status !== "solved" && t.status !== "closed") return { ok: false, status: 409, error: "You can rate a request once it's solved." };
  if (t.csat_score != null) return { ok: false, status: 409, error: "You've already rated this request." };
  const row = await hqOne<{ csat_score: number; csat_comment: string; csat_at: string }>(
    `UPDATE hd_tickets SET csat_score = $2, csat_comment = $3, csat_at = now()
      WHERE id = $1 AND csat_score IS NULL RETURNING csat_score, csat_comment, csat_at`,
    [t.id, score, comment]
  );
  if (!row) return { ok: false, status: 409, error: "You've already rated this request." };
  const who = user.name || user.username || "The requester";
  await hq(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via) VALUES ($1, $2, $3, 'system', $4, 'system')`,
    [t.id, user.id, who, `Rated ${score} out of 5`]
  );
  return { ok: true, score: row.csat_score, comment: row.csat_comment, at: row.csat_at };
}
