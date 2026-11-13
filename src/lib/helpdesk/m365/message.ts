// Helpdesk 1.20.7: a Microsoft Graph message as the desk's InboundEmail
// (lib/helpdesk/inbound-parse), so every rule of the inbound pipeline
// applies to it unchanged. Pure: no database, no network. Everything in a
// message is the sender's to write, except what Exchange Online adds on the
// way in; this file decides which is which.
//
// Sender verification (m365Verdict). Exchange Online records its own SPF,
// DKIM, DMARC and composite (compauth) results in an Authentication-Results
// header. Transport servers add headers at the top, so Exchange's copy is
// the FIRST Authentication-Results in the list; one a sender wrote into the
// message sits below it and is never read. The results become the
// InboundEmail's out-of-band `auth` fields (which a sender cannot forge),
// and the header list handed to the verdict code is left empty, so nothing
// else in the headers can count as a verdict.
//
//   - dmarc=pass counts only when Exchange evaluated the same From domain
//     the message shows (header.from, relaxed alignment); spf and dkim keep
//     their domains for the existing alignment rule.
//   - compauth=fail (Microsoft's own "this is not who it says") is a failed
//     check whatever else passed.
//   - Mail from inside the same organisation has no SPF or DKIM result.
//     Exchange stamps it X-MS-Exchange-Organization-AuthAs: Internal, and
//     its header firewall removes X-MS-Exchange-Organization-* headers from
//     mail that arrives from outside, so that stamp is Exchange's own word.
//     Exactly one such header saying Internal is a verified sender, unless
//     Exchange's results say otherwise: an SPF verdict of any kind (mail
//     from outside always has one, mail from inside has none), or a failed
//     DMARC or compauth result. So a planted "Internal" on outside mail
//     verifies nothing even if the header firewall were to miss it. Two
//     such headers, or any other value, is not internal either.
//     X-MS-Exchange-CrossTenant-* headers describe the SENDING organisation
//     and are never read.
//   - Results that are all "none" (nothing was signed, nothing published),
//     or no header from Exchange at all: no verdict ("none"), which the
//     pipeline treats as unverified unless the admin chose to trust mail
//     without results.
//
// Which address it was sent to. The To and Cc lines of the message itself
// keep what the sender typed (an alias, a plus tag); Graph's typed
// recipients can show the mailbox's main address instead, so they are added
// after. The help addresses that live on the mailbox the message was read
// from are passed on as the envelope: lib/helpdesk/mailboxes then picks the
// one To or Cc names, else the mailbox's first.

import { aligned } from "../intake/email-rules";
import { parseAddressList, parseGeneric, type InboundAuthFields, type InboundEmail, type InboundFile } from "../inbound-parse";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const M365_MESSAGE_SELECT = "id,internetMessageId,subject,from,sender,toRecipients,ccRecipients,replyTo,body,receivedDateTime,isDraft,hasAttachments,internetMessageHeaders";

const HEADER_CAP = 500;
const VALUE_CAP = 8000;

/** Graph's internetMessageHeaders as [lower-cased name, value] pairs, in the message's order (top first). */
export function graphHeaderList(raw: unknown): [string, string][] {
  const out: [string, string][] = [];
  if (!Array.isArray(raw)) return out;
  for (const h of raw.slice(0, HEADER_CAP)) {
    const o = obj(h);
    const name = str(o?.name).trim().toLowerCase();
    if (!name || name.length > 200) continue;
    out.push([name, str(o?.value).replace(/[\r\n]+/g, " ").slice(0, VALUE_CAP)]);
  }
  return out;
}

export interface M365Verdict {
  /** "internal": Exchange says a signed-in sender of the same organisation. "results": Exchange's SPF/DKIM/DMARC. "none": Exchange said nothing. */
  kind: "internal" | "results" | "none";
  auth?: InboundAuthFields;
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;
const domainOf = (v: string): string => {
  const d = v.trim().toLowerCase().replace(/^.*@/, "").replace(/\.$/, "");
  return DOMAIN.test(d) && d.includes(".") ? d : "";
};

interface ArResults {
  spf: string;
  spfDomain: string;
  dkim: { result: string; domain: string }[];
  dmarc: string;
  dmarcFrom: string;
  compauth: string;
}

/** Exchange Online's Authentication-Results value, read method by method. */
export function parseExchangeResults(value: string): ArResults {
  const out: ArResults = { spf: "", spfDomain: "", dkim: [], dmarc: "", dmarcFrom: "", compauth: "" };
  // Comments ("(sender IP is 203.0.113.9)") carry nothing the verdict needs.
  const text = value.slice(0, 4000).replace(/\([^()]{0,300}\)/g, " ");
  for (const seg of text.split(";").slice(0, 20)) {
    const m = seg.match(/^\s*(spf|dkim|dmarc|compauth)\s*=\s*([a-z]+)/i);
    if (!m) continue;
    const method = m[1].toLowerCase();
    const result = m[2].toLowerCase();
    const prop = (name: string) => seg.match(new RegExp(`\\b${name.replace(".", "\\.")}\\s*=\\s*"?([^\\s;"]{1,255})`, "i"))?.[1] ?? "";
    if (method === "spf" && !out.spf) {
      out.spf = result;
      out.spfDomain = domainOf(prop("smtp.mailfrom") || prop("smtp.helo"));
    } else if (method === "dkim" && out.dkim.length < 8) {
      out.dkim.push({ result, domain: domainOf(prop("header.d") || prop("header.i")) });
    } else if (method === "dmarc" && !out.dmarc) {
      out.dmarc = result;
      out.dmarcFrom = domainOf(prop("header.from"));
    } else if (method === "compauth" && !out.compauth) {
      out.compauth = result;
    }
  }
  return out;
}

/** Microsoft's own word on who sent a message, from its headers in order (top first) and the From address Graph reports. */
export function m365Verdict(headerList: readonly [string, string][], fromEmail: string): M365Verdict {
  const fromDomain = domainOf(fromEmail);
  const authAs = headerList.filter(([k]) => k === "x-ms-exchange-organization-authas").map(([, v]) => v.trim().toLowerCase());
  const first = headerList.find(([k]) => k === "authentication-results")?.[1] ?? "";
  const r = first ? parseExchangeResults(first) : null;
  const failed = r?.dmarc === "fail" || r?.compauth === "fail";

  if (authAs.length === 1 && authAs[0] === "internal" && !failed && !r?.spf) return { kind: "internal", auth: { dmarc: "pass" } };
  if (!r) return { kind: "none" };
  // Nothing passed and nothing failed: Exchange had nothing to check. That is "no result", not a failed one.
  const empty = (v: string) => !v || v === "none";
  if (empty(r.spf) && r.dkim.every((d) => empty(d.result)) && (empty(r.dmarc) || r.dmarc === "bestguesspass") && r.compauth !== "fail") return { kind: "none" };

  const auth: InboundAuthFields = {};
  if (r.spf) {
    auth.spf = r.spf;
    if (r.spfDomain) auth.envelopeFrom = r.spfDomain;
  }
  if (r.dkim.length) {
    // "{@example.com : pass, @other.example : fail}", the form the verdict code reads a signing domain from.
    const pairs = r.dkim.filter((d) => d.domain).map((d) => `@${d.domain} : ${d.result}`);
    auth.dkim = pairs.length ? `{${pairs.join(", ")}}` : r.dkim[0].result;
  }
  if (r.dmarc) {
    // A pass counts for the From domain Exchange evaluated, which must be the one the message shows.
    auth.dmarc = r.dmarc === "pass" && r.dmarcFrom && !aligned(r.dmarcFrom, fromDomain) ? "none" : r.dmarc;
  }
  if (r.compauth === "fail") auth.dmarc = "fail";
  if (!auth.spf && !auth.dkim && !auth.dmarc) return { kind: "none" };
  return { kind: "results", auth };
}

const address = (v: unknown): { email: string; name: string } | null => {
  const e = obj(obj(v)?.emailAddress);
  const email = str(e?.address).trim();
  return email ? { email, name: str(e?.name).slice(0, 200) } : null;
};
const addresses = (v: unknown): { email: string; name: string }[] => (Array.isArray(v) ? v.slice(0, 100).map(address).filter((a): a is { email: string; name: string } => !!a) : []);

export interface M365MessageMeta {
  id: string;
  receivedAt: string;
  isDraft: boolean;
  hasAttachments: boolean;
}

/** The few fields the intake reads before anything else. Null when the answer is no message. */
export function graphMessageMeta(msg: unknown): M365MessageMeta | null {
  const m = obj(msg);
  const id = str(m?.id);
  if (!m || !id) return null;
  return { id, receivedAt: str(m.receivedDateTime), isDraft: m.isDraft === true, hasAttachments: m.hasAttachments === true };
}

/**
 * One Graph message as an InboundEmail. `own`: the help addresses that live
 * on the mailbox it was read from, the main one first. Null when the message
 * has no sender address (nothing the pipeline could work with).
 */
export function graphMessageToInbound(msg: unknown, files: InboundFile[], own: readonly string[]): { email: InboundEmail; verdict: M365Verdict } | null {
  const m = obj(msg);
  if (!m) return null;
  const from = address(m.from) ?? address(m.sender);
  if (!from) return null;
  const headerList = graphHeaderList(m.internetMessageHeaders);
  const header = (name: string) => headerList.find(([k]) => k === name)?.[1] ?? "";
  const body = obj(m.body);
  const html = str(body?.contentType).toLowerCase() === "html";
  // What the sender typed first (it keeps an alias and a plus tag), then Graph's typed recipients.
  const merge = (typed: { email: string; name: string }[], line: string) => {
    const out = parseAddressList(line.slice(0, 20_000)).slice(0, 100);
    for (const a of typed) if (!out.some((x) => x.email === a.email.toLowerCase())) out.push({ email: a.email.toLowerCase(), name: a.name });
    return out;
  };
  const email = parseGeneric({
    from: { email: from.email, name: from.name },
    to: [],
    cc: [],
    subject: str(m.subject),
    text: html ? "" : str(body?.content),
    html: html ? str(body?.content) : "",
    message_id: str(m.internetMessageId) || header("message-id"),
    headers: headerList,
  });
  const verdict = m365Verdict(headerList, email.from.email);
  return {
    verdict,
    email: {
      ...email,
      to: merge(addresses(m.toRecipients), header("to")),
      cc: merge(addresses(m.ccRecipients), header("cc")),
      recipients: [...own],
      auth: verdict.auth,
      // Microsoft's verdict is in `auth`. Nothing else in the headers may count as one.
      headerList: [],
      files,
    },
  };
}
