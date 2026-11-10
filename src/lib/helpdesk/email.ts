// Helpdesk outbound email (1.19.0): every hd_* template goes out through
// here, so each mail of a ticket carries the same threading:
//
//   Reply-To     help+hd-<token>@yourcompany.com, when an inbound address is
//                set and inbound email is on (the plus tag survives every
//                provider's routing and every mail client's reply). 1.20.2:
//                the address is the ticket's mailbox (lib/helpdesk/mailboxes)
//   From         1.20.2: mail to the requester and the people copied goes
//                out under the ticket's mailbox: its name, and its address
//                when "send from this address" is on (else the workspace
//                transport's address). No envelope sender is set, so the
//                SMTP MAIL FROM follows the From header and SPF alignment
//                holds either way. A provider that refuses the mailbox's
//                address gets the same mail from the workspace address
//                under the mailbox's name; the refusal is recorded on the
//                mailbox and audited once. Agent-only notices keep the
//                workspace address under the default mailbox's name.
//   Subject      "… [#1047 ref:<token>]" through the template's
//                {{thread_ref}}, appended when an override dropped it
//   Message-ID   <hd.<token>.<random>@domain>, References the ticket's root
//                <hd.<token>.root@domain>, so a reply's In-Reply-To names
//                the ticket even when the client rewrote the subject
//
// The token is hd_tickets.reply_token: 16 random [a-z0-9] characters minted
// on the first mail (ensureReplyToken), unique, never derived from the
// number, so knowing #1047 is not enough to write into it; the inbound side
// still checks the sender may (lib/helpdesk/inbound).
//
// The SMTP transport is the one lib/mailer builds from Settings →
// Notifications; it is built here because helpdesk mail needs headers the
// shared sendMail does not take (Reply-To, Message-ID, References). Tests
// swap the transport with setHelpdeskTransportForTests. Mail is never sent
// while a database client is held: callers run this after their
// transaction. Server-only.

import "server-only";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { getSmtpConfig, smtpConfigured } from "../smtp-config";
import { renderEmail } from "../email-templates";
import { getAppSettings } from "../settings-store";
import { getUserById } from "../db";
import { logEvent } from "../log";
import { hq, hqOne } from "./db-core";
import { getHelpdeskSettings } from "./settings";
import { HD_PRIORITY_LABEL } from "./types";
import type { HdPriority } from "./types";

// --- Tokens and references -------------------------------------------------------

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 16 characters of [a-z0-9] (about 82 bits). */
export function newReplyToken(): string {
  const bytes = randomBytes(16);
  let s = "";
  for (const b of bytes) s += TOKEN_ALPHABET[b % 36];
  return s;
}

/**
 * The ticket's reply token, minting one the first time (one UPDATE that
 * keeps a token another writer set first). Null when the ticket is gone.
 */
export async function ensureReplyToken(ticketId: number): Promise<string | null> {
  const cur = await hqOne<{ reply_token: string | null }>("SELECT reply_token FROM hd_tickets WHERE id = $1", [ticketId]);
  if (!cur) return null;
  if (cur.reply_token) return cur.reply_token;
  for (let i = 0; i < 3; i++) {
    try {
      const row = await hqOne<{ reply_token: string }>(
        "UPDATE hd_tickets SET reply_token = COALESCE(reply_token, $2) WHERE id = $1 RETURNING reply_token",
        [ticketId, newReplyToken()]
      );
      return row?.reply_token ?? null;
    } catch (e) {
      // A unique clash on the token (vanishingly rare): try another.
      if (i === 2) throw e;
    }
  }
  return null;
}

/** "[#1047 ref:k7q2xz9m4pqa1b2c]": the subject's thread reference. */
export function threadRef(number: number, token: string): string {
  return `[#${number} ref:${token}]`;
}

/**
 * The plus-addressed reply address for a ticket: help@x.com becomes
 * help+hd-<token>@x.com. An address that already has a plus tag keeps its
 * local part before the tag. Null when there is no usable address.
 */
export function replyToAddress(inboundAddress: string, token: string): string | null {
  const m = inboundAddress.trim().toLowerCase().match(/^([^\s@+]+)(?:\+[^\s@]*)?@([^\s@]+\.[^\s@]+)$/);
  if (!m) return null;
  return `${m[1]}+hd-${token}@${m[2]}`;
}

function domainOf(address: string): string {
  const m = address.match(/@([A-Za-z0-9.-]+)/);
  return m ? m[1].toLowerCase() : "compassdocs.local";
}

/** The Message-ID of one outbound mail of a ticket, and the root every mail references. */
export function threadMessageIds(token: string, fromAddress: string): { messageId: string; root: string } {
  const domain = domainOf(fromAddress);
  return {
    messageId: `<hd.${token}.${randomBytes(6).toString("hex")}@${domain}>`,
    root: `<hd.${token}.root@${domain}>`,
  };
}

/**
 * The template of the internal-note notice (agent S3): it goes to agents
 * only, so it carries no Reply-To and no subject reference (a reply-all
 * must not land on the public thread), and its own Message-ID shape.
 */
export const HD_NOTE_NOTICE_TEMPLATE = "hd_internal_note";

/**
 * Agent-only notices that go out like the internal-note notice: no Reply-To,
 * no subject reference, a note-notice Message-ID, so an agent's reply to one
 * becomes an internal note and never a public reply to the requester.
 * 1.19.4 (area C6, lib/helpdesk/share): hd_shared, which carries one
 * agent's private message to another.
 */
export const HD_AGENT_ONLY_TEMPLATES: ReadonlySet<string> = new Set([HD_NOTE_NOTICE_TEMPLATE, "hd_shared"]);

/** The Message-ID of an internal-note notice: <hd-note-<token>-<random>@domain>. */
export function noteNoticeMessageId(token: string, fromAddress: string): string {
  return `<hd-note-${token}-${randomBytes(6).toString("hex")}@${domainOf(fromAddress)}>`;
}

/** Whether a Message-ID (with or without angle brackets) is one of our internal-note notices. */
export function isNoteNoticeMessageId(id: string): boolean {
  return /^<?hd-note-/i.test(id.trim());
}

// --- Origin ----------------------------------------------------------------------

let lastOrigin = "";

/** Routes call this with the request's origin so later sweeps can still link (the custom domain wins when set). */
export function rememberOrigin(origin: string | undefined | null): void {
  if (origin && /^https?:\/\/[^/\s]+$/.test(origin)) lastOrigin = origin;
}

/** The links' origin: the one given, else the custom domain, else the last request's, else '' (relative). */
export async function helpdeskOrigin(given?: string | null): Promise<string> {
  if (given) {
    rememberOrigin(given);
    return given;
  }
  try {
    const s = await getAppSettings();
    if (s.custom_domain) return `https://${s.custom_domain}`;
  } catch {
    /* settings unreadable: fall through */
  }
  return lastOrigin;
}

/** Where each audience lands. */
export const hdLinks = {
  request: (number: number) => `/help/requests/${number}`,
  ticket: (number: number) => `/desk/tickets/${number}`,
  approvals: () => "/help/approvals",
  requests: () => "/help/requests",
};

// --- Transport -------------------------------------------------------------------

export interface HelpdeskOutgoingMail {
  to: string;
  /** Comma-separated: the people copied on the request (1.19.1, lib/helpdesk/ccs). */
  cc?: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  messageId?: string;
  references?: string;
  headers: Record<string, string>;
}

export type HelpdeskTransport = (mail: HelpdeskOutgoingMail) => Promise<void>;

let testTransport: HelpdeskTransport | null = null;

/** Tests: capture mail instead of sending it (null restores SMTP). */
export function setHelpdeskTransportForTests(t: HelpdeskTransport | null): void {
  testTransport = t;
}

async function smtpTransport(): Promise<{ send: HelpdeskTransport; from: string } | null> {
  const cfg = await getSmtpConfig();
  if (testTransport) return { send: testTransport, from: cfg.from || "helpdesk@example.test" };
  if (!smtpConfigured(cfg)) return null;
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure === "tls",
    ignoreTLS: cfg.secure === "none",
    requireTLS: cfg.secure === "starttls",
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 8000,
    socketTimeout: 10000,
  });
  return {
    from: cfg.from,
    send: async (m) => {
      await transport.sendMail({
        from: m.from,
        to: m.to,
        cc: m.cc,
        replyTo: m.replyTo,
        subject: m.subject,
        text: m.text,
        html: m.html,
        messageId: m.messageId,
        references: m.references,
        headers: m.headers,
      });
    },
  };
}

/** Whether helpdesk mail can go out at all (SMTP set, or a test transport). */
export async function helpdeskMailReady(): Promise<boolean> {
  if (testTransport) return true;
  return smtpConfigured(await getSmtpConfig());
}

/** A From with the helpdesk's display name over the configured address. */
function fromWithName(configured: string, name: string): string {
  const addr = configured.match(/<([^>]+)>/)?.[1] ?? configured.trim();
  const clean = name.replace(/["\r\n<>]/g, "").trim();
  return clean ? `"${clean}" <${addr}>` : configured;
}

/** The bare address of a configured From ("Name <a@b>" or "a@b"), lower-cased. */
function bareAddress(configured: string): string {
  return (configured.match(/<([^>]+)>/)?.[1] ?? configured).trim().toLowerCase();
}

/** What a mail provider said when it refused a mail, in one line. */
function providerError(e: unknown): string {
  const err = e as { response?: unknown; message?: unknown };
  const text = typeof err?.response === "string" && err.response ? err.response : e instanceof Error ? e.message : String(e);
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

const SENDER_POLICY =
  /sender (?:address |identity |domain )?(?:rejected|denied|refused|not (?:allowed|authori[sz]ed|permitted|verified|owned))|not owned by|send(?:ing)?[ -]?as\b|sendasden|on behalf of|(?:from|sender) (?:address|header|domain|identity|email)|(?:address|domain|identity|sender) (?:is )?not verified|unverified (?:sender|address|domain)|not (?:allowed|authori[sz]ed|permitted) to (?:send|use)|\b5\.7\.60\b|\b5\.2\.252\b/i;

/**
 * Whether a failed send is the mail provider permanently refusing the From
 * address itself: a 5xx answer to MAIL FROM or to DATA, or a 5xx at any
 * step whose text is a sender-policy refusal ("Sender address rejected: not
 * owned by user", "not allowed to send as", "The from address does not
 * match a verified Sender Identity", 5.7.60, SendAsDenied; Postfix reports
 * the sender at RCPT TO). A timeout, a dropped connection, a 4xx "try
 * again" or a refused recipient is not: nothing is known about the address
 * then, and the mail may already have been accepted.
 */
export function isSenderRejection(e: unknown): boolean {
  const err = (e ?? {}) as { responseCode?: unknown; response?: unknown; command?: unknown; message?: unknown };
  const response = typeof err.response === "string" ? err.response : "";
  const message = typeof err.message === "string" ? err.message : "";
  const code =
    typeof err.responseCode === "number"
      ? err.responseCode
      : Number(response.match(/^\s*(\d{3})(?=[ -]|$)/)?.[1] ?? message.match(/(?:^|:\s*)([45]\d{2})[ -]/)?.[1] ?? 0);
  if (!(code >= 500 && code <= 599)) return false;
  const command = typeof err.command === "string" ? err.command.trim().toUpperCase() : "";
  if (command === "MAIL FROM" || command === "DATA") return true;
  return SENDER_POLICY.test(`${response} ${message}`.slice(0, 2000));
}

/**
 * Hand one mail to the transport under a mailbox's own address when it
 * sends from it. A permanent refusal of that address (isSenderRejection)
 * sends the same mail from the workspace address (mail.from) and records
 * the refusal on the mailbox; a refusal of that too throws, as any failed
 * send does. Any other failure throws as it is, with no second send: the
 * first one may have gone through, and the address is not to blame.
 */
async function sendAsMailbox(
  transport: { send: HelpdeskTransport; from: string },
  mail: HelpdeskOutgoingMail,
  who: { mailboxId: number | null; name: string; address: string; sendFrom: boolean; sendFromFailing?: boolean }
): Promise<void> {
  const own = who.sendFrom && who.mailboxId && who.address && who.address !== bareAddress(transport.from) ? fromWithName(who.address, who.name) : null;
  if (!own) {
    await transport.send(mail);
    return;
  }
  try {
    await transport.send({ ...mail, from: own });
  } catch (e) {
    if (!isSenderRejection(e)) throw e;
    await transport.send(mail);
    await (await import("./mailboxes")).recordSendFromFailure(who.mailboxId!, providerError(e)).catch(() => {});
    return;
  }
  if (who.sendFromFailing) await (await import("./mailboxes")).clearSendFromFailure(who.mailboxId!).catch(() => {});
}

/**
 * The Email settings page's "Send test" for one address: a short mail to
 * `to` exactly as a reply would leave (From the address when it sends from
 * it, else the workspace address under its name; Reply-To the address).
 * No fallback here: the provider's refusal is the answer, in its own words.
 * `senderRejected` says the failure was a refusal of the From address
 * (isSenderRejection), the only kind that is kept on the mailbox.
 */
export async function sendMailboxTestMail(
  box: { id: number; address: string; name: string; send_from: boolean },
  to: string
): Promise<{ ok: boolean; from: string; error?: string; senderRejected?: boolean }> {
  const transport = await smtpTransport().catch(() => null);
  if (!transport) return { ok: false, from: "", error: "Outgoing mail isn't set up yet. Add your mail server in Settings, Notifications, Email first." };
  const from = box.send_from ? fromWithName(box.address, box.name) : fromWithName(transport.from, box.name);
  const shown = box.send_from ? box.address : bareAddress(transport.from);
  const line = box.send_from
    ? `This test was sent from ${box.address}. Replies about tickets on this address go out the same way.`
    : `This test was sent from ${shown} under the name "${box.name}". Replies about tickets on ${box.address} go out the same way, and answers come back to ${box.address}.`;
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    await transport.send({
      to,
      from,
      replyTo: box.address,
      subject: `Test from ${box.address}`,
      text: `${line}\n\nIf it reached you, the address is set up. Nothing was added to the desk.`,
      html: `<p>${esc(line)}</p><p>If it reached you, the address is set up. Nothing was added to the desk.</p>`,
      headers: { "Auto-Submitted": "auto-generated", "X-CompassDocs-Helpdesk": "1" },
    });
    return { ok: true, from: shown };
  } catch (e) {
    return { ok: false, from: shown, error: providerError(e), senderRejected: isSenderRejection(e) };
  }
}

// --- Sending ---------------------------------------------------------------------

export interface HelpdeskThread {
  ticketId: number;
  number: number;
  /** The ticket's team: its mail renders with scope "hd_team:<id>" (a team's own header and signature, agent G). */
  teamId?: number | null;
}

/**
 * Render one hd_* template and send it to one address, threaded on the
 * ticket when `thread` is given. `opts.cc` puts the people copied on the
 * request on Cc (public replies only; never an internal-note notice).
 * Answers whether it was handed to SMTP; never throws (a failure is logged).
 */
export async function sendHelpdeskTemplate(
  to: string,
  templateKey: string,
  vars: Record<string, string>,
  thread?: HelpdeskThread | null,
  origin?: string,
  opts: { cc?: string[]; /** "agent": an agent's own notice, which keeps the workspace address and the default mailbox's name (1.20.2). */ audience?: "requester" | "agent" } = {}
): Promise<boolean> {
  const address = to.trim();
  if (!address || !/^[^\s@<>]+@[^\s@<>]+$/.test(address)) return false;
  // 1.19.4 (C7): nothing is sent about a ticket in the recycle bin.
  if (thread && (await (await import("./recycle-bin-guard")).ticketIsBinned({ id: thread.ticketId }))) return false;
  try {
    const transport = await smtpTransport();
    if (!transport) return false;
    const settings = await getHelpdeskSettings();
    const base = await helpdeskOrigin(origin);
    let token: string | null = null;
    const note = HD_AGENT_ONLY_TEMPLATES.has(templateKey);
    const v: Record<string, string> = { ...vars };
    if (thread) {
      token = await ensureReplyToken(thread.ticketId);
      if (token && !note && !("thread_ref" in v)) v.thread_ref = threadRef(thread.number, token);
    }
    if (note) v.thread_ref = "";
    v.thread_ref ??= "";
    // 1.20.2: whose name and address the mail carries. The ticket's mailbox
    // for the requester and the people copied; the default for the rest.
    const who = await (await import("./mailboxes")).outboundIdentity(thread && !note && opts.audience !== "agent" ? thread.ticketId : null);
    // Links in vars are paths; the mail needs them absolute.
    for (const k of Object.keys(v)) if (/_url$/.test(k) && v[k].startsWith("/")) v[k] = `${base}${v[k]}`;
    const cc = note
      ? []
      : [...new Set((opts.cc ?? []).map((a) => a.trim().toLowerCase()))].filter((a) => a !== address.toLowerCase() && /^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(a));
    // The team's own template variant (lib/email-parts), and the recipient:
    // a workspace user's name fills {{recipient_name}}; an outside address
    // gets no "Manage your notifications" link (agent H2). A mail with people
    // on Cc is everyone's copy: no one's name in the greeting and no
    // manage link (1.19.1).
    const scope = thread?.teamId ? `hd_team:${thread.teamId}` : null;
    const rendered = cc.length
      ? await renderEmail(templateKey, v, base, { scope, manageLink: false })
      : await renderEmail(templateKey, v, base, { scope, recipientEmail: address });
    let subject = rendered.subject.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (thread && token && !note && !subject.includes(`ref:${token}`)) subject = `${subject} ${threadRef(thread.number, token)}`;
    const mail: HelpdeskOutgoingMail = {
      to: address,
      from: fromWithName(transport.from, who.name),
      subject: subject.slice(0, 400),
      text: rendered.text,
      html: rendered.html,
      // Our own mail must never open a ticket when it bounces back in.
      headers: { "Auto-Submitted": "auto-generated", "X-CompassDocs-Helpdesk": "1" },
    };
    if (cc.length) mail.cc = cc.slice(0, 50).join(", ");
    if (thread && token && note) {
      // An internal-note notice: grouped under the ticket's root, but no
      // Reply-To and an id of its own, so a reply to it is recognised and
      // kept internal (lib/helpdesk/inbound).
      const root = threadMessageIds(token, transport.from).root;
      mail.messageId = noteNoticeMessageId(token, transport.from);
      mail.references = root;
      mail.headers["In-Reply-To"] = root;
    } else if (thread && token) {
      const ids = threadMessageIds(token, transport.from);
      mail.messageId = ids.messageId;
      mail.references = ids.root;
      mail.headers["In-Reply-To"] = ids.root;
      if (settings.inbound_secret && who.address) {
        const reply = replyToAddress(who.address, token);
        if (reply) mail.replyTo = reply;
      }
    }
    await sendAsMailbox(transport, mail, who);
    return true;
  } catch (e) {
    logEvent("error", "helpdesk.email_failed", { template: templateKey, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

interface TicketVarsRow {
  id: number;
  number: number;
  team_id: number | null;
  subject: string;
  requester_id: number | null;
  requester_name: string;
  priority: HdPriority;
  team_name: string | null;
  assignee_name: string | null;
}

/** The ticket tags every hd_* template shares, for a ticket number. */
export async function ticketTemplateVars(
  number: number,
  audience: "requester" | "agent"
): Promise<{ thread: HelpdeskThread; vars: Record<string, string>; requesterId: number | null } | null> {
  const t = await hqOne<TicketVarsRow>(
    `SELECT t.id, t.number, t.team_id, t.subject, t.requester_id, t.requester_name, t.priority,
            tm.name AS team_name, u.name AS assignee_name
       FROM hd_tickets t
       LEFT JOIN hd_teams tm ON tm.id = t.team_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.number = $1`,
    [number]
  );
  if (!t) return null;
  return {
    thread: { ticketId: t.id, number: t.number, teamId: t.team_id },
    requesterId: t.requester_id,
    vars: {
      ticket_number: String(t.number),
      subject: t.subject,
      requester_name: t.requester_name || "Someone",
      team_name: t.team_name || "The helpdesk",
      priority_label: HD_PRIORITY_LABEL[t.priority] ?? t.priority,
      agent_name: t.assignee_name || "The helpdesk",
      ticket_url: audience === "requester" ? hdLinks.request(t.number) : hdLinks.ticket(t.number),
    },
  };
}

/**
 * Send one hd_* template to a workspace user (agent F's notification
 * preferences call this for the email channel; they have already decided
 * the person wants it). `vars.ticket_number` threads the mail on that
 * ticket and fills the ticket tags the caller left out (subject, team,
 * priority, the link for that audience). Answers whether it went out.
 */
export async function sendHelpdeskEmail(
  userId: number,
  templateKey: string,
  vars: Record<string, string>,
  origin?: string
): Promise<boolean> {
  const user = await getUserById(userId).catch(() => null);
  if (!user || user.status !== "active" || !user.email) return false;
  const number = Number(vars.ticket_number);
  let thread: HelpdeskThread | null = null;
  let merged = { ...vars };
  let forRequester = false;
  if (Number.isInteger(number) && number > 0) {
    const base = await ticketTemplateVars(number, "agent");
    if (base) {
      thread = base.thread;
      // The requester of this ticket follows it in Get help; anyone else in the desk.
      forRequester = base.requesterId === userId && templateKey !== "hd_assigned" && templateKey !== "hd_sla_warning" && templateKey !== "hd_sla_breach";
      const links: Record<string, string> = forRequester ? { ticket_url: hdLinks.request(number) } : {};
      merged = { ...base.vars, ...links, ...vars };
    }
  }
  // The requester's copy goes out under the ticket's mailbox; an agent's notice is unchanged (1.20.2).
  return sendHelpdeskTemplate(user.email, templateKey, merged, thread, origin, { audience: forRequester ? "requester" : "agent" });
}

/** Active users' addresses by id (one query). */
export async function userEmails(ids: number[]): Promise<Map<number, { email: string; name: string }>> {
  const map = new Map<number, { email: string; name: string }>();
  if (!ids.length) return map;
  const rows = await hq<{ id: number; email: string; name: string; username: string }>(
    "SELECT id, email, name, username FROM users WHERE id = ANY($1) AND status = 'active'",
    [ids]
  );
  for (const r of rows) map.set(r.id, { email: r.email, name: r.name || r.username });
  return map;
}
