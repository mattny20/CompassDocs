// Helpdesk 1.19.1: CCs and followers as the pages see them (agent V3). Pure
// data and helpers, shared by the routes and the desk / Get help clients.
// No server imports here. The server side is lib/helpdesk/ccs.

/** At most this many CCs on one ticket (lib/helpdesk/ccs enforces it). */
export const HD_CC_LIMIT = 20;

/** One CC on a ticket, as a page shows it. */
export interface HdCcView {
  id: number;
  /** A workspace account, or null for an outside address. */
  user_id: number | null;
  name: string;
  /** Agents see every address; requesters and CCs see outside addresses only. */
  email: string;
  outside: boolean;
}

export interface HdFollowerView {
  user_id: number;
  name: string;
}

/** GET /api/helpdesk/tickets/[number]/people: the desk's CC and Following rows. */
export interface HdTicketPeople {
  ccs: HdCcView[];
  followers: HdFollowerView[];
  /** The caller follows the ticket. */
  following: boolean;
  /** Outside addresses may be copied (Desk -> Settings -> Email, outside senders). */
  outside_allowed: boolean;
}

/** GET /api/helpdesk/requests/[number]/ccs: Get help's "People on this request". */
export interface HdRequestPeople {
  ccs: HdCcView[];
  /** The requester may add and remove people; a CC may only leave. */
  can_add: boolean;
  outside_allowed: boolean;
  /** The caller is a CC (not the requester). */
  viewer_is_cc: boolean;
}

/** "Reply to Daniel + 2 CC" (mock-up #3). */
export function replyLabel(firstName: string, ccCount: number): string {
  const base = firstName ? `Reply to ${firstName}` : "Reply";
  return ccCount > 0 ? `${base} + ${ccCount} CC` : base;
}

/** Why a person could not be copied, in words. */
export const HD_CC_SKIP_TEXT: Record<string, string> = {
  not_found: "is not an active account",
  invalid_email: "is not an email address",
  outside_not_allowed: "is outside the workspace, and outside senders are off",
  blocked: "can't be copied on requests",
  own_address: "is one of the helpdesk's own addresses",
  requester: "is the requester",
  already: "is already copied",
  limit: `would go past ${HD_CC_LIMIT} people`,
};

/** A loose client-side check before posting an address (the server checks properly). */
export function looksLikeEmail(v: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v.trim());
}
