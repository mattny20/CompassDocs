// Helpdesk 1.19.0, machine intake (agent P): the pure rules for automated
// email senders (an email integration's sender_addresses). Server code in
// lib/helpdesk/intake/email applies them inside the inbound pipeline.
//
//   authVerdict      did the sending domain authenticate this mail? Only
//                    verdicts the receiving provider wrote count (see
//                    below), and only a pass aligned with the From domain
//                    (DMARC pass, or SPF / DKIM pass for the From domain or
//                    its organisational domain) is a pass. No verdict at
//                    all is "none": callers fail closed on it unless the
//                    admin allowed unverified mail.
//   emailDedupKey    the subject with [RESOLVED] / [FIRING:2] / [OK] tags,
//                    Re:/Fwd: and every number stripped, or the first
//                    capture group (else the whole match) of the
//                    integration's own pattern.
//   emailStatus      a subject tagged RESOLVED / OK / RECOVERED is a
//                    resolution; anything else is firing.

import type { HdAlertStatus } from "./shared";
import { HD_INTAKE_LIMITS } from "./shared";

/**
 * What authVerdict reads: the provider, the From address and the headers in
 * order (top first), plus the provider's out-of-band verdict fields.
 */
export interface AuthInput {
  provider?: string;
  from?: string;
  headers?: Record<string, string>;
  headerList?: [string, string][];
  auth?: { spf?: string; dkim?: string; dmarc?: string; envelopeFrom?: string };
}

export interface AuthVerdict {
  /** "pass": aligned with the From domain; "fail": verdicts given, none an aligned pass; "none": no verdict at all. */
  state: "pass" | "fail" | "none";
  /** Whether the mail may be treated as coming from its From address (state "pass"). */
  ok: boolean;
  /** What failed, for the deliveries log and audit ("SPF fail", "DKIM pass for other.example (not aligned)"). */
  reason: string;
  /** Whether the provider gave any verdict at all. */
  checked: boolean;
}

/** The domain of an address or a bare domain, lower-cased ('' when none). */
function domainOf(v: string | undefined): string {
  const s = String(v ?? "").trim().toLowerCase().replace(/^<|>$/g, "");
  const at = s.lastIndexOf("@");
  const d = (at >= 0 ? s.slice(at + 1) : s).replace(/[>;\s].*$/, "").replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(d) && d.includes(".") ? d : "";
}

// Second-level labels under a country code that act as public suffixes
// (example.co.uk): enough for relaxed alignment without a suffix list.
const CC_SECOND = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ltd", "plc", "me", "or", "ne", "go", "gob", "nhs", "sch"]);

/** The organisational domain (relaxed DMARC alignment): the registrable part. */
export function orgDomain(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const n = tld.length === 2 && CC_SECOND.has(second) ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** Relaxed alignment: the same organisational domain. */
export function aligned(a: string, b: string): boolean {
  return !!a && !!b && orgDomain(a) === orgDomain(b);
}

/**
 * The verdict headers this provider writes itself, read from the top. A
 * receiving server prepends its trace headers, so the topmost copy of a
 * name is the provider's; a copy below the first Received header was in
 * the message when it arrived (a sender can write any header), so it never
 * counts. Each provider's list is what it is known to add:
 *   postmark  Received-SPF and X-Spam-Tests (DKIM_VALID_AU = aligned DKIM)
 *   mailgun   X-Mailgun-Spf and X-Mailgun-Dkim-Check-Result
 *   sendgrid  none: its SPF / dkim form fields are out of band
 *   generic   Authentication-Results and Received-SPF from the forwarding
 *             server, unless the JSON carries its own spf / dkim / dmarc
 */
const TRUSTED_HEADERS: Record<string, string[]> = {
  postmark: ["received-spf", "x-spam-tests"],
  mailgun: ["x-mailgun-spf", "x-mailgun-dkim-check-result"],
  sendgrid: [],
  generic: ["authentication-results", "received-spf"],
};

function topmost(list: [string, string][], name: string): string | null {
  const firstReceived = list.findIndex(([k]) => k === "received");
  const i = list.findIndex(([k]) => k === name);
  if (i < 0) return null;
  if (firstReceived >= 0 && i > firstReceived) return null;
  return list[i][1];
}

/** The verdict for one inbound email (an InboundEmail fits: pass it with `from` as its From address). */
export function authVerdict(inp: AuthInput): AuthVerdict {
  const provider = inp.provider && TRUSTED_HEADERS[inp.provider] ? inp.provider : "generic";
  const list: [string, string][] = inp.headerList ?? Object.entries(inp.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]);
  const fromDomain = domainOf(inp.from);
  const auth = inp.auth ?? {};
  const envelopeDomain = domainOf(auth.envelopeFrom);

  let checked = false;
  let pass = false;
  let dmarcFail = false;
  const notes: string[] = [];
  const note = (s: string) => {
    if (!notes.includes(s)) notes.push(s);
  };
  const result = (v: string) => v.trim().toLowerCase().match(/^[a-z]+/)?.[0] ?? "";

  const seeSpf = (verdict: string, domain: string) => {
    const v = result(verdict);
    if (!v) return;
    checked = true;
    const d = domain || envelopeDomain;
    if (v !== "pass") note(`SPF ${v}`);
    else if (aligned(d, fromDomain)) pass = true;
    else note(d ? `SPF pass for ${d} (not aligned)` : "SPF pass (envelope sender unknown)");
  };
  const seeDkim = (verdict: string, domain: string) => {
    const v = result(verdict);
    if (!v) return;
    checked = true;
    if (v !== "pass") note(`DKIM ${v}`);
    else if (aligned(domain, fromDomain)) pass = true;
    else note(domain ? `DKIM pass for ${domain} (not aligned)` : "DKIM pass (signing domain unknown)");
  };
  const seeDmarc = (verdict: string, headerFrom: string) => {
    const v = result(verdict);
    if (!v) return;
    checked = true;
    if (v === "pass" && (!headerFrom || aligned(headerFrom, fromDomain))) pass = true;
    else if (v === "pass") note(`DMARC pass for ${headerFrom} (not the From domain)`);
    else {
      note(`DMARC ${v}`);
      if (v === "fail") dmarcFail = true;
    }
  };

  // 1. Out-of-band fields (SendGrid's form fields, the generic JSON's own).
  const outOfBand = !!(auth.spf || auth.dkim || auth.dmarc);
  if (auth.dmarc) seeDmarc(auth.dmarc, "");
  if (auth.spf) seeSpf(auth.spf, "");
  if (auth.dkim) {
    // "{@example.com : pass, @other.example : fail}" or a bare "pass".
    const pairs = [...auth.dkim.matchAll(/@?([a-z0-9.-]+\.[a-z]{2,})\s*:\s*([a-z]+)/gi)];
    if (pairs.length) for (const m of pairs) seeDkim(m[2], domainOf(m[1]));
    else seeDkim(auth.dkim, "");
  }

  // 2. The provider's own headers (never when it sent its verdicts out of band).
  if (!outOfBand) {
    const trusted = TRUSTED_HEADERS[provider];
    if (trusted.includes("authentication-results")) {
      const ar = topmost(list, "authentication-results");
      if (ar) {
        // "authserv-id; spf=pass smtp.mailfrom=a@x; dkim=pass header.d=x; dmarc=pass header.from=x"
        for (const seg of ar.split(";").slice(1)) {
          const m = seg.match(/^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/i);
          if (!m) continue;
          const method = m[1].toLowerCase();
          const prop = (name: string) => seg.match(new RegExp(`\\b${name.replace(".", "\\.")}\\s*=\\s*"?([^\\s;"]+)`, "i"))?.[1] ?? "";
          if (method === "spf") seeSpf(m[2], domainOf(prop("smtp.mailfrom") || prop("smtp.helo")));
          else if (method === "dkim") seeDkim(m[2], domainOf(prop("header.d") || prop("header.i")));
          else seeDmarc(m[2], domainOf(prop("header.from")));
        }
      }
    }
    if (trusted.includes("received-spf")) {
      const rs = topmost(list, "received-spf");
      if (rs) {
        const env = rs.match(/envelope-from\s*=\s*"?<?([^\s;">]+)/i)?.[1] ?? rs.match(/domain of\s+(\S+@\S+?)[\s)]/i)?.[1] ?? "";
        seeSpf(rs, domainOf(env));
      }
    }
    if (trusted.includes("x-spam-tests")) {
      const tests = topmost(list, "x-spam-tests");
      // SpamAssassin's DKIM_VALID_AU: a valid signature from the author's (From) domain.
      if (tests && /\bDKIM_VALID_AU\b/.test(tests)) {
        checked = true;
        pass = true;
      }
    }
    if (trusted.includes("x-mailgun-spf")) {
      const v = topmost(list, "x-mailgun-spf");
      if (v) seeSpf(v, "");
    }
    if (trusted.includes("x-mailgun-dkim-check-result")) {
      // Mailgun names no signing domain, so a pass is never aligned on its own.
      const v = topmost(list, "x-mailgun-dkim-check-result");
      if (v) seeDkim(v, "");
    }
  }

  if (!checked) return { state: "none", ok: false, reason: "No SPF, DKIM or DMARC verdict from the mail provider", checked: false };
  if (pass && !dmarcFail) return { state: "pass", ok: true, reason: "", checked: true };
  if (!fromDomain) note("no From domain");
  return { state: "fail", ok: false, reason: notes.join(", ") || "Not authenticated", checked: true };
}

/** The sender verdict of one inbound email (lib/helpdesk/inbound-parse's InboundEmail fits). */
export function emailAuthVerdict(email: {
  provider: string;
  from: { email: string };
  headers?: Record<string, string>;
  headerList?: [string, string][];
  auth?: AuthInput["auth"];
}): AuthVerdict {
  return authVerdict({ provider: email.provider, from: email.from.email, headers: email.headers, headerList: email.headerList, auth: email.auth });
}

const STATUS_TAG = /\[(?:resolved|firing|ok|alert|alerting|problem|recovered|recovery|warning|critical|triggered)(?::\s*\d+)?\]/gi;

export function emailStatus(subject: string): HdAlertStatus {
  return /\[(resolved|ok|recovered|recovery)(?::\s*\d+)?\]|^\s*(resolved|recovered|ok)\b[:\s-]/i.test(subject) ? "resolved" : "firing";
}

/**
 * Whether a pattern can backtrack catastrophically on a crafted subject (a
 * ReDoS): a repeated group that itself holds a quantifier or an alternation
 * ("(a+)+", "(\w+\s?)*", "(a|aa)+"), or a backreference. A heuristic that
 * errs on refusing; emailDedupKey also runs every match under a time budget.
 */
export function superLinearPattern(pattern: string): boolean {
  type G = { quant: boolean; alt: boolean };
  const stack: G[] = [{ quant: false, alt: false }];
  let closed: G | null = null; // the group that just closed, awaiting a quantifier
  const repeats = (i: number): number => {
    // The length of a repeating quantifier at i (*, +, {n,}, {n,m} with m > 1), else 0.
    const c = pattern[i];
    if (c === "*" || c === "+") return 1;
    if (c === "{") {
      const m = pattern.slice(i).match(/^\{(\d+)(,(\d*))?\}/);
      if (!m) return 0;
      if (m[2] === undefined) return Number(m[1]) > 1 ? m[0].length : 0;
      if (m[3] === "" || Number(m[3]) > 1) return m[0].length;
    }
    return 0;
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const top = stack[stack.length - 1];
    if (c === "\\") {
      if (/[1-9k]/.test(pattern[i + 1] ?? "")) return true; // backreference
      i++;
      closed = null;
      continue;
    }
    if (c === "[") {
      // Skip the class (a "]" first, or escaped, is literal).
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
      i = j;
      closed = null;
      continue;
    }
    if (c === "(") {
      stack.push({ quant: false, alt: false });
      closed = null;
      continue;
    }
    if (c === ")") {
      const g = stack.length > 1 ? stack.pop()! : { quant: false, alt: false };
      closed = g;
      // What a group holds, its parent holds too.
      if (g.quant) stack[stack.length - 1].quant = true;
      continue;
    }
    if (c === "|") {
      top.alt = true;
      closed = null;
      continue;
    }
    const r = repeats(i);
    if (r || c === "?") {
      if (r && closed && (closed.quant || closed.alt)) return true;
      if (r || c === "?") top.quant = top.quant || r > 0;
      if (r > 1) i += r - 1;
      closed = null;
      continue;
    }
    closed = null;
  }
  return false;
}

/** Is `pattern` a usable regular expression, and a safe one? '' (the default) is. */
export function validDedupPattern(pattern: string): boolean {
  if (!pattern) return true;
  if (pattern.length > HD_INTAKE_LIMITS.pattern) return false;
  try {
    new RegExp(pattern, "i");
  } catch {
    return false;
  }
  return !superLinearPattern(pattern);
}

// The match runs in a separate V8 context with a time budget: a pattern the
// heuristic above lets through still cannot hold the server for longer.
let matchContext: import("node:vm").Context | null = null;
let matchScript: import("node:vm").Script | null = null;
/** Milliseconds one subject match may take. */
export const DEDUP_MATCH_BUDGET_MS = 25;
/** The subject is cut to this before matching. */
export const DEDUP_SUBJECT_MAX = 300;

/** The pattern's match on the subject as [whole, first group]; null on no match, a bad pattern or the budget running out. */
export function boundedMatch(pattern: string, subject: string): [string, string | null] | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vm = require("node:vm") as typeof import("node:vm");
  if (!matchContext || !matchScript) {
    matchContext = vm.createContext(Object.create(null));
    matchScript = new vm.Script(
      "(function () { var m = String(s).match(new RegExp(String(p), 'i')); return m ? [String(m[0]), m[1] === undefined ? null : String(m[1])] : null; })()"
    );
  }
  matchContext.s = subject.slice(0, DEDUP_SUBJECT_MAX);
  matchContext.p = pattern;
  try {
    const r = matchScript.runInContext(matchContext, { timeout: DEDUP_MATCH_BUDGET_MS }) as [string, string | null] | null;
    return r ? [String(r[0]), r[1] === null ? null : String(r[1])] : null;
  } catch {
    return null;
  } finally {
    matchContext.s = "";
    matchContext.p = "";
  }
}

/** The default key: the subject without status tags, reply prefixes and numbers, lower-cased. */
export function defaultEmailDedupKey(subject: string): string {
  let s = subject.replace(STATUS_TAG, " ");
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/^\s*(re|fw|fwd|aw|sv)\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .slice(0, HD_INTAKE_LIMITS.dedupKey);
}

export function emailDedupKey(subject: string, pattern: string): string {
  if (pattern && validDedupPattern(pattern)) {
    // Bounded input and a time budget (boundedMatch).
    const m = boundedMatch(pattern, subject);
    if (m) {
      const key = (m[1] ?? m[0]).trim().toLowerCase();
      if (key) return key.slice(0, HD_INTAKE_LIMITS.dedupKey);
    }
  }
  return defaultEmailDedupKey(subject);
}

/** A sender address list: trimmed, lower-cased, valid-looking, unique, capped; null when one is malformed. */
export function cleanSenderAddresses(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : null;
  if (!list) return null;
  const out: string[] = [];
  for (const a of list) {
    if (typeof a !== "string") return null;
    const v = a.trim().toLowerCase();
    if (!v) continue;
    if (v.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out.length > HD_INTAKE_LIMITS.senders ? null : out;
}
