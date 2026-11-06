// Helpdesk 1.19.2: the customer portal's satisfaction survey and the
// "joined with this one" notice on a kept request (agent W5). Server-only.
//
// Survey. A portal customer is asked "How did we do?" (Good / OK / Not
// good, an optional comment) once their request is solved: on the request
// page in the portal, and in the solved email (hd_solved_csat), whose
// {{csat_block}} for a portal contact carries three links,
// /support/requests/<n>/rate/<rating>/<token>. Opening one signs in first
// when the browser has no portal session (the path survives the sign-in
// link as its `next`), then shows the request with the rating preselected:
// nobody rates from a link alone, and a mail scanner that follows links
// rates nothing. The token is Get help's (lib/helpdesk/csat: an HMAC of
// the number under the ticket's reply token), so a link proves it came from
// that ticket's mail; none is needed from the page itself.
//
// The rating is written to the columns Get help's survey uses, once
// (UPDATE … WHERE csat_score IS NULL), so reports and analytics count it
// unchanged (portal-csat-shared: Good 5, OK 3, Not good 1). Who may rate:
// the ticket's portal contact (its own, or the contact of a portal ticket
// merged into it whose address is the requester's: portal-hooks
// contactForTicket), never a workspace requester's ticket, never a merged
// (joined) request, only while solved or closed, surveys on, the portal open
// and admitting the address, and never a blocked contact (by mailbox).
// A blocked contact gets no survey email either (portalRequesterNotice
// sends them nothing).
//
// Joined notice. On the request a contact's other request was merged into,
// the page lists "Your request #N was joined with this one…" (e3). The
// merged request itself already says "Joined with #N" (1.19.1, F2).

import "server-only";
import { audit } from "../audit";
import { hq, hqOne } from "./db-core";
import { hdRateLimited } from "./access";
import { getHelpdeskSettings } from "./settings";
import { CSAT_COMMENT_MAX, csatToken, verifyCsatToken } from "./csat";
import {
  PORTAL_RATING_LABEL,
  PORTAL_RATING_SCORE,
  PORTAL_RATINGS,
  isPortalRating,
  portalRatePath,
  portalRatingFor,
  type PortalJoinedNotice,
  type PortalRating,
  type PortalSurveyState,
} from "./portal-csat-shared";

export * from "./portal-csat-shared";

/** The actor name of a portal rating's audit row (never the customer's address). */
export const PORTAL_CSAT_ACTOR = "Customer portal";

interface SurveyTicket {
  id: number;
  number: number;
  status: string;
  requester_id: number | null;
  requester_email: string;
  portal_contact_id: number | null;
  merged_into: number | null;
  parent_ticket_id: number | null;
  csat_score: number | null;
  csat_comment: string;
  csat_at: string | null;
  reply_token: string | null;
}

const SURVEY_COLS = `id, number, status, requester_id, requester_email, portal_contact_id, merged_into, parent_ticket_id,
  csat_score, csat_comment, csat_at, reply_token`;

/**
 * The portal contact whose survey this ticket is, when they may be asked:
 * no workspace requester, a contact (portal-hooks contactForTicket), not
 * blocked, and the portal open and admitting the address. Null otherwise.
 */
async function surveyContact(t: Pick<SurveyTicket, "id" | "requester_id" | "requester_email" | "portal_contact_id">): Promise<{ id: number; email: string } | null> {
  if (t.requester_id !== null) return null;
  const hooks = await import("./portal-hooks");
  const c = await hooks.contactForTicket(t);
  if (!c) return null;
  if (await hooks.contactBlocked(c)) return null;
  if (!(await hooks.portalAdmits(c.email))) return null;
  return { id: c.id, email: c.email };
}

/**
 * lib/helpdesk/notify notifySolvedCsat: is this solved ticket's requester a
 * portal contact who gets the survey (by email, with portal links)? Only
 * for top-level, unmerged tickets with no workspace requester.
 */
export async function portalSurveyApplies(ticketId: number): Promise<boolean> {
  const t = await hqOne<SurveyTicket>(`SELECT ${SURVEY_COLS} FROM hd_tickets WHERE id = $1`, [ticketId]);
  if (!t || t.parent_ticket_id || t.merged_into) return false;
  return !!(await surveyContact(t));
}

/**
 * The {{csat_block}} of hd_solved_csat for a portal contact: the question
 * and three links into the portal, as markdown the sender builds (our own
 * URLs and fixed words only). Empty when there is no token.
 */
export async function portalCsatBlock(ticketId: number, base: string): Promise<string> {
  const t = await hqOne<{ number: number }>("SELECT number FROM hd_tickets WHERE id = $1", [ticketId]);
  const token = await csatToken(ticketId);
  if (!t || !token) return "";
  const links = PORTAL_RATINGS.map((r) => `[${PORTAL_RATING_LABEL[r]}](${base}${portalRatePath(t.number, r, token)})`).join(" · ");
  return `**How did we do?** ${links}`;
}

/** What the request page shows of the survey for this contact. */
export async function portalSurveyState(contact: { id: number }, ticketId: number): Promise<PortalSurveyState> {
  const t = await hqOne<SurveyTicket>(`SELECT ${SURVEY_COLS} FROM hd_tickets WHERE id = $1`, [ticketId]);
  const none: PortalSurveyState = { can_rate: false, rated: null };
  if (!t || t.parent_ticket_id || t.merged_into) return none;
  const who = await surveyContact(t);
  if (!who || who.id !== contact.id) return none;
  if (t.csat_score != null) {
    return { can_rate: false, rated: { rating: portalRatingFor(t.csat_score), comment: t.csat_comment ?? "", at: t.csat_at ?? "" } };
  }
  const settings = await getHelpdeskSettings();
  return { can_rate: settings.csat_enabled && (t.status === "solved" || t.status === "closed"), rated: null };
}

export type PortalCsatResult =
  | { ok: true; rating: PortalRating; comment: string; at: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429; error: string };

/**
 * Record a portal contact's rating of their request. `ticketId` is the
 * ticket the contact reaches by that number (portal contactTicket, checked
 * by the caller). A wrong link token is refused; none is fine.
 */
export async function submitPortalCsat(
  contact: { id: number; email: string; name?: string },
  ticketId: number,
  input: { rating: unknown; comment?: unknown; token?: unknown }
): Promise<PortalCsatResult> {
  if (!isPortalRating(input.rating)) return { ok: false, status: 400, error: "Choose Good, OK or Not good." };
  if (input.comment !== undefined && typeof input.comment !== "string") return { ok: false, status: 400, error: "The comment must be text." };
  const comment = String(input.comment ?? "").replace(/\u0000/g, "").trim();
  if (comment.length > CSAT_COMMENT_MAX) return { ok: false, status: 400, error: `Keep the comment under ${CSAT_COMMENT_MAX} characters.` };
  if (hdRateLimited(`portal-csat:${contact.id}`, 10, 60_000)) return { ok: false, status: 429, error: "Too many attempts. Try again in a minute." };
  const t = await hqOne<SurveyTicket>(`SELECT ${SURVEY_COLS} FROM hd_tickets WHERE id = $1`, [ticketId]);
  if (!t || t.parent_ticket_id) return { ok: false, status: 404, error: "Not found." };
  if (t.merged_into) return { ok: false, status: 409, error: "This request was joined with another one. Rate that one instead." };
  const who = await surveyContact(t);
  // Reached as a CC of someone else's request: theirs to rate, not this contact's.
  if (!who || who.id !== contact.id) return { ok: false, status: 403, error: "Only the person who raised this request can rate it." };
  if (input.token !== undefined && input.token !== "" && !verifyCsatToken(t.reply_token, t.number, String(input.token))) {
    return { ok: false, status: 403, error: "This rating link isn't valid for this request." };
  }
  if (!(await getHelpdeskSettings()).csat_enabled) return { ok: false, status: 409, error: "We're not asking for ratings at the moment." };
  if (t.status !== "solved" && t.status !== "closed") return { ok: false, status: 409, error: "You can rate a request once it's solved." };
  if (t.csat_score != null) return { ok: false, status: 409, error: "You've already rated this request. Thank you." };
  const score = PORTAL_RATING_SCORE[input.rating];
  const row = await hqOne<{ csat_comment: string; csat_at: string }>(
    `UPDATE hd_tickets SET csat_score = $2, csat_comment = $3, csat_at = now()
      WHERE id = $1 AND csat_score IS NULL RETURNING csat_comment, csat_at`,
    [t.id, score, comment]
  );
  if (!row) return { ok: false, status: 409, error: "You've already rated this request. Thank you." };
  const name = (contact.name || contact.email).slice(0, 200);
  await hq(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via) VALUES ($1, NULL, $2, $3, 'system', $4, 'system')`,
    [t.id, name, contact.email, `Rated ${PORTAL_RATING_LABEL[input.rating]} (${score} out of 5) in the customer portal`]
  );
  // A ticket's audit row never names the requester (1.19.2 review): the
  // actor is "Customer portal" and the contact is an id in the details,
  // which anonymising drops (lib/helpdesk/retention redactAuditDetails); no
  // address, no IP.
  await audit({
    actor: { name: PORTAL_CSAT_ACTOR },
    action: "helpdesk.portal.csat",
    targetType: "helpdesk_ticket",
    targetId: t.id,
    targetLabel: `#${t.number}`,
    details: { number: t.number, contact_id: contact.id, rating: input.rating, score, comment: comment ? true : false, via: input.token ? "email" : "portal" },
    ip: null,
  });
  return { ok: true, rating: input.rating, comment: row.csat_comment, at: row.csat_at };
}

/**
 * The contact's own requests that were joined with (merged into) this one,
 * newest first: the kept request's "Your request #N was joined with this
 * one" cards. Only the contact's own portal requests, never anyone else's.
 */
export async function portalJoinedNotices(contactId: number, ticketId: number): Promise<PortalJoinedNotice[]> {
  const rows = await hq<{ number: number; at: string }>(
    `SELECT m.number, COALESCE(m.closed_at, m.updated_at) AS at
       FROM hd_tickets m
      WHERE m.merged_into = $2 AND m.portal_contact_id = $1
      ORDER BY COALESCE(m.closed_at, m.updated_at) DESC, m.id DESC LIMIT 20`,
    [contactId, ticketId]
  );
  return rows.map((r) => ({ number: r.number, at: new Date(r.at).toISOString() }));
}
