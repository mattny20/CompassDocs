// Helpdesk 1.20.7: "Send replies through Microsoft 365". A help address that
// lives on a connected mailbox can send its tickets' mail through Microsoft
// Graph as that mailbox (POST /users/{mailbox}/sendMail), so replies appear
// in the mailbox's Sent Items. It is one more choice of "Send replies from"
// (lib/helpdesk/send-addresses): a picked send-from address wins over it,
// and everyone who chose neither keeps the SMTP path exactly as it was.
//
// The message is the same one SMTP would have carried: nodemailer builds
// the MIME (From, To, Cc, Reply-To with the ticket's plus tag, Subject with
// the thread reference, Message-ID, In-Reply-To, References, our own
// X-CompassDocs-Helpdesk and Auto-Submitted) and Graph takes it whole, as
// base64 text. Exchange may give the message a Message-ID of its own; the
// desk's threading does not depend on ours surviving (the reply address and
// the subject reference are read first, lib/helpdesk/inbound-parse
// findReplyToken). From is the help address: when that is an alias,
// Exchange shows the mailbox's main address unless the organisation allows
// sending from aliases.
//
// A refusal from Microsoft (the app may not send as the mailbox, the
// mailbox is gone, the sign-in fails) sends the same mail by SMTP from the
// workspace address instead; the refusal is kept on the help address, shown
// on the Email settings page and audited once per streak, as a refused
// send-from address is. No answer at all (a timeout after the request left)
// throws as any failed send does, with no second send: the first may have
// gone through. Server-only.

import "server-only";
import nodemailer from "nodemailer";
import { audit } from "../../audit";
import { logEvent } from "../../log";
import { hq, hqOne } from "../db-core";
import type { HelpdeskOutgoingMail } from "../email";
import { cleanMailboxAddress } from "../mailboxes-shared";
import { M365Error, graph, m365Token, userPath, type M365Credentials } from "./graph";
import { getM365Config } from "./mail";
import { m365State } from "./state";

/** Graph refuses requests over about 4 MB; the MIME is sent as base64 (4/3 its size). */
export const M365_SEND_MAX_MIME = 2_900_000;

export type M365SendResult = "sent" | "not_chosen" | "refused";

/** The mail as RFC 822 bytes, built by the same library that sends SMTP. */
export async function buildMime(m: HelpdeskOutgoingMail): Promise<Buffer> {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await composer.sendMail({
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
  return info.message as unknown as Buffer;
}

interface Link {
  mailbox_id: number;
  m365_address: string;
  send_error: string;
}

async function recordRefusal(link: Link, helpAddress: string, error: string): Promise<void> {
  const text = error.replace(/\s+/g, " ").trim().slice(0, 500);
  const prev = await hqOne<{ was: string }>(
    `UPDATE hd_m365_links l SET send_error = $2, send_error_at = now(), updated_at = now() FROM (SELECT send_error FROM hd_m365_links WHERE mailbox_id = $1) old
      WHERE l.mailbox_id = $1 RETURNING old.send_error AS was`,
    [link.mailbox_id, text]
  );
  logEvent("warn", "helpdesk.m365_send_refused", { address: helpAddress, mailbox: link.m365_address, error: text });
  if (prev && prev.was === "") {
    await audit({
      actor: { name: "Microsoft 365 mail" },
      action: "helpdesk.m365.send_refused",
      targetType: "helpdesk_mailbox",
      targetId: link.mailbox_id,
      targetLabel: helpAddress,
      details: { address: helpAddress, mailbox: link.m365_address, error: text, fallback: "smtp_workspace_address" },
    });
  }
}

/** What Microsoft said about a send, for the page: a 403 names the role to look at. */
const refusal = (e: M365Error) =>
  e.status === 403 ? "Microsoft 365 did not let the app send mail as this mailbox. Check that the Application Mail.Send role covers it (Limit access on this page)." : e.message;

const quoteName = (name: string, address: string) => {
  const clean = name.replace(/["\r\n<>]/g, "").trim();
  return clean ? `"${clean}" <${address}>` : address;
};

async function credentials(): Promise<M365Credentials> {
  const c = await getM365Config();
  return { tenant: c.tenant, clientId: c.client_id, secret: c.secret };
}

const post = (creds: M365Credentials, link: Link, mime: Buffer) =>
  graph(creds, { method: "POST", path: `${userPath(link.m365_address)}/sendMail`, text: { value: mime.toString("base64"), type: "text/plain" }, what: "send mail as this mailbox" });

/**
 * Send one mail through Graph when its help address chose that. "sent": it
 * is in the mailbox's Sent Items. "not_chosen": nothing was done, SMTP
 * carries it as before. "refused": Microsoft turned it down (recorded); the
 * caller sends it by SMTP from the workspace address.
 */
export async function sendThroughM365(helpMailboxId: number, helpAddress: string, fromName: string, mail: HelpdeskOutgoingMail): Promise<M365SendResult> {
  const state = await m365State();
  if (!state.configured || !state.sendVia.has(helpMailboxId)) return "not_chosen";
  const link = await hqOne<Link>(
    "SELECT l.mailbox_id, l.send_error, m.address AS m365_address FROM hd_m365_links l JOIN hd_m365_mailboxes m ON m.id = l.m365_mailbox_id WHERE l.mailbox_id = $1 AND l.send_via",
    [helpMailboxId]
  );
  const from = cleanMailboxAddress(helpAddress);
  if (!link || !from) return "not_chosen";
  const mime = await buildMime({ ...mail, from: quoteName(fromName, from) });
  if (mime.length > M365_SEND_MAX_MIME) {
    // Not a refusal of the address: this one mail is too large for Graph's request limit.
    logEvent("info", "helpdesk.m365_send_too_large", { address: from, bytes: mime.length });
    return "refused";
  }
  const creds = await credentials();
  try {
    // Signing in comes first and on its own: whatever fails here, nothing was sent yet.
    await m365Token(creds);
  } catch (e) {
    if (!(e instanceof M365Error)) throw e;
    if (e.kind === "auth") await recordRefusal(link, from, e.message).catch(() => {});
    else logEvent("warn", "helpdesk.m365_send_deferred", { address: from, status: e.status });
    return "refused";
  }
  try {
    await post(creds, link, mime);
  } catch (e) {
    if (!(e instanceof M365Error)) throw e;
    // No answer after the request left: unknown whether it was sent.
    if (!e.answered && e.kind !== "blocked") throw e;
    // Busy or broken at Microsoft's end says nothing about the address: SMTP this once, nothing recorded.
    if (e.status === 429 || e.status >= 500) logEvent("warn", "helpdesk.m365_send_deferred", { address: from, status: e.status });
    else await recordRefusal(link, from, refusal(e)).catch(() => {});
    return "refused";
  }
  if (link.send_error) await hq("UPDATE hd_m365_links SET send_error = '', send_error_at = NULL, updated_at = now() WHERE mailbox_id = $1", [helpMailboxId]).catch(() => {});
  return "sent";
}

/**
 * The Email settings page's "Send test" for a help address that sends
 * through Microsoft 365: a short mail to `to`, exactly as a reply would
 * leave. No fallback: Microsoft's refusal is the answer. Null when the
 * address does not send through Microsoft 365 (the SMTP test applies).
 */
export async function sendM365TestMail(box: { id: number; address: string; name: string }, to: string): Promise<{ ok: boolean; from: string; error?: string } | null> {
  const link = await hqOne<Link & { send_address_id: number | null }>(
    `SELECT l.mailbox_id, l.send_error, m.address AS m365_address, b.send_address_id FROM hd_m365_links l JOIN hd_m365_mailboxes m ON m.id = l.m365_mailbox_id
       JOIN hd_mailboxes b ON b.id = l.mailbox_id WHERE l.mailbox_id = $1 AND l.send_via`,
    [box.id]
  );
  if (!link || link.send_address_id) return null;
  const line = `This test was sent through Microsoft 365 as ${link.m365_address}. Replies about tickets on ${box.address} go out the same way and appear in that mailbox's Sent Items.`;
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    const mime = await buildMime({
      to,
      from: quoteName(box.name, box.address),
      replyTo: box.address,
      subject: `Test from ${box.address}`,
      text: `${line}\n\nIf it reached you, the address is set up. Nothing was added to the desk.`,
      html: `<p>${esc(line)}</p><p>If it reached you, the address is set up. Nothing was added to the desk.</p>`,
      headers: { "Auto-Submitted": "auto-generated", "X-CompassDocs-Helpdesk": "1" },
    });
    await post(await credentials(), link, mime);
  } catch (e) {
    const error = e instanceof M365Error ? refusal(e) : "The test could not be sent.";
    if (e instanceof M365Error && e.answered && e.status !== 429 && e.status < 500) await recordRefusal(link, box.address, error).catch(() => {});
    return { ok: false, from: link.m365_address, error };
  }
  if (link.send_error) await hq("UPDATE hd_m365_links SET send_error = '', send_error_at = NULL, updated_at = now() WHERE mailbox_id = $1", [box.id]).catch(() => {});
  return { ok: true, from: link.m365_address };
}
