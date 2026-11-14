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
//   - Exchange always evaluates mail from outside. So once its header is
//     there, the outcome is a pass or a FAILED check, never "no result":
//     results that are all "none" (nothing signed, nothing published) are
//     handed on as "none" verdicts, which the pipeline counts as checked
//     and not passed. "Trust sender addresses without SPF or DKIM results"
//     therefore never applies to them.
//   - dmarc=pass counts only when Exchange names the From domain it
//     evaluated (header.from) and that is the domain the message shows
//     (relaxed alignment). A pass with no readable header.from is not a
//     pass. SPF and DKIM keep their domains for the existing alignment rule.
//   - dmarc=bestguesspass (no DMARC record; it would have passed had there
//     been one) is not a pass. Nor is anything else that is not the word
//     "pass".
//   - compauth (Microsoft's composite result) is read by its word and by
//     its documented three-digit reason code: 000, 001, 002, 010 and 6xx
//     are a fail; 1xx and 7xx a pass; 2xx a soft pass; 3xx, 4xx, 5xx and
//     9xx no check. A fail by either the word or the code is a failed check
//     whatever else passed. A pass or a soft pass on its own is not a pass:
//     it only never makes things worse.
//   - Mail from inside the same organisation has no SPF or DKIM result.
//     Exchange stamps it X-MS-Exchange-Organization-AuthAs: Internal, and
//     its header firewall removes X-MS-Exchange-Organization-* headers from
//     mail that arrives from outside, so that stamp is Exchange's own word.
//     EXACTLY ONE such header saying Internal is a verified sender, unless
//     Exchange's results say otherwise: an SPF verdict of any kind (mail
//     from outside always has one, mail from inside has none), or a failed
//     DMARC or compauth result. X-MS-Exchange-CrossTenant-* headers
//     describe the SENDING organisation and are never read.
//   - No Authentication-Results header at all and no internal stamp: "no
//     result" (unverified unless the admin chose to trust mail without
//     results). This is how internal mail looks when its stamp is missing.
//
// What this trusts: the mailbox. Anyone who can put a finished (non-draft)
// item into the Inbox without going through Exchange transport (a
// full-access delegate, another app with write access, an import) writes
// its headers too, and so can be "verified" as anyone.
//
// The sender is the message's From. Graph's `sender` (the account that
// submitted it, when it differs) stands in only for mail Exchange stamped
// Internal; a message with no SMTP sender address is no mail the pipeline
// could work with (null).
//
// Which address it was sent to. The To and Cc lines of the message itself
// keep what the sender typed (an alias, a plus tag); Graph's typed
// recipients can show the mailbox's main address instead, so they are added
// after. The envelope handed on names only the help addresses of this
// mailbox that To or Cc name; when they name none (Bcc), the mailbox's main
// help address. Team aliases and the address choice of lib/helpdesk/inbound
// therefore never see an address the mail was not sent to.
//
// Meeting invites (calendarPart). Exchange delivers an invite as an
// "eventMessage" with no .ics attachment; the invite is the text/calendar
// part of the message's MIME. It is handed on as a calendar file, exactly as
// the webhook's `calendar` field is, under the same limits.

import { aligned } from "../intake/email-rules";
import { normalizeEmail, parseAddressList, parseGeneric, type InboundAuthFields, type InboundEmail, type InboundFile } from "../inbound-parse";
import { mailboxKey } from "../mailboxes-shared";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What is read first, before anything is downloaded: no body, no attachments. */
export const M365_HEAD_SELECT = "id,internetMessageId,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,isDraft,hasAttachments,parentFolderId,internetMessageHeaders";
export const M365_BODY_SELECT = "id,body";

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
  /** "internal": Exchange says a signed-in sender of the same organisation. "results": Exchange's SPF/DKIM/DMARC. "none": no Authentication-Results header and no internal stamp. */
  kind: "internal" | "results" | "none";
  auth?: InboundAuthFields;
  /** How the headers were read, in one line, for the settings page's diagnostic. Results and counts only: no address, no content. */
  note: string;
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
  /** Microsoft's composite result as classified: its word and its reason code, the worse of the two. */
  compauth: "" | "pass" | "fail" | "softpass" | "none";
  compauthReason: string;
}

/** compauth by Microsoft's documented reason codes (Defender for Office 365, "Composite authentication Reason codes"). */
function compauthClass(result: string, reason: string): ArResults["compauth"] {
  const byCode = !/^\d{3}$/.test(reason)
    ? ""
    : ["000", "001", "002", "010"].includes(reason) || reason[0] === "6"
      ? "fail"
      : reason[0] === "1" || reason[0] === "7"
        ? "pass"
        : reason[0] === "2"
          ? "softpass"
          : "none";
  const byWord = result === "pass" || result === "fail" || result === "softpass" ? result : "none";
  if (byWord === "fail" || byCode === "fail") return "fail";
  // The word and the code agree, or there is no code: the word. Otherwise the weaker of the two.
  if (!byCode || byCode === byWord) return byWord;
  const rank = { none: 0, softpass: 1, pass: 2 } as const;
  return rank[byWord] <= rank[byCode as "none" | "softpass" | "pass"] ? byWord : (byCode as "none" | "softpass" | "pass");
}

/** Exchange Online's Authentication-Results value, read method by method. */
export function parseExchangeResults(value: string): ArResults {
  const out: ArResults = { spf: "", spfDomain: "", dkim: [], dmarc: "", dmarcFrom: "", compauth: "", compauthReason: "" };
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
      out.compauthReason = (seg.match(/\breason\s*=\s*"?(\d{1,6})\b/i)?.[1] ?? "").slice(0, 6);
      out.compauth = compauthClass(result, out.compauthReason);
    }
  }
  return out;
}

const word = (v: string) => v.replace(/[^a-z]/g, "").slice(0, 20) || "none";

/** Microsoft's own word on who sent a message, from its headers in order (top first) and the From address Graph reports. */
export function m365Verdict(headerList: readonly [string, string][], fromEmail: string): M365Verdict {
  const fromDomain = domainOf(fromEmail);
  const authAs = headerList.filter(([k]) => k === "x-ms-exchange-organization-authas").map(([, v]) => v.trim().toLowerCase());
  const all = headerList.filter(([k]) => k === "authentication-results");
  const first = all[0]?.[1] ?? "";
  const r = first ? parseExchangeResults(first) : null;
  const failed = r?.dmarc === "fail" || r?.compauth === "fail";
  const stamp = authAs.length ? `AuthAs stamp: ${authAs.slice(0, 4).map(word).join(", ")}${authAs.length > 1 ? ` (${authAs.length} headers)` : ""}` : "no AuthAs stamp";
  const results = r
    ? `first of ${all.length} Authentication-Results: spf=${word(r.spf)}, dkim=${r.dkim.length ? r.dkim.map((d) => word(d.result)).join("+") : "none"}, dmarc=${word(r.dmarc)}, compauth=${word(r.compauth)}${r.compauthReason ? ` (reason ${r.compauthReason})` : ""}`
    : "no Authentication-Results header";
  const note = `${stamp}; ${results}`;

  if (authAs.length === 1 && authAs[0] === "internal" && !failed && !r?.spf) return { kind: "internal", auth: { dmarc: "pass" }, note };
  if (!r) return { kind: "none", note };

  // Exchange evaluated this mail: every method gets a verdict, "none" where it found nothing, so the outcome is a pass or a failed check.
  const auth: InboundAuthFields = { spf: r.spf || "none" };
  if (r.spfDomain) auth.envelopeFrom = r.spfDomain;
  // "{@example.com : pass, @other.example : fail}", the form the verdict code reads a signing domain from.
  const pairs = r.dkim.filter((d) => d.domain).map((d) => `@${d.domain} : ${d.result}`);
  auth.dkim = pairs.length ? `{${pairs.join(", ")}}` : r.dkim[0]?.result || "none";
  // A pass counts for the From domain Exchange says it evaluated, which must be the one the message shows.
  // Only the words "pass" and "fail" are verdicts; "bestguesspass" and anything else are none.
  auth.dmarc = r.dmarc === "pass" ? (r.dmarcFrom && aligned(r.dmarcFrom, fromDomain) ? "pass" : "none") : r.dmarc === "fail" ? "fail" : "none";
  if (r.compauth === "fail") auth.dmarc = "fail";
  return { kind: "results", auth, note };
}

const address = (v: unknown): { email: string; name: string } | null => {
  const e = obj(obj(v)?.emailAddress);
  // An SMTP address or nothing: an X.500 name or a malformed From is no sender the pipeline could match.
  const email = normalizeEmail(str(e?.address).slice(0, 400));
  return email ? { email, name: str(e?.name).slice(0, 200) } : null;
};
const addresses = (v: unknown): { email: string; name: string }[] => (Array.isArray(v) ? v.slice(0, 100).map(address).filter((a): a is { email: string; name: string } => !!a) : []);

export interface M365MessageMeta {
  id: string;
  receivedAt: string;
  isDraft: boolean;
  hasAttachments: boolean;
  parentFolderId: string;
  /** Exchange's own kind of message for a meeting invite, update or cancellation. */
  isEventMessage: boolean;
}

/** The few fields the intake reads before anything else. Null when the answer is no message. */
export function graphMessageMeta(msg: unknown): M365MessageMeta | null {
  const m = obj(msg);
  const id = str(m?.id);
  if (!m || !id) return null;
  return {
    id,
    receivedAt: str(m.receivedDateTime),
    isDraft: m.isDraft === true,
    hasAttachments: m.hasAttachments === true,
    parentFolderId: str(m.parentFolderId),
    // Graph's own type for it; or, should a $select leave that out, the class Exchange writes into the message's headers.
    isEventMessage: /eventmessage/i.test(str(m["@odata.type"])) || graphHeaderList(m.internetMessageHeaders).some(([k, v]) => k === "content-class" && /calendarmessage/i.test(v)),
  };
}

/**
 * One Graph message as an InboundEmail. `own`: the help addresses that live
 * on the mailbox it was read from, the main one first. `msg` may come
 * without a body (the first, headers-only read). Null when the message has
 * no SMTP sender address.
 */
export function graphMessageToInbound(msg: unknown, files: InboundFile[], own: readonly string[]): { email: InboundEmail; verdict: M365Verdict } | null {
  const m = obj(msg);
  if (!m) return null;
  const headerList = graphHeaderList(m.internetMessageHeaders);
  let from = address(m.from);
  if (!from) {
    // The submitting account stands in only for mail Exchange itself calls internal.
    const sender = address(m.sender);
    if (!sender || m365Verdict(headerList, sender.email).kind !== "internal") return null;
    from = sender;
  }
  const header = (name: string) => headerList.find(([k]) => k === name)?.[1] ?? "";
  const body = obj(m.body);
  const html = str(body?.contentType).toLowerCase() === "html";
  // What the sender typed first (it keeps an alias and a plus tag), then Graph's typed recipients.
  const merge = (typed: { email: string; name: string }[], line: string) => {
    const out = parseAddressList(line.slice(0, 20_000)).slice(0, 100);
    for (const a of typed) if (!out.some((x) => x.email === a.email)) out.push({ email: a.email, name: a.name });
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
  if (!email.from.email) return null;
  const verdict = m365Verdict(headerList, email.from.email);
  const to = merge(addresses(m.toRecipients), header("to"));
  const cc = merge(addresses(m.ccRecipients), header("cc"));
  // The envelope: this mailbox's help addresses that the mail names; none named (Bcc), the mailbox's main one.
  const namedKeys = new Set([...to, ...cc].map((a) => mailboxKey(a.email)));
  const named = own.filter((a) => namedKeys.has(mailboxKey(a)));
  return {
    verdict,
    email: {
      ...email,
      to,
      cc,
      recipients: named.length ? named : own.slice(0, 1),
      auth: verdict.auth,
      // Microsoft's verdict is in `auth`. Nothing else in the headers may count as one.
      headerList: [],
      files,
    },
  };
}

// --- Meeting invites -----------------------------------------------------------------

const decodeQp = (s: string) =>
  Buffer.from(
    s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
    "latin1"
  );

/**
 * The text/calendar part of a message's MIME, decoded, or null. One pass
 * over the text: each "Content-Type: text/calendar" is the header block of a
 * part, whose body runs to the next boundary line. Larger than `maxBytes`
 * (the invite parser's own limit) is not handed on.
 */
export function calendarPart(mime: Buffer, maxBytes: number): Buffer | null {
  const text = mime.toString("latin1");
  let at = 0;
  for (let n = 0; n < 5; n++) {
    const hit = text.slice(at).search(/^content-type:[ \t]*text\/calendar/im);
    if (hit < 0) return null;
    const pos = at + hit;
    at = pos + 20;
    // The part's header block: from the blank line or boundary before it to the blank line after it.
    const before = Math.max(text.lastIndexOf("\n--", pos), text.lastIndexOf("\n\n", pos), text.lastIndexOf("\n\r\n", pos), 0);
    const endMatch = /\r?\n\r?\n/.exec(text.slice(pos));
    if (!endMatch) continue;
    const bodyStart = pos + endMatch.index + endMatch[0].length;
    const headers = text.slice(before, bodyStart).replace(/\r?\n[ \t]+/g, " ");
    const next = text.indexOf("\n--", bodyStart - 1);
    const raw = text.slice(bodyStart, next < 0 ? text.length : next);
    if (raw.length > maxBytes * 2) continue;
    const encoding = (headers.match(/^content-transfer-encoding:[ \t]*([a-z0-9-]+)/im)?.[1] ?? "7bit").toLowerCase();
    const data = encoding === "base64" ? Buffer.from(raw.replace(/[^A-Za-z0-9+/=]/g, ""), "base64") : encoding === "quoted-printable" ? decodeQp(raw) : Buffer.from(raw, "latin1");
    if (data.length > 0 && data.length <= maxBytes) return data;
  }
  return null;
}
