// Helpdesk 1.20.2: several help addresses (mailboxes), the pure half: the
// shapes, the address rules, and working out which listed address an email
// was sent to. No database, no server-only imports (the Email settings page
// and the ticket side panel read the types and limits).
//
// One address matches another when the part before any plus tag and the
// domain are equal, whatever the case: help@x.com, Help@X.com and
// help+hd-<token>@x.com are all the mailbox help@x.com.

export interface HdMailbox {
  id: number;
  /** Lower-cased, no plus tag. */
  address: string;
  /** The From name of mail about its tickets. */
  name: string;
  /** Where new tickets on this address start when nothing else picks a team; null = use routing. */
  team_id: number | null;
  /** Replies go out From this address (the workspace mail provider must allow it). */
  send_from: boolean;
  /** The provider's refusal the last time sending From this address failed; '' = none. */
  send_from_error: string;
  send_from_error_at: string | null;
  is_default: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

/** A mailbox as the Email settings page lists it. */
export interface HdMailboxView extends HdMailbox {
  team_name: string | null;
  /** Tickets that carry this address (live and binned). */
  tickets: number;
}

/** What a ticket shows and the API returns: the address it came in on / is answered from. */
export interface HdTicketMailbox {
  id: number;
  address: string;
  name: string;
}

/** An entry of the ticket's "Answer from" choice. */
export interface HdMailboxOption extends HdTicketMailbox {
  is_default: boolean;
  send_from: boolean;
}

export const MAILBOX_LIMITS = { address: 200, name: 80, mailboxes: 50, error: 500 } as const;

const ADDRESS_RE = /^[a-z0-9.!#$%&'*/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * A mailbox address as stored: trimmed and lower-cased. Null when it is not
 * one address, is too long, or carries a plus tag (the desk adds its own
 * tag to each ticket's reply address, so a tagged address could never be
 * told apart from a reply).
 */
export function cleanMailboxAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const a = raw.trim().toLowerCase();
  if (!a || a.length > MAILBOX_LIMITS.address || !ADDRESS_RE.test(a)) return null;
  return a;
}

/** Why an address typed into the form is refused ('' = fine). The API answers the same sentences. */
export function mailboxAddressProblem(raw: string): string {
  const a = raw.trim();
  if (!a) return "Enter the address people write to.";
  if (a.length > MAILBOX_LIMITS.address) return `Keep the address under ${MAILBOX_LIMITS.address} characters.`;
  if (a.includes("+")) return "Leave out the + tag: the desk adds its own to each ticket's reply address.";
  if (!cleanMailboxAddress(a)) return "That is not an email address.";
  return "";
}

/** A From name as stored: no quotes, angle brackets or line breaks, at most 80 characters. */
export function cleanMailboxName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/["\r\n<>]/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, MAILBOX_LIMITS.name) : "";
}

const FIND_ADDRESS = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g;

/** "local@domain" without the plus tag, lower-cased; '' when the value is no address. */
export function mailboxKey(address: string): string {
  const a = (address ?? "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at <= 0 || at === a.length - 1) return "";
  const local = a.slice(0, at).split("+")[0];
  return local ? `${local}@${a.slice(at + 1)}` : "";
}

/** The listed mailbox an address belongs to (plus-tagged forms included). */
export function matchMailbox<T extends { address: string }>(mailboxes: readonly T[], address: string): T | undefined {
  const key = mailboxKey(address);
  if (!key) return undefined;
  return mailboxes.find((m) => mailboxKey(m.address) === key);
}

/** Whether an address is one of ours: a listed mailbox, or any ticket reply address (…+hd-<token>@…). */
export function isOwnMailboxAddress(mailboxes: readonly { address: string }[], address: string): boolean {
  const a = (address ?? "").trim().toLowerCase();
  if (!a) return false;
  return /\+hd-[a-z0-9]{16}@/.test(a) || !!matchMailbox(mailboxes, a);
}

/** The part of an inbound email the recipient search reads (lib/helpdesk/inbound-parse InboundEmail). */
export interface MailboxRecipientSource {
  to: { email: string }[];
  cc: { email: string }[];
  /** Envelope recipients (SendGrid envelope.to, Mailgun recipient, Postmark OriginalRecipient, generic recipients). */
  recipients: string[];
  headers?: Record<string, string>;
  headerList?: [string, string][];
}

/**
 * Headers a receiving or forwarding server writes the envelope recipient
 * into. Read after To, Cc and the provider's own envelope fields: they are
 * what is left when the address was on Bcc or the mail was forwarded.
 */
const RECIPIENT_HEADERS = [
  "delivered-to",
  "x-original-to",
  "envelope-to",
  "x-envelope-to",
  "x-forwarded-to",
  "x-forwarded-for",
  "x-rcpt-to",
  "original-recipient",
  "x-original-recipient",
] as const;

/**
 * Every address the email was sent to, most telling first: To (in order),
 * Cc, the provider's envelope recipients, then the recipient headers. The
 * order is the same for each copy of one message, so a mail to two listed
 * addresses lands on the same mailbox whichever copy arrives first.
 */
export function recipientCandidates(email: MailboxRecipientSource): string[] {
  const out: string[] = [];
  const add = (raw: unknown) => {
    for (const m of String(raw ?? "").match(FIND_ADDRESS) ?? []) {
      const a = m.toLowerCase();
      if (!out.includes(a)) out.push(a);
    }
  };
  for (const a of email.to ?? []) add(a.email);
  for (const a of email.cc ?? []) add(a.email);
  for (const a of email.recipients ?? []) add(a);
  for (const name of RECIPIENT_HEADERS) {
    if (email.headerList?.length) {
      for (const [k, v] of email.headerList) if (k === name) add(v);
    } else if (email.headers?.[name]) add(email.headers[name]);
  }
  return out;
}

/** The listed mailbox an email was sent to (the first candidate that is one), or undefined. */
export function mailboxForRecipients<T extends { address: string }>(mailboxes: readonly T[], email: MailboxRecipientSource): T | undefined {
  if (!mailboxes.length) return undefined;
  for (const a of recipientCandidates(email)) {
    const hit = matchMailbox(mailboxes, a);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The mailbox a ticket's mail goes out under: its own, else the first
 * mapped to its team, else the default. Undefined when none is listed (the
 * old single-address settings then apply, lib/helpdesk/mailboxes).
 */
export function mailboxForTicket<T extends { id: number; team_id: number | null; is_default: boolean }>(
  mailboxes: readonly T[],
  ticket: { mailbox_id?: number | null; team_id?: number | null }
): T | undefined {
  if (!mailboxes.length) return undefined;
  const own = ticket.mailbox_id ? mailboxes.find((m) => m.id === ticket.mailbox_id) : undefined;
  if (own) return own;
  const team = ticket.team_id ? mailboxes.find((m) => m.team_id === ticket.team_id) : undefined;
  return team ?? mailboxes.find((m) => m.is_default) ?? mailboxes[0];
}
