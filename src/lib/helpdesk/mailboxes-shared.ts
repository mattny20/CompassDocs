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

const DOMAIN_AT = /[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/y;
const LOCAL_CHAR = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/;

/**
 * The email addresses in a piece of text, in order, at most `max`. One pass:
 * each "@" is looked at once, the local part is the run of address
 * characters before it and the domain is matched from it (anchored, labels
 * of at most 63 characters). A sender controls this text (header values), so
 * it must never be searched with an unanchored pattern: `[…]+@…` rescans
 * from every start position, seconds of CPU for a 100 KB value with no "@".
 */
export function scanAddresses(raw: string, max = 1): string[] {
  const out: string[] = [];
  let floor = 0;
  let at = raw.indexOf("@");
  while (at !== -1 && out.length < max) {
    let start = at;
    while (start > floor && LOCAL_CHAR.test(raw[start - 1])) start--;
    if (start < at) {
      DOMAIN_AT.lastIndex = at + 1;
      const m = DOMAIN_AT.exec(raw);
      if (m) {
        out.push(raw.slice(start, at + 1) + m[0]);
        floor = at + 1 + m[0].length;
        at = raw.indexOf("@", floor);
        continue;
      }
    }
    at = raw.indexOf("@", at + 1);
  }
  return out;
}

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
 * into. Anyone who sends the mail can write them too, so they are read only
 * when the provider reports no envelope recipient at all (the address was on
 * Bcc, or the mail was forwarded, and nothing better is known).
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
 * How much of a mail's recipients is read. The sender writes them: a value
 * is cut at `value` characters before it is searched, at most `values`
 * entries of each list (To, Cc, the envelope, one header's lines) are
 * looked at, and at most `addresses` come out of each group.
 */
export const RECIPIENT_LIMITS = { value: 2000, values: 50, addresses: 50 } as const;

/** The distinct addresses (lower-cased, in order) in a list of raw values, within RECIPIENT_LIMITS. */
function addressesOf(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values.slice(0, RECIPIENT_LIMITS.values)) {
    if (out.length >= RECIPIENT_LIMITS.addresses) break;
    const text = (typeof raw === "string" ? raw : String(raw ?? "")).slice(0, RECIPIENT_LIMITS.value);
    for (const m of scanAddresses(text, RECIPIENT_LIMITS.addresses - out.length)) {
      const a = m.toLowerCase();
      if (seen.has(a)) continue;
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

/** The addresses the recipient headers name (RECIPIENT_HEADERS, in that order), within RECIPIENT_LIMITS. */
function headerRecipients(email: MailboxRecipientSource): string[] {
  const out: string[] = [];
  for (const name of RECIPIENT_HEADERS) {
    const values: string[] = [];
    if (email.headerList?.length) {
      for (const [k, v] of email.headerList) {
        if (k === name) values.push(v);
        if (values.length >= RECIPIENT_LIMITS.values) break;
      }
    } else if (email.headers?.[name]) values.push(email.headers[name]);
    for (const a of addressesOf(values)) {
      if (out.length >= RECIPIENT_LIMITS.addresses) return out;
      if (!out.includes(a)) out.push(a);
    }
  }
  return out;
}

/** A mail's recipients by how far each can be trusted (all lower-cased, capped by RECIPIENT_LIMITS). */
export function recipientGroups(email: MailboxRecipientSource): { envelope: string[]; visible: string[]; headers: string[] } {
  const envelope = addressesOf(email.recipients ?? []);
  const visible = addressesOf([...(email.to ?? []).slice(0, RECIPIENT_LIMITS.values), ...(email.cc ?? []).slice(0, RECIPIENT_LIMITS.values)].map((a) => a?.email));
  // Sender-settable: only when the provider says nothing about the envelope.
  return { envelope, visible, headers: envelope.length ? [] : headerRecipients(email) };
}

/**
 * Every address the search reads, in the order it trusts them: the
 * provider's envelope recipients (what the mail was really delivered to),
 * then To (in order) and Cc, then, only when there is no envelope, the
 * recipient headers.
 */
export function recipientCandidates(email: MailboxRecipientSource): string[] {
  const g = recipientGroups(email);
  const out: string[] = [];
  for (const a of [...g.envelope, ...g.visible, ...g.headers]) if (!out.includes(a)) out.push(a);
  return out;
}

/**
 * The listed mailbox an email was sent to, or undefined.
 *
 *   - The provider's envelope recipients come first: a mail delivered to
 *     help@ lands on help@ whatever its To line claims. When the envelope
 *     names several listed addresses, To then Cc pick among those (the
 *     first one written), else the first the envelope names.
 *   - An envelope that names none of ours (the provider's own inbound
 *     address, which every listed address forwards to) says nothing about
 *     which one: To then Cc decide, as they do when there is no envelope.
 *   - The recipient headers (Delivered-To, X-Original-To, …) are read last
 *     and only when the provider gives no envelope recipient at all.
 */
export function mailboxForRecipients<T extends { address: string }>(mailboxes: readonly T[], email: MailboxRecipientSource): T | undefined {
  if (!mailboxes.length) return undefined;
  const g = recipientGroups(email);
  const first = (addresses: readonly string[], among: readonly T[]): T | undefined => {
    for (const a of addresses) {
      const hit = matchMailbox(among, a);
      if (hit) return hit;
    }
    return undefined;
  };
  const named: T[] = [];
  for (const a of g.envelope) {
    const hit = matchMailbox(mailboxes, a);
    if (hit && !named.includes(hit)) named.push(hit);
  }
  if (named.length === 1) return named[0];
  if (named.length > 1) return first(g.visible, named) ?? named[0];
  return first(g.visible, mailboxes) ?? first(g.headers, mailboxes);
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
