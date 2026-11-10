// Helpdesk inbound email, the pure half (1.19.0): turn what an email
// provider POSTs into one InboundEmail, whatever the provider, and turn an
// email's body into text the desk can show safely. No database, no network:
// lib/helpdesk/inbound does the rest (sender matching, threading, tickets).
//
// Four shapes are understood, picked by `?provider=` or recognised by their
// fields:
//   generic   JSON { from, to, cc, subject, text, html, message_id,
//             in_reply_to, references, headers, attachments: [{ filename,
//             content_type, content (base64) }] }
//   postmark  Postmark's inbound webhook JSON (FromFull, ToFull, TextBody,
//             HtmlBody, Headers [{Name, Value}], Attachments [{Name,
//             Content, ContentType}])
//   sendgrid  SendGrid Inbound Parse, multipart/form-data, NOT the "raw"
//             option (from, to, cc, subject, text, html, headers, envelope,
//             attachment-info, files attachment1..N)
//   mailgun   a Mailgun route's forward(), multipart/form-data or urlencoded
//             (sender, from, recipient, subject, body-plain, body-html,
//             stripped-text, Message-Id, In-Reply-To, References,
//             message-headers, files attachment-1..N)
//
// The email's HTML is never stored or rendered: it is walked as a tree and
// written out as text (lists, line breaks and link targets kept, scripts,
// styles and images dropped), then escaped so the desk's markdown renderer
// shows it as the characters it is. A reply's quoted history is cut off
// before it reaches the ticket.

import { unified } from "unified";
import rehypeParse from "rehype-parse";
import { scanAddresses } from "./mailboxes-shared";

export const INBOUND_PROVIDERS = ["generic", "postmark", "sendgrid", "mailgun"] as const;
export type InboundProvider = (typeof INBOUND_PROVIDERS)[number];

export interface InboundAddress {
  email: string;
  name: string;
}

export interface InboundFile {
  name: string;
  /** What the provider claimed; never trusted for serving (lib/helpdesk/inbound decides the type). */
  type: string;
  data: Buffer;
}

export interface InboundEmail {
  provider: InboundProvider;
  from: InboundAddress;
  to: InboundAddress[];
  cc: InboundAddress[];
  /** Envelope recipients when the provider gives them (SendGrid envelope, Mailgun recipient, Postmark OriginalRecipient). */
  recipients: string[];
  subject: string;
  text: string;
  html: string;
  /** The provider's own reply-only text, when it computes one (Postmark StrippedTextReply, Mailgun stripped-text). */
  stripped: string;
  /** The Message-ID header without angle brackets; '' when absent. */
  messageId: string;
  inReplyTo: string;
  references: string[];
  /** Lower-cased header name -> value (the last one wins). */
  headers: Record<string, string>;
  /**
   * Every header in the order the message carries them (top first, the
   * receiving provider's own trace headers above the sender's), names
   * lower-cased. Sender authentication reads this, never `headers`: a
   * sender can add a second Authentication-Results below the real one.
   * Absent when the email was built by hand (tests).
   */
  headerList?: [string, string][];
  /**
   * The provider's own sender-authentication verdicts, sent beside the
   * message rather than inside it (SendGrid's SPF and dkim fields, the
   * generic JSON's spf / dkim / dmarc fields), and the envelope sender
   * (MAIL FROM) SPF was checked against. A sender cannot forge these.
   */
  auth?: InboundAuthFields;
  files: InboundFile[];
}

export interface InboundAuthFields {
  spf?: string;
  /** "pass", or SendGrid's "{@example.com : pass}" (one entry per signature). */
  dkim?: string;
  dmarc?: string;
  /** The SMTP envelope sender (MAIL FROM), for SPF alignment. */
  envelopeFrom?: string;
}

/** Request bodies above this are refused before they are read (413). */
export const INBOUND_MAX_BODY_BYTES = 40 * 1024 * 1024;
/** A subject longer than this is cut. */
export const INBOUND_MAX_SUBJECT = 300;
/** A body longer than this (characters, after conversion) is cut with a note. */
export const INBOUND_MAX_TEXT = 60_000;

// --- Addresses -------------------------------------------------------------------

/**
 * A lower-cased bare address (the first one in the value), or '' when the
 * value holds none. The value is a sender's (From, To, Cc, the envelope
 * fields) and may be very long: scanAddresses reads it in one pass (1.20.2;
 * the unanchored pattern used before took seconds on a 100 KB value).
 */
export function normalizeEmail(raw: unknown): string {
  const m = scanAddresses(String(raw ?? ""), 1)[0];
  return m ? m.toLowerCase() : "";
}

/** "Priya Shah <priya@example.com>" -> { email, name }. */
export function parseAddress(raw: unknown): InboundAddress {
  const s = String(raw ?? "").trim();
  const email = normalizeEmail(s);
  let name = "";
  const angle = s.indexOf("<");
  if (angle > 0) name = s.slice(0, angle).trim();
  name = name.replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
  if (name.toLowerCase() === email) name = "";
  return { email, name: name.slice(0, 200) };
}

/** A comma-separated header value (quoted names may hold commas). */
export function parseAddressList(raw: unknown): InboundAddress[] {
  if (Array.isArray(raw)) return raw.flatMap((v) => (typeof v === "object" && v ? [fromObject(v)] : parseAddressList(v))).filter((a) => a.email);
  const s = String(raw ?? "");
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    else if (c === "<") angle = true;
    else if (c === ">") angle = false;
    if (c === "," && !quoted && !angle) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts.map(parseAddress).filter((a) => a.email);
}

function fromObject(v: Record<string, unknown>): InboundAddress {
  const email = normalizeEmail(v.email ?? v.Email ?? v.address ?? "");
  const name = String(v.name ?? v.Name ?? "").trim().slice(0, 200);
  return { email, name: name.toLowerCase() === email ? "" : name };
}

// --- Headers ---------------------------------------------------------------------

/** A raw header block (SendGrid's `headers`), unfolded, as lower-cased name -> value. */
export function parseRawHeaders(raw: string): Record<string, string> {
  return Object.fromEntries(parseRawHeaderList(raw));
}

/** A raw header block, unfolded, as [lower-cased name, value] pairs in order (top first). */
export function parseRawHeaderList(raw: string): [string, string][] {
  const out: [string, string][] = [];
  const unfolded = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
    if (out.length >= 500) break;
  }
  return out;
}

const listToMap = (list: [string, string][]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of list) out[k] = v;
  return out;
};

/** The generic JSON's out-of-band verdicts (top level, or under `auth`). */
function genericAuth(body: Record<string, unknown>): InboundAuthFields | undefined {
  const a = body.auth && typeof body.auth === "object" && !Array.isArray(body.auth) ? (body.auth as Record<string, unknown>) : body;
  const out: InboundAuthFields = {};
  for (const k of ["spf", "dkim", "dmarc"] as const) if (typeof a[k] === "string" && a[k]) out[k] = (a[k] as string).slice(0, 500);
  const env = a.envelope_from ?? body.envelope_from;
  if (typeof env === "string" && env) out.envelopeFrom = normalizeEmail(env) || env.slice(0, 320);
  return Object.keys(out).length ? out : undefined;
}

/** "<a@b> <c@d>" -> ["a@b", "c@d"]. */
export function parseMessageIds(raw: unknown): string[] {
  const s = String(raw ?? "");
  const ids = [...s.matchAll(/<([^<>\s]{1,500})>/g)].map((m) => m[1]);
  if (ids.length) return ids;
  const bare = s.trim();
  return bare && !/\s/.test(bare) ? [bare.slice(0, 500)] : [];
}

const firstId = (raw: unknown) => parseMessageIds(raw)[0] ?? "";

// --- Providers -------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function b64(v: unknown): Buffer {
  try {
    return Buffer.from(str(v).replace(/\s+/g, ""), "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function finish(e: Omit<InboundEmail, "subject"> & { subject: string }): InboundEmail {
  return {
    ...e,
    subject: e.subject.replace(/[\r\n\t]+/g, " ").trim().slice(0, INBOUND_MAX_SUBJECT),
    references: e.references.slice(0, 50),
  };
}

export function parseGeneric(body: Record<string, unknown>): InboundEmail {
  // Headers as a raw block, as [{name, value}] / [name, value] pairs (in
  // order), or as an object (a value may be a list, top first).
  let headerList: [string, string][] = [];
  const h = body.headers;
  if (typeof h === "string") headerList = parseRawHeaderList(h);
  else if (Array.isArray(h)) {
    for (const e of h.slice(0, 500)) {
      if (Array.isArray(e) && e.length >= 2) headerList.push([str(e[0]).toLowerCase(), str(e[1])]);
      else if (e && typeof e === "object") {
        const o = e as Record<string, unknown>;
        if (o.name ?? o.Name) headerList.push([str(o.name ?? o.Name).toLowerCase(), str(o.value ?? o.Value)]);
      }
    }
  } else if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      for (const one of Array.isArray(v) ? v : [v]) headerList.push([k.toLowerCase(), str(one)]);
    }
  }
  const headers = listToMap(headerList);
  const from = typeof body.from === "object" && body.from ? fromObject(body.from as Record<string, unknown>) : parseAddress(body.from);
  const files: InboundFile[] = Array.isArray(body.attachments)
    ? (body.attachments as Record<string, unknown>[])
        .filter((a) => a && typeof a === "object")
        .map((a) => ({
          name: str(a.filename ?? a.name),
          type: str(a.content_type ?? a.type ?? a.contentType),
          data: b64(a.content ?? a.data),
        }))
    : [];
  return finish({
    provider: "generic",
    from,
    to: parseAddressList(body.to),
    cc: parseAddressList(body.cc),
    recipients: parseAddressList(body.recipients ?? body.envelope_to ?? "").map((a) => a.email),
    subject: str(body.subject),
    text: str(body.text ?? body.body_text ?? body.plain),
    html: str(body.html ?? body.body_html),
    stripped: str(body.stripped_text),
    messageId: firstId(body.message_id ?? headers["message-id"]),
    inReplyTo: firstId(body.in_reply_to ?? headers["in-reply-to"]),
    references: parseMessageIds(body.references ?? headers["references"]),
    headers,
    headerList,
    auth: genericAuth(body),
    files,
  });
}

export function parsePostmark(body: Record<string, unknown>): InboundEmail {
  const headerList: [string, string][] = [];
  if (Array.isArray(body.Headers)) {
    for (const h of (body.Headers as { Name?: unknown; Value?: unknown }[]).slice(0, 500)) {
      if (h && h.Name) headerList.push([str(h.Name).toLowerCase(), str(h.Value)]);
    }
  }
  const headers = listToMap(headerList);
  const from = body.FromFull && typeof body.FromFull === "object"
    ? fromObject(body.FromFull as Record<string, unknown>)
    : parseAddress(body.FromName ? `${str(body.FromName)} <${str(body.From)}>` : body.From);
  const list = (full: unknown, plain: unknown) =>
    Array.isArray(full) ? (full as Record<string, unknown>[]).map(fromObject).filter((a) => a.email) : parseAddressList(plain);
  const files: InboundFile[] = Array.isArray(body.Attachments)
    ? (body.Attachments as Record<string, unknown>[]).map((a) => ({ name: str(a.Name), type: str(a.ContentType), data: b64(a.Content) }))
    : [];
  return finish({
    provider: "postmark",
    from,
    to: list(body.ToFull, body.To),
    cc: list(body.CcFull, body.Cc),
    recipients: [normalizeEmail(body.OriginalRecipient)].filter(Boolean),
    subject: str(body.Subject),
    text: str(body.TextBody),
    html: str(body.HtmlBody),
    stripped: str(body.StrippedTextReply),
    // Postmark's MessageID is its own id; the header is the one replies cite.
    messageId: firstId(headers["message-id"]) || str(body.MessageID),
    inReplyTo: firstId(headers["in-reply-to"]),
    references: parseMessageIds(headers["references"]),
    headers,
    headerList,
    files,
  });
}

async function formFiles(form: FormData, names: string[]): Promise<InboundFile[]> {
  const out: InboundFile[] = [];
  for (const n of names) {
    const f = form.get(n);
    if (f && typeof f === "object" && "arrayBuffer" in f) {
      const file = f as File;
      out.push({ name: file.name || n, type: file.type || "", data: Buffer.from(await file.arrayBuffer()) });
    }
  }
  return out;
}

const formStr = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};

export async function parseSendgrid(form: FormData): Promise<InboundEmail> {
  const headerList = parseRawHeaderList(formStr(form, "headers"));
  const headers = listToMap(headerList);
  let envelope: { to?: unknown; from?: unknown } = {};
  try {
    envelope = JSON.parse(formStr(form, "envelope") || "{}");
  } catch {
    /* no envelope */
  }
  let info: Record<string, { filename?: string; name?: string; type?: string }> = {};
  try {
    info = JSON.parse(formStr(form, "attachment-info") || "{}");
  } catch {
    /* no info */
  }
  const count = Number(formStr(form, "attachments")) || 0;
  const names = Object.keys(info).length ? Object.keys(info) : Array.from({ length: Math.min(count, 50) }, (_, i) => `attachment${i + 1}`);
  const files = (await formFiles(form, names)).map((f, i) => {
    const meta = info[names[i]] ?? {};
    return { ...f, name: meta.filename || meta.name || f.name, type: meta.type || f.type };
  });
  return finish({
    provider: "sendgrid",
    from: parseAddress(formStr(form, "from")),
    // SendGrid's sender checks arrive as fields beside the message, which a
    // sender cannot write (lib/helpdesk/intake/email-rules reads them).
    auth: {
      ...(formStr(form, "SPF") ? { spf: formStr(form, "SPF").slice(0, 500) } : {}),
      ...(formStr(form, "dkim") ? { dkim: formStr(form, "dkim").slice(0, 2000) } : {}),
      ...(normalizeEmail(envelope.from) ? { envelopeFrom: normalizeEmail(envelope.from) } : {}),
    },
    to: parseAddressList(formStr(form, "to")),
    cc: parseAddressList(formStr(form, "cc")),
    recipients: (Array.isArray(envelope.to) ? envelope.to : [envelope.to]).map(normalizeEmail).filter(Boolean),
    subject: formStr(form, "subject"),
    text: formStr(form, "text"),
    html: formStr(form, "html"),
    stripped: "",
    messageId: firstId(headers["message-id"]),
    inReplyTo: firstId(headers["in-reply-to"]),
    references: parseMessageIds(headers["references"]),
    headers,
    headerList,
    files,
  });
}

export async function parseMailgun(form: FormData): Promise<InboundEmail> {
  const headerList: [string, string][] = [];
  try {
    const list = JSON.parse(formStr(form, "message-headers") || "[]");
    if (Array.isArray(list)) for (const pair of list.slice(0, 500)) if (Array.isArray(pair) && pair.length >= 2) headerList.push([str(pair[0]).toLowerCase(), str(pair[1])]);
  } catch {
    /* no header list */
  }
  const headers = listToMap(headerList);
  const count = Math.min(Number(formStr(form, "attachment-count")) || 0, 50);
  const files = await formFiles(form, Array.from({ length: count }, (_, i) => `attachment-${i + 1}`));
  return finish({
    provider: "mailgun",
    from: parseAddress(formStr(form, "from") || formStr(form, "sender")),
    // Mailgun's `sender` is the envelope sender its SPF check used.
    auth: normalizeEmail(formStr(form, "sender")) ? { envelopeFrom: normalizeEmail(formStr(form, "sender")) } : undefined,
    to: parseAddressList(formStr(form, "To") || headers["to"] || formStr(form, "recipient")),
    cc: parseAddressList(formStr(form, "Cc") || headers["cc"] || ""),
    recipients: parseAddressList(formStr(form, "recipient")).map((a) => a.email),
    subject: formStr(form, "subject") || headers["subject"] || "",
    text: formStr(form, "body-plain"),
    html: formStr(form, "body-html"),
    stripped: formStr(form, "stripped-text"),
    messageId: firstId(formStr(form, "Message-Id") || headers["message-id"]),
    inReplyTo: firstId(formStr(form, "In-Reply-To") || headers["in-reply-to"]),
    references: parseMessageIds(formStr(form, "References") || headers["references"]),
    headers,
    headerList,
    files,
  });
}

/** Which provider a JSON body came from. */
export function detectJsonProvider(body: Record<string, unknown>): InboundProvider {
  return "FromFull" in body || "TextBody" in body || "HtmlBody" in body || "MessageStream" in body ? "postmark" : "generic";
}

/** Which provider a form body came from. */
export function detectFormProvider(form: FormData): InboundProvider {
  if (form.has("body-plain") || form.has("message-headers") || form.has("stripped-text") || form.has("recipient")) return "mailgun";
  return "sendgrid";
}

/**
 * Read one provider POST. `hint` is the `?provider=` the admin put on the
 * URL ('' = recognise it). Throws InboundParseError on a body that is no
 * email at all.
 */
export async function parseInboundRequest(req: Request, hint = "", maxBytes = INBOUND_MAX_BODY_BYTES): Promise<InboundEmail> {
  const type = (req.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("application/json") && !type.includes("multipart/form-data") && !type.includes("application/x-www-form-urlencoded")) {
    throw new InboundParseError("Unsupported content type: send JSON or form data.");
  }
  // Read through a byte cap whatever the framing (a chunked body has no
  // Content-Length), then parse the buffered bytes.
  const bytes = await readCappedBody(req, maxBytes);
  req = new Request(req.url, { method: "POST", headers: { "content-type": req.headers.get("content-type") ?? "" }, body: new Uint8Array(bytes) });
  const wanted = (INBOUND_PROVIDERS as readonly string[]).includes(hint) ? (hint as InboundProvider) : null;
  let email: InboundEmail;
  if (type.includes("application/json")) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new InboundParseError("The body is not valid JSON.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new InboundParseError("Expected a JSON object.");
    const provider = wanted === "postmark" || wanted === "generic" ? wanted : detectJsonProvider(body as Record<string, unknown>);
    email = provider === "postmark" ? parsePostmark(body as Record<string, unknown>) : parseGeneric(body as Record<string, unknown>);
  } else if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new InboundParseError("The form body could not be read.");
    }
    const provider = wanted === "sendgrid" || wanted === "mailgun" ? wanted : detectFormProvider(form);
    email = provider === "mailgun" ? await parseMailgun(form) : await parseSendgrid(form);
  } else {
    throw new InboundParseError("Unsupported content type: send JSON or form data.");
  }
  if (!email.from.email) throw new InboundParseError("The email has no sender address.");
  return email;
}

export class InboundParseError extends Error {}
/** The body went over the cap while it was read (413). */
export class InboundTooLargeError extends Error {}

/** The request body as bytes, refusing more than `max` however it is framed. */
export async function readCappedBody(req: Request, max: number): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > max) throw new InboundTooLargeError("The message is too large.");
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new InboundTooLargeError("The message is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// --- Mail that must not open a ticket --------------------------------------------

/**
 * Auto-replies, bounces and list traffic: answering them is how two
 * helpdesks mail each other forever (RFC 3834 Auto-Submitted, the common
 * Precedence / X-Autoreply markers, and mailer-daemon senders).
 */
export function isAutoGenerated(email: InboundEmail): boolean {
  const h = email.headers;
  const auto = (h["auto-submitted"] || "").toLowerCase();
  if (auto && auto !== "no") return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test((h["precedence"] || "").trim())) return true;
  if (h["x-autoreply"] || h["x-autorespond"] || h["x-auto-response-suppress"]?.match(/\b(all|oof|autoreply)\b/i)) return true;
  if (h["list-id"] || h["list-unsubscribe"]) return true;
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(email.from.email)) return true;
  return false;
}

// --- Reply tokens ----------------------------------------------------------------

/** A ticket's reply token: 16 characters of [a-z0-9] (lib/helpdesk/email mints them). */
export const REPLY_TOKEN_RE = /^[a-z0-9]{16}$/;

/**
 * The reply token a reply carries, looked for in this order: the plus tag of
 * any recipient (help+hd-TOKEN@…), the subject's "[#1047 ref:TOKEN]", then
 * the Message-ID our outbound mail had (<hd.TOKEN.…@…>) in In-Reply-To or
 * References. Null when none is there.
 */
export function findReplyToken(email: InboundEmail): string | null {
  const addrs = [...email.to.map((a) => a.email), ...email.cc.map((a) => a.email), ...email.recipients];
  for (const a of addrs) {
    const m = a.match(/\+hd-([a-z0-9]{16})@/i);
    if (m) return m[1].toLowerCase();
  }
  const s = email.subject.match(/\[#\d+\s+ref:([a-z0-9]{16})\]/i);
  if (s) return s[1].toLowerCase();
  for (const id of [email.inReplyTo, ...email.references]) {
    // <hd.TOKEN.…@…> on the thread's mail, <hd-note-TOKEN-…@…> on an internal-note notice.
    const m = id.match(/^<?hd\.([a-z0-9]{16})\./i) ?? id.match(/^<?hd-note-([a-z0-9]{16})-/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** The subject without our thread reference and the Re:/Fwd: prefixes, for a new ticket's subject. */
export function cleanSubject(subject: string): string {
  let s = subject.replace(/\s*\[#\d+\s+ref:[a-z0-9]{16}\]\s*/gi, " ");
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/^\s*(re|fw|fwd|aw|sv|wg|tr|rif)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim();
}

// --- HTML to text ----------------------------------------------------------------

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SKIP = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "img", "picture", "video", "audio", "iframe", "object", "embed", "form", "button", "select", "input", "textarea", "meta", "link"]);
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "table", "tr", "ul", "ol", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "hr", "address", "figure", "figcaption", "center"]);

/** Quoted history the mail clients mark up (Gmail, Outlook, Apple Mail, Thunderbird, Yahoo). */
function isQuoteContainer(node: HastNode): boolean {
  const p = node.properties ?? {};
  const cls = (Array.isArray(p.className) ? p.className : [p.className]).map(String);
  const id = String(p.id ?? "");
  if (cls.some((c) => /^(gmail_quote|gmail_extra|yahoo_quoted|moz-cite-prefix|OutlookMessageHeader)$/.test(c))) return true;
  if (/^(divRplyFwdMsg|appendonsend|mail-editor-reference-message-container|ydp.*yahoo_quoted.*)$/.test(id)) return true;
  if (node.tagName === "blockquote" && (p.type === "cite" || cls.includes("gmail_quote"))) return true;
  return false;
}

/**
 * The text of an HTML email. Nothing of the markup survives: blocks become
 * line breaks, list items "- ", a link "label (https://…)" when its target
 * is http(s) or mailto and differs from its label. `dropQuotes` also leaves
 * out the quoted history the common clients wrap in a marked container.
 */
export function htmlToText(html: string, opts: { dropQuotes?: boolean } = {}): string {
  let tree: HastNode;
  try {
    tree = unified().use(rehypeParse, { fragment: false }).parse(html.slice(0, 2_000_000)) as unknown as HastNode;
  } catch {
    return "";
  }
  let out = "";
  const nl = (n: number) => {
    const trailing = out.match(/\n*$/)?.[0].length ?? 0;
    if (out.length === 0) return;
    if (trailing < n) out += "\n".repeat(n - trailing);
  };
  const walk = (node: HastNode, pre: boolean) => {
    if (node.type === "text") {
      const v = node.value ?? "";
      if (pre) out += v;
      else {
        const collapsed = v.replace(/[ \t\r\n\f ]+/g, (m) => (m.includes(" ") ? " " : " "));
        if (collapsed === " " && (out.endsWith(" ") || out.endsWith("\n") || out === "")) return;
        out += out.endsWith("\n") || out.endsWith(" ") || out === "" ? collapsed.replace(/^ /, "") : collapsed;
      }
      return;
    }
    if (node.type !== "element" && node.type !== "root") {
      for (const c of node.children ?? []) walk(c, pre);
      return;
    }
    const tag = node.tagName ?? "";
    if (SKIP.has(tag)) return;
    if (opts.dropQuotes && isQuoteContainer(node)) return;
    if (tag === "br") {
      out = out.replace(/ +$/, "");
      out += "\n";
      return;
    }
    if (tag === "hr") {
      nl(2);
      out += "---";
      nl(2);
      return;
    }
    const block = BLOCK.has(tag);
    if (block) nl(tag === "p" || /^h\d$/.test(tag) || tag === "blockquote" || tag === "pre" || tag === "table" || tag === "ul" || tag === "ol" ? 2 : 1);
    if (tag === "li") {
      nl(1);
      out += "- ";
    }
    if (tag === "td" || tag === "th") {
      if (!out.endsWith("\n") && out !== "") out += " | ";
    }
    const isPre = pre || tag === "pre";
    for (const c of node.children ?? []) walk(c, isPre);
    if (tag === "a") {
      const href = String(node.properties?.href ?? "");
      if (/^(https?:|mailto:)/i.test(href)) {
        const label = textOf(node).trim();
        const target = href.replace(/^mailto:/i, "");
        if (target && label !== target && label !== href) out += ` (${href.replace(/^mailto:/i, "")})`;
      }
    }
    if (block) nl(tag === "p" || /^h\d$/.test(tag) || tag === "blockquote" || tag === "pre" || tag === "table" || tag === "ul" || tag === "ol" ? 2 : 1);
  };
  walk(tree, false);
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

// --- Quoted replies --------------------------------------------------------------

const QUOTE_HEADERS: RegExp[] = [
  /^On\b.{0,300}\bwrote:\s*$/i,
  /^Le\b.{0,300}\ba écrit\s*:\s*$/i,
  /^Am\b.{0,300}\bschrieb\b.{0,200}:\s*$/i,
  /^El\b.{0,300}\bescribió:\s*$/i,
  /^Op\b.{0,300}\bschreef\b.{0,200}:\s*$/i,
  /^-{2,}\s*(Original Message|Forwarded message|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}/i,
  /^#{2}-\s*Please type your reply above this line\s*-#{2}/i,
];

/**
 * A reply's new text: everything above the first quote header ("On … wrote:",
 * its common translations, "-----Original Message-----", an Outlook
 * "From: / Sent: / Subject:" block), with a trailing run of "> " lines and a
 * "-- " signature removed. Never answers '' for a non-empty text: when the
 * cut would leave nothing (a reply typed below the quote), the text is kept.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const joined = `${line} ${(lines[i + 1] ?? "").trim()}`.trim();
    if (QUOTE_HEADERS.some((re) => re.test(line))) {
      cut = i;
      break;
    }
    // "On Mon, 3 Nov 2026 at 10:11, Priya Shah <" + "priya@…> wrote:" (wrapped).
    if (/^On\b/i.test(line) && !/wrote:\s*$/i.test(line) && /\bwrote:\s*$/i.test(joined) && joined.length < 400) {
      cut = i;
      break;
    }
    if (/^_{5,}\s*$/.test(line) && /^(From|De|Von):/i.test((lines[i + 1] ?? "").trim())) {
      cut = i;
      break;
    }
    if (/^(From|De|Von):\s.+/i.test(line)) {
      const next = lines.slice(i + 1, i + 5).map((l) => l.trim());
      if (next.some((l) => /^(Sent|Date|Envoyé|Gesendet):/i.test(l)) && next.some((l) => /^(To|Subject|À|An|Objet|Betreff):/i.test(l))) {
        cut = i;
        break;
      }
    }
  }
  let kept = lines.slice(0, cut);
  // A trailing block of "> " quoted lines (bottom-quoting clients put it last).
  let end = kept.length;
  while (end > 0 && (kept[end - 1].trim() === "" || /^>/.test(kept[end - 1].trim()))) end--;
  if (end < kept.length && kept.slice(end).some((l) => /^>/.test(l.trim()))) kept = kept.slice(0, end);
  // RFC 3676 signature separator.
  const sig = kept.findIndex((l) => l === "-- " || l === "--");
  if (sig > 0) kept = kept.slice(0, sig);
  const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return result || text.trim();
}

// --- Text to markdown that renders as itself -------------------------------------

/** Every character the desk's markdown (GFM, directives, raw HTML) acts on inside a line. */
const MD_SPECIAL = /[\\`*_[\]{}<>()#!|~&:$^]/g;

/** Text escaped so markdown shows it as the characters it is (no line-start handling). */
export function escapeMarkdownText(s: string): string {
  return s.replace(MD_SPECIAL, (c) => `\\${c}`);
}

// What may become a link: an http(s) URL with a plain host and none of the
// characters markdown or HTML would act on, or a plain address. Anything
// else is escaped as text.
const SAFE_URL = /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?(?:[/?#][^\s<>"'`\\{}|^[\]\u0000-\u001f\u007f]*)?$/i;
const SAFE_WWW = /^www\.[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?:[/?#][^\s<>"'`\\{}|^[\]\u0000-\u001f\u007f]*)?$/i;
const SAFE_ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
const SAFE_MAILTO = /^mailto:([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24})$/i;

/** Split "(https://x.example/a)." into its leading punctuation, the core and its trailing punctuation. */
function splitWord(w: string): [string, string, string] {
  const lead = w.match(/^[(<"'\[]*/)![0];
  let core = w.slice(lead.length);
  let trail = "";
  for (;;) {
    const m = core.match(/[.,;:!?"'>\]]$/);
    if (m) {
      trail = m[0] + trail;
      core = core.slice(0, -1);
      continue;
    }
    // A closing parenthesis the core does not open belongs to the sentence.
    if (core.endsWith(")") && (core.match(/\(/g)?.length ?? 0) < (core.match(/\)/g)?.length ?? 0)) {
      trail = ")" + trail;
      core = core.slice(0, -1);
      continue;
    }
    break;
  }
  return [lead, core, trail];
}

/**
 * One whitespace-free word as safe markdown: a URL or address we can vouch
 * for becomes a link we write ourselves (an autolink, which markdown never
 * parses inside); everything else is escaped character by character.
 */
function safeWord(w: string): string {
  const [lead, core, trail] = splitWord(w);
  let link: string | null = null;
  if (core.length <= 2000) {
    if (SAFE_URL.test(core) && isParsableUrl(core)) link = `<${core}>`;
    else if (SAFE_ADDRESS.test(core)) link = `<${core}>`;
    else if (SAFE_MAILTO.test(core)) link = `[${escapeMarkdownText(core.slice(7))}](<mailto:${core.slice(7)}>)`;
    else if (SAFE_WWW.test(core) && isParsableUrl(`http://${core}`)) link = `[${escapeMarkdownText(core)}](<http://${core}>)`;
  }
  return link ? escapeMarkdownText(lead) + link + escapeMarkdownText(trail) : escapeMarkdownText(w);
}

function isParsableUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Plain text as markdown that renders as exactly that text: every character
 * markdown, its directives or HTML would act on is backslash-escaped (links,
 * images, emphasis, code, raw HTML, entities, tables, ::directives), line-start
 * markers (headings, quotes, lists, setext rules, indented code) are
 * neutralised, and each line break is kept as a hard break. A URL or
 * address is linked only when it is plainly one (http(s) with a clean host
 * and no markdown characters, or a plain address), as a link written here.
 */
export function textToSafeMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out = lines.map((raw) => {
    let line = raw.replace(/\t/g, "    ").replace(/^ {4,}/, "   ");
    line = line
      .split(/(\s+)/)
      .map((part) => (/^\s+$/.test(part) || part === "" ? part : safeWord(part)))
      .join("");
    // Line-start markers: headings, quotes and directives are escaped above
    // (#, >, :); lists, numbered lists and setext underlines here.
    line = line.replace(/^(\s*)([-+=])/, "$1\\$2").replace(/^(\s*\d{1,9})([.)])/, "$1\\$2");
    return line;
  });
  // Hard breaks between lines of one paragraph; blank lines stay paragraph breaks.
  let md = "";
  for (let i = 0; i < out.length; i++) {
    md += out[i];
    if (i < out.length - 1) md += out[i].trim() !== "" && out[i + 1].trim() !== "" ? "  \n" : "\n";
  }
  return md.trim();
}

/**
 * Markdown (an agent's reply, or a body textToSafeMarkdown wrote) as the
 * plain text a notification email quotes: escapes undone, links written
 * "label (url)", emphasis and code markers dropped. The result goes into a
 * template's `text` tag, which escapes it again for the html part.
 */
export function markdownToPlain(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\(<?([^)>]*)>?\)/g, "$1")
    .replace(/\[((?:\\.|[^\]\\])+)\]\(<([^>\s]+)>\)/g, (_m, label: string, url: string) => linkText(label, url))
    .replace(/\[((?:\\.|[^\]\\])+)\]\(([^)\s]+)[^)]*\)/g, (_m, label: string, url: string) => linkText(label, url))
    .replace(/<((?:https?:\/\/|mailto:)[^<>\s]+|[^<>\s@\\]+@[^<>\s@\\]+)>/gi, "$1")
    .replace(/(^|[^\\])(\*\*|__)(.+?)\2/g, "$1$3")
    .replace(/(^|[^\\`])`([^`]+)`/g, "$1$2")
    .replace(/ {2}\n/g, "\n")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function linkText(label: string, url: string): string {
  const plainLabel = label.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  const target = url.replace(/^mailto:/i, "");
  return plainLabel === url || plainLabel === target ? plainLabel : `${label} (${url})`;
}

/**
 * The body a ticket stores for an inbound email: the text part (or the
 * HTML part as text), the quoted history cut when it is a reply, escaped
 * as safe markdown and capped.
 */
export function inboundBody(email: InboundEmail, opts: { reply: boolean }): string {
  let text = "";
  if (opts.reply && email.stripped.trim()) text = email.stripped;
  else if (email.text.trim()) text = email.text;
  else if (email.html.trim()) text = htmlToText(email.html, { dropQuotes: opts.reply });
  if (opts.reply) text = stripQuotedReply(text);
  text = text.replace(/\u0000/g, "").trim();
  let note = "";
  if (text.length > INBOUND_MAX_TEXT) {
    text = text.slice(0, INBOUND_MAX_TEXT);
    note = "\n\n_(The rest of this email was too long and was left out.)_";
  }
  return textToSafeMarkdown(text) + note;
}
