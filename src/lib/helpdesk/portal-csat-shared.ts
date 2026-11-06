// Helpdesk 1.19.2: the customer portal's satisfaction survey (agent W5),
// client-safe part. Portal customers answer one question, "How did we do?",
// with Good / OK / Not good and an optional comment. The answer lands in the
// same columns as Get help's 1-to-5 survey (hd_tickets.csat_score,
// csat_comment, csat_at), so reports and analytics count it with no change:
// Good is 5, OK is 3, Not good is 1 (reports call 4 and 5 good).

export const PORTAL_RATINGS = ["good", "ok", "not_good"] as const;
export type PortalRating = (typeof PORTAL_RATINGS)[number];

export const PORTAL_RATING_SCORE: Record<PortalRating, number> = { good: 5, ok: 3, not_good: 1 };
export const PORTAL_RATING_LABEL: Record<PortalRating, string> = { good: "Good", ok: "OK", not_good: "Not good" };

export function isPortalRating(v: unknown): v is PortalRating {
  return typeof v === "string" && (PORTAL_RATINGS as readonly string[]).includes(v);
}

/** The portal's word for a stored 1-to-5 score (a rating given in Get help reads the same way). */
export function portalRatingFor(score: number): PortalRating {
  return score >= 4 ? "good" : score === 3 ? "ok" : "not_good";
}

/** What the request page shows of the survey. */
export interface PortalSurveyState {
  /** The contact may rate it now (solved or closed, surveys on, not rated, theirs). */
  can_rate: boolean;
  /** Their rating, once given. */
  rated: { rating: PortalRating; comment: string; at: string } | null;
}

/** Requests of this contact that were joined with the one they are reading. */
export interface PortalJoinedNotice {
  number: number;
  at: string;
}

/**
 * The rating as the email link's path spells it. No underscores anywhere in
 * the link: the plain-text part of the mail reads "_" as emphasis and drops
 * it (so "not_good" would arrive as "notgood").
 */
export const PORTAL_RATING_SLUG: Record<PortalRating, string> = { good: "good", ok: "ok", not_good: "not-good" };

export function portalRatingFromSlug(slug: string): PortalRating | null {
  return PORTAL_RATINGS.find((r) => PORTAL_RATING_SLUG[r] === slug) ?? null;
}

/** The survey token as hex for the link (the token is base64url, which may hold "_"). */
export function tokenToHex(token: string): string {
  let out = "";
  for (let i = 0; i < token.length; i++) out += token.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

/** Back from the link's hex; null when it isn't a plain-ASCII token. */
export function tokenFromHex(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2}){4,64}$/.test(hex)) return null;
  let out = "";
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return /^[A-Za-z0-9_-]+$/.test(out) ? out : null;
}

/** The email survey link's path for one rating (the page asks to sign in first, then preselects it). */
export function portalRatePath(number: number, rating: PortalRating, token: string): string {
  return `/support/requests/${number}/rate/${PORTAL_RATING_SLUG[rating]}/${tokenToHex(token)}`;
}
