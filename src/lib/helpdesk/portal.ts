// Helpdesk 1.19.1: the customer portal (agent V6). People who are NOT
// workspace users raise and follow requests at /support. Server-only.
//
// Identity. A contact (hd_portal_contacts) is an email address. Signing in
// is a one-time link: POST an address and, when the portal is on, the
// address passes the access rule (anyone / approved domains) and its
// domain is not blocked, and neither the contact nor the address has
// asked too often, a link valid for 15 minutes and good once is mailed
// (template hd_portal_link). Only the SHA-256 of a link or session token
// is stored. The response to the POST is the same whatever happened
// (deliverSignInLink runs after it, off the request's clock), so the
// form never says whether an address has requests, is allowed or blocked.
// Opening the link shows a button; only its POST spends the link (mail
// scanners that follow links do not sign anyone in).
//
// Sessions. A signed-in browser carries PORTAL_COOKIE ("compass_portal"),
// Path=/support, HttpOnly, SameSite=Lax, Secure as the app's own cookie is
// (lib/auth secureCookie). It is not the app's compass_session: no app
// route reads it and the browser never sends it outside /support, and the
// portal never reads compass_session. 30 days, slid forward on use
// (at most once an hour), deleted on sign-out, and every session of a
// contact is deleted when the contact is blocked. Each request re-checks
// the portal is on, the contact is not blocked and the address still
// passes the access rule.
//
// Isolation. A contact reaches exactly the tickets whose
// portal_contact_id is theirs (by number AND contact id; any other number
// is a 404 like one that does not exist). They read public messages only:
// never internal notes, never a reply held for review or returned
// (review_state), never system lines (they can name agents). Agents are
// shown by first name and team, nothing else (no surname, email, photo or
// directory card).
//
// Tickets. Portal tickets are ordinary hd_tickets: requester_id NULL,
// requester_email the contact's address, source 'portal_external',
// portal_contact_id set inside the insert transaction (so the received
// notice already knows the ticket is a portal ticket). Only request types
// the admin exposed, and only while they need nothing from the directory
// (portalBlockers: re-checked when a request is raised, since a workflow
// can be republished after it was exposed). No directory prefill.
//
// Writes from the portal (link, session, request, reply) must come from
// the portal's own pages: portalOriginRejection insists on an Origin (or
// Sec-Fetch-Site) that is this host.
//
// Links in mail (1.19.1 review). A portal request's Host is a stranger's
// to choose, so it never feeds lib/helpdesk/email's remembered origin:
// notices caused by portal writes link to the custom domain, else to the
// origin signed-in app traffic left (portalHookOrigin). Only the sign-in
// link itself falls back to the request's origin when no domain is set
// (portalLinkOrigin; the settings page warns about it).
//
// Merges. A portal ticket merged into another (lib/helpdesk/merge) shows
// "Joined with #N", and the contact reaches the ticket it was merged into
// as a CC does: its public conversation, their files, a reply
// (contactReachSql). Limits and blocks count per mailbox (canonicalMailbox),
// so "bob+1@" is bob@ for both.

import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSetting, setSetting } from "../db";
import { audit } from "../audit";
import { logEvent } from "../log";
import { featureEnabled } from "../ee";
import { getAppSettings } from "../settings-store";
import { deleteUpload } from "../uploads";
import { hq, hqOne, withTx } from "./db-core";
import { hdRateLimited } from "./access";
import { HD_ACTIVE_RUN_STATES, HD_STATUS_LABEL_REQUESTER } from "./types";
import type { HdAttachment, HdFormAnswers, HdFormField, HdRequestType, HdStatus, HdWorkflowDefinitionB, HdWorkflowStepB, HdTaskStepDefB } from "./types";
import {
  DEFAULT_PORTAL_SETTINGS,
  PORTAL_COOKIE,
  PORTAL_LINK_TTL_MS,
  PORTAL_PATH,
  PORTAL_SESSION_TTL_MS,
  PORTAL_TEXT_LIMITS,
  blockedWordIn,
  canonicalMailbox,
  cleanEmail,
  cleanNextPath,
  cleanPortalSettings,
  emailAllowed,
  firstName,
  type PortalBlocker,
  type PortalSettings,
} from "./portal-shared";
import { cleanJourneyId } from "./help-centre-shared";

export * from "./portal-shared";

// --- Settings ------------------------------------------------------------------------

export const HD_PORTAL_SETTINGS_KEY = "helpdesk_portal";

export async function getPortalSettings(): Promise<PortalSettings> {
  try {
    const raw = await getSetting(HD_PORTAL_SETTINGS_KEY);
    return cleanPortalSettings(raw ? JSON.parse(raw) : DEFAULT_PORTAL_SETTINGS);
  } catch {
    return cleanPortalSettings(DEFAULT_PORTAL_SETTINGS);
  }
}

/** Save the settings (cleaned); answers what changed, by key. */
export async function savePortalSettings(raw: unknown): Promise<{ settings: PortalSettings; changed: string[] }> {
  const before = await getPortalSettings();
  const next = cleanPortalSettings(raw);
  const changed = (Object.keys(next) as (keyof PortalSettings)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
  if (changed.length) await setSetting(HD_PORTAL_SETTINGS_KEY, JSON.stringify(next));
  return { settings: next, changed };
}

/** The brand the portal shows: its own name, else the workspace's. */
export async function portalBrand(s?: PortalSettings): Promise<{ name: string; logo_url: string | null }> {
  const settings = s ?? (await getPortalSettings());
  let name = settings.brand_name;
  if (!name) {
    try {
      name = (await getAppSettings()).company_name || "Support";
    } catch {
      name = "Support";
    }
  }
  return { name, logo_url: settings.brand_logo ? `${PORTAL_PATH}/api/logo?v=${settings.brand_logo.slice(0, 12)}` : null };
}

/** Licensed and switched on: the portal exists. Anything else is a 404. */
export async function portalOpen(s?: PortalSettings): Promise<boolean> {
  try {
    if (!(await featureEnabled("helpdesk"))) return false;
  } catch {
    return false;
  }
  return (s ?? (await getPortalSettings())).enabled;
}

// --- Which request types may be offered ------------------------------------------

function stepsOf(def: HdWorkflowDefinitionB | null | undefined): HdWorkflowStepB[] {
  return Array.isArray(def?.steps) ? def!.steps : [];
}

/**
 * What stops a request type from being offered to outside customers: it is
 * off or restricted to groups, its form asks for a person from the
 * directory, or its published workflow needs the requester's directory
 * entry (manager approval, a space grant, a condition or route on a
 * requester field). Empty when it can be offered.
 */
export async function portalBlockers(rt: Pick<HdRequestType, "id" | "active" | "visibility" | "form" | "workflow_id">): Promise<PortalBlocker[]> {
  const out = new Set<PortalBlocker>();
  if (!rt.active) out.add("inactive");
  if (rt.visibility === "groups") out.add("restricted");
  if ((rt.form ?? []).some((f: HdFormField) => f.type === "user")) out.add("person_field");
  const w = await hqOne<{ definition: HdWorkflowDefinitionB }>(
    `SELECT w.definition FROM hd_workflows w
      WHERE w.published = 1
        AND (w.id = $2::int OR ($2::int IS NULL AND (w.definition->'trigger'->>'request_type_id')::int = $1))
      ORDER BY w.id LIMIT 1`,
    [rt.id, rt.workflow_id ?? null]
  );
  const walk = (steps: HdWorkflowStepB[]) => {
    for (const s of steps) {
      if (s.when?.rules?.some((r) => r.source === "requester")) out.add("directory_condition");
      if (s.kind === "approval") {
        if (s.approver?.kind === "manager") out.add("manager_approval");
        if (s.approver?.kind === "space_owner") out.add("space_approval");
      }
      if (s.kind === "task" && (s as HdTaskStepDefB).route?.source === "requester") out.add("directory_route");
      if (s.kind === "parallel") walk((s as { steps: HdWorkflowStepB[] }).steps ?? []);
    }
  };
  walk(stepsOf(w?.definition));
  return [...out];
}

export interface PortalTypeOption {
  id: number;
  title: string;
  description: string;
  icon: string;
  team_id: number | null;
  team_name: string | null;
  exposed: boolean;
  /** The team portal requests go to when exposed (null = the type's own). */
  portal_team_id: number | null;
  blockers: PortalBlocker[];
}

/** Every request type with whether it is exposed and what blocks it (the admin page). */
export async function portalTypeOptions(s?: PortalSettings): Promise<PortalTypeOption[]> {
  const settings = s ?? (await getPortalSettings());
  const types = await hq<HdRequestType & { team_name: string | null }>(
    `SELECT rt.*, tm.name AS team_name FROM hd_request_types rt LEFT JOIN hd_teams tm ON tm.id = rt.team_id ORDER BY rt.position, rt.id`
  );
  const out: PortalTypeOption[] = [];
  for (const rt of types) {
    const exp = settings.types.find((x) => x.id === rt.id);
    out.push({
      id: rt.id,
      title: rt.title,
      description: rt.description,
      icon: rt.icon,
      team_id: rt.team_id,
      team_name: rt.team_name,
      exposed: !!exp,
      portal_team_id: exp?.team_id ?? null,
      blockers: await portalBlockers(rt),
    });
  }
  return out;
}

export interface PortalOfferedType {
  id: number;
  title: string;
  description: string;
  icon: string;
  eta_label: string;
  form: HdFormField[];
  team_id: number | null;
}

/** The request types a contact may raise now: exposed, and nothing blocks them. */
export async function offeredTypes(s?: PortalSettings): Promise<PortalOfferedType[]> {
  const settings = s ?? (await getPortalSettings());
  if (!settings.types.length) return [];
  const rows = await hq<HdRequestType>(
    "SELECT * FROM hd_request_types WHERE id = ANY($1::int[]) ORDER BY position, id",
    [settings.types.map((t) => t.id)]
  );
  const out: PortalOfferedType[] = [];
  for (const rt of rows) {
    if ((await portalBlockers(rt)).length) continue;
    const exp = settings.types.find((x) => x.id === rt.id)!;
    let teamId = exp.team_id ?? rt.team_id;
    if (exp.team_id && !(await hqOne("SELECT 1 FROM hd_teams WHERE id = $1", [exp.team_id]))) teamId = rt.team_id;
    out.push({
      id: rt.id,
      title: rt.title,
      description: rt.description,
      icon: rt.icon,
      eta_label: rt.eta_label,
      // No directory prefill for people outside the directory.
      form: (rt.form ?? []).map(({ default_from: _d, ...f }) => f),
      team_id: teamId,
    });
  }
  return out;
}

// --- Tokens, contacts --------------------------------------------------------------

export function hashPortalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * 256 random bits as hex: nothing a mail client, a markdown pass or a URL
 * could rewrite (base64url's "_" was read as emphasis by the plain-text
 * part of the mail, which broke the link there).
 */
function newPortalToken(): string {
  return randomBytes(32).toString("hex");
}

export interface PortalContact {
  id: number;
  email: string;
  name: string;
  blocked: number;
  created_at: string;
  last_seen_at: string | null;
}

export async function getContactByEmail(email: string): Promise<PortalContact | undefined> {
  return hqOne<PortalContact>("SELECT * FROM hd_portal_contacts WHERE lower(email) = lower($1)", [email]);
}

export async function getContact(id: number): Promise<PortalContact | undefined> {
  return hqOne<PortalContact>("SELECT * FROM hd_portal_contacts WHERE id = $1", [id]);
}

async function ensureContact(email: string): Promise<PortalContact> {
  const row = await hqOne<PortalContact>(
    `INSERT INTO hd_portal_contacts (email) VALUES (lower($1))
     ON CONFLICT (lower(email)) DO UPDATE SET email = hd_portal_contacts.email
     RETURNING *`,
    [email]
  );
  return row!;
}

/**
 * The mailbox of an address column in SQL: portal-shared canonicalMailbox
 * (lower-case, "+tag" dropped), the expression idx_hd_portal_contacts_mailbox
 * indexes. Limits and blocks count per mailbox, so plus-addressing is no
 * way round either; mail goes to the stored address.
 */
export function mailboxSql(col: string): string {
  return `regexp_replace(lower(${col}), '^([^+@]+)\\+[^@]*@', '\\1@')`;
}

/**
 * Is this address's mailbox blocked in the portal (a blocked contact with
 * the same mailbox, "+tag" or not)? For other modules that mail or accept
 * mail from portal contacts (inbound, notices, CCs).
 */
export async function isBlockedPortalMailbox(email: string): Promise<boolean> {
  if (!email) return false;
  return !!(await hqOne(`SELECT 1 FROM hd_portal_contacts WHERE ${mailboxSql("email")} = $1 AND blocked = 1 LIMIT 1`, [canonicalMailbox(email)]));
}

/** SQL: is the contact row `alias` blocked, itself or through another address of its mailbox? */
function blockedSql(alias: string): string {
  return `(${alias}.blocked = 1 OR EXISTS (SELECT 1 FROM hd_portal_contacts bm WHERE bm.blocked = 1 AND ${mailboxSql("bm.email")} = ${mailboxSql(`${alias}.email`)}))`;
}

/**
 * SQL (a subquery of ticket ids): the tickets a contact reaches. Their own
 * portal tickets, and the tickets those were merged into (following a chain
 * of merges as inbound replies do, lib/helpdesk/merge mergedReplyTarget):
 * merging made them a CC of the kept ticket, and a CC reads the public
 * conversation as the requester does. `param` is the contact id's
 * placeholder.
 */
export function contactReachSql(param: string): string {
  return `(WITH RECURSIVE reach(id, hop) AS (
             SELECT id, 0 FROM hd_tickets WHERE portal_contact_id = ${param}
             UNION ALL
             SELECT mt.merged_into, r.hop + 1 FROM reach r JOIN hd_tickets mt ON mt.id = r.id
              WHERE mt.merged_into IS NOT NULL AND r.hop < 5)
           -- 1.19.4 (C7): never a ticket in the recycle bin (every portal read and write goes through here).
           SELECT reach.id FROM reach JOIN hd_tickets live ON live.id = reach.id WHERE live.deleted_at IS NULL)`;
}

/** Does the contact reach this ticket (their own, or one theirs was merged into)? */
export async function contactReaches(contactId: number, ticketId: number): Promise<boolean> {
  return !!(await hqOne(`SELECT 1 WHERE $2::int IN ${contactReachSql("$1::int")}`, [contactId, ticketId]));
}

/** Is this address a portal contact? (The desk's contact card shows them minimal.) */
export async function isPortalContactEmail(email: string): Promise<boolean> {
  if (!email) return false;
  return !!(await hqOne("SELECT 1 FROM hd_portal_contacts WHERE lower(email) = lower($1)", [email]));
}

// --- Rate limits ----------------------------------------------------------------------

/** Sign-in link requests from one address (IP): 10 a minute, 30 an hour. */
export function linkIpLimited(ip: string): boolean {
  return hdRateLimited(`portal-link-m:${ip}`, 10, 60_000) || hdRateLimited(`portal-link-h:${ip}`, 30, 3_600_000);
}

/** Spending a link from one address (IP): 20 a minute. */
export function sessionIpLimited(ip: string): boolean {
  return hdRateLimited(`portal-session:${ip}`, 20, 60_000);
}

/** A contact's replies: 20 a minute. */
export function portalReplyLimited(contactId: number): boolean {
  return hdRateLimited(`portal-reply:${contactId}`, 20, 60_000);
}

// --- Sign-in links ------------------------------------------------------------------

export type LinkOutcome = "sent" | "off" | "not_allowed" | "blocked" | "limited" | "mail_failed";

/** The workspace's configured domain as an origin, or null when none is set. */
async function configuredOrigin(): Promise<string | null> {
  try {
    const s = await getAppSettings();
    if (s.custom_domain) return `https://${s.custom_domain}`;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Where a sign-in link points: the custom domain when set (never a Host
 * header a stranger chose), else the request's origin. The request's
 * origin is used for that one mail only: it is never handed to
 * lib/helpdesk/email helpdeskOrigin, whose remembered origin every later
 * mail without one of its own links to (1.19.1 review).
 */
export async function portalLinkOrigin(requestOrigin: string): Promise<string> {
  return (await configuredOrigin()) ?? requestOrigin;
}

/**
 * The origin portal writes hand to the shared hooks (events, notices to
 * agents, CCs and the contact): the custom domain, else undefined, so
 * helpdeskOrigin falls back to the origin signed-in app traffic left (or
 * relative links). Never the portal request's own Host: anyone can get a
 * portal session, and that origin would otherwise be remembered for every
 * workspace mail after it.
 */
export async function portalHookOrigin(): Promise<string | undefined> {
  return (await configuredOrigin()) ?? undefined;
}

let linkSpy: ((email: string, url: string) => void) | null = null;
/** Tests: see each link as it is mailed. */
export function setPortalLinkSpyForTests(spy: typeof linkSpy): void {
  linkSpy = spy;
}

/**
 * The work behind "Email me a sign-in link", after the response has gone:
 * decide, mint and mail. Answers what happened (logged, never shown).
 */
export async function deliverSignInLink(
  rawEmail: string,
  opts: { origin: string; next?: string; ip?: string | null; settings?: PortalSettings; journey?: unknown }
): Promise<LinkOutcome> {
  const email = cleanEmail(rawEmail);
  if (!email) return "not_allowed";
  const settings = opts.settings ?? (await getPortalSettings());
  if (!(await portalOpen(settings))) return "off";
  if (!emailAllowed(email, settings)) return "not_allowed";
  // Per mailbox ("bob+1@" is bob@'s mailbox), counted before anything is
  // stored (so an address nobody has used is limited too), then in the
  // database (survives a restart).
  const mailbox = canonicalMailbox(email);
  const perHour = settings.limits.links_per_email_hour;
  if (hdRateLimited(`portal-link-e:${mailbox}`, perHour, 3_600_000)) return "limited";
  if (await isBlockedPortalMailbox(email)) return "blocked";
  const existing = await getContactByEmail(email);
  const n = await hqOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM hd_portal_links l JOIN hd_portal_contacts c ON c.id = l.contact_id
      WHERE ${mailboxSql("c.email")} = $1 AND l.created_at > now() - interval '1 hour'`,
    [mailbox]
  );
  if ((n?.n ?? 0) >= perHour) return "limited";
  const contact = existing ?? (await ensureContact(email));
  const token = newPortalToken();
  await hq(
    // hc_journey (1.19.4 C3): the asking tab's help centre journey, handed on with the session.
    "INSERT INTO hd_portal_links (token_hash, contact_id, next_path, expires_at, hc_journey) VALUES ($1, $2, $3, $4, $5)",
    [hashPortalToken(token), contact.id, cleanNextPath(opts.next ?? ""), new Date(Date.now() + PORTAL_LINK_TTL_MS), cleanJourneyId(opts.journey)]
  );
  const base = await portalLinkOrigin(opts.origin);
  const url = `${base}${PORTAL_PATH}/signin?token=${encodeURIComponent(token)}`;
  linkSpy?.(email, url);
  const brand = await portalBrand(settings);
  const { sendHelpdeskTemplate } = await import("./email");
  // No origin handed over: the link is already absolute, and a request's
  // origin must never become the one later mail links to.
  const ok = await sendHelpdeskTemplate(
    email,
    "hd_portal_link",
    { portal_name: brand.name, signin_url: url, minutes: String(PORTAL_LINK_TTL_MS / 60_000), org_name: brand.name },
    null,
    await portalHookOrigin()
  );
  if (!ok) logEvent("warn", "helpdesk.portal_link_mail_failed", { contact: contact.id });
  return ok ? "sent" : "mail_failed";
}

/** The address a link was minted for, without spending it (the "Continue" page). Null when it is spent, expired or unknown. */
export async function peekSignInLink(token: string): Promise<{ email: string } | null> {
  if (!token || token.length > 200) return null;
  const row = await hqOne<{ email: string }>(
    `SELECT c.email FROM hd_portal_links l JOIN hd_portal_contacts c ON c.id = l.contact_id
      WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.expires_at > now() AND NOT ${blockedSql("c")}`,
    [hashPortalToken(token)]
  );
  return row ?? null;
}

/**
 * Spend a link (once, atomically) and open a session. Null when the link
 * is unknown, spent or expired, or the contact can no longer sign in.
 */
export async function consumeSignInLink(
  token: string,
  opts: { ip?: string | null; userAgent?: string | null; settings?: PortalSettings } = {}
): Promise<{ sessionToken: string; contact: PortalContact; next: string; journey: string } | null> {
  if (!token || token.length > 200) return null;
  const used = await hqOne<{ contact_id: number; next_path: string; hc_journey: string }>(
    `UPDATE hd_portal_links SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING contact_id, next_path, hc_journey`,
    [hashPortalToken(token)]
  );
  if (!used) return null;
  const settings = opts.settings ?? (await getPortalSettings());
  const contact = await getContact(used.contact_id);
  if (!contact || contact.blocked || (await isBlockedPortalMailbox(contact.email)) || !(await portalOpen(settings)) || !emailAllowed(contact.email, settings)) return null;
  const sessionToken = newPortalToken();
  await hq(
    `INSERT INTO hd_portal_sessions (contact_id, token_hash, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [contact.id, hashPortalToken(sessionToken), new Date(Date.now() + PORTAL_SESSION_TTL_MS), (opts.ip ?? "").slice(0, 64), (opts.userAgent ?? "").slice(0, 300)]
  );
  await hq("UPDATE hd_portal_contacts SET last_seen_at = now() WHERE id = $1", [contact.id]);
  // One audit row per contact per ten minutes: a sign-in is worth a line,
  // a loop of them is not worth a flood.
  if (!hdRateLimited(`portal-signin-audit:${contact.id}`, 1, 10 * 60_000)) {
    await audit({
      actor: { name: `Customer portal: ${contact.email}` },
      action: "helpdesk.portal.signin",
      targetType: "helpdesk_portal_contact",
      targetId: contact.id,
      targetLabel: contact.email,
      ip: opts.ip ?? null,
    });
  }
  return { sessionToken, contact, next: used.next_path || `${PORTAL_PATH}/requests`, journey: used.hc_journey ?? "" };
}

// --- Sessions ---------------------------------------------------------------------

const SLIDE_EVERY_MS = 3_600_000;

/** The contact a session token belongs to (sliding the expiry), or null. Checks blocked, the portal and the access rule. */
export async function portalSessionContact(token: string | undefined | null, s?: PortalSettings): Promise<PortalContact | null> {
  if (!token || token.length > 200) return null;
  const row = await hqOne<PortalContact & { session_id: number; expires_at: string; mailbox_blocked: boolean }>(
    `SELECT c.*, s.id AS session_id, s.expires_at, ${blockedSql("c")} AS mailbox_blocked
       FROM hd_portal_sessions s JOIN hd_portal_contacts c ON c.id = s.contact_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashPortalToken(token)]
  );
  if (!row || row.blocked || row.mailbox_blocked) return null;
  const settings = s ?? (await getPortalSettings());
  if (!(await portalOpen(settings)) || !emailAllowed(row.email, settings)) return null;
  const target = Date.now() + PORTAL_SESSION_TTL_MS;
  if (target - new Date(row.expires_at).getTime() > SLIDE_EVERY_MS) {
    await hq("UPDATE hd_portal_sessions SET expires_at = $2 WHERE id = $1", [row.session_id, new Date(target)]);
    await hq("UPDATE hd_portal_contacts SET last_seen_at = now() WHERE id = $1", [row.id]);
  }
  const { session_id: _s, expires_at: _e, mailbox_blocked: _m, ...contact } = row;
  return contact;
}

/** The signed-in contact of this request (the portal cookie only; never the app's session). */
export async function currentPortalContact(s?: PortalSettings): Promise<PortalContact | null> {
  const token = (await cookies()).get(PORTAL_COOKIE)?.value;
  return portalSessionContact(token, s);
}

export async function revokePortalSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await hq("DELETE FROM hd_portal_sessions WHERE token_hash = $1", [hashPortalToken(token)]);
}

export async function revokeContactSessions(contactId: number): Promise<number> {
  const rows = await hq("DELETE FROM hd_portal_sessions WHERE contact_id = $1 RETURNING id", [contactId]);
  return rows.length;
}

/** The cookie the portal sets: its own name, the portal's path, HttpOnly, Lax, Secure as the app's is. */
export function portalCookieOptions(secure: boolean, maxAgeSeconds = PORTAL_SESSION_TTL_MS / 1000) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: PORTAL_PATH, maxAge: maxAgeSeconds };
}

// --- Request guards ---------------------------------------------------------------

/**
 * Same-origin for every portal write, stricter than the app's: the browser
 * must say where it is (Origin, or Sec-Fetch-Site) and it must be here.
 * A write with neither is refused (the portal is a browser surface).
 */
export function portalOriginRejection(req: Request): NextResponse | null {
  const h = req.headers;
  const reject = () => NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  const origin = h.get("origin");
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").toLowerCase();
  if (origin && origin !== "null") {
    try {
      return new URL(origin).host.toLowerCase() === host && host ? null : reject();
    } catch {
      return reject();
    }
  }
  if (origin === "null") return reject();
  return h.get("sec-fetch-site") === "same-origin" ? null : reject();
}

/**
 * EXTENSION POINT: a human check (CAPTCHA) before a sign-in link is mailed
 * or a request is raised. 1.19.1 ships none and makes no third-party call,
 * so this answers true. To add one (for example Cloudflare Turnstile):
 * render its widget in PortalSignIn and PortalNewRequest, send its token
 * as `human_token`, and verify it here against the provider with a secret
 * read from the environment, answering false when it fails. The routes
 * already refuse with 403 on false.
 */
export async function portalHumanCheck(_req: Request, _what: "link" | "request", _token?: string): Promise<boolean> {
  return true;
}

export function portalNotFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

/**
 * The gate of every portal API route: the portal exists (404 otherwise,
 * licence included: the portal says nothing about the workspace), writes
 * are same-origin, and a session names a contact (401).
 */
export async function portalGate(req: Request, opts: { write?: boolean } = {}): Promise<{ contact: PortalContact; settings: PortalSettings } | NextResponse> {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) return portalNotFound();
  if (opts.write) {
    const cross = portalOriginRejection(req);
    if (cross) return cross;
  }
  const contact = await currentPortalContact(settings);
  if (!contact) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  return { contact, settings };
}

// --- What a contact reads ---------------------------------------------------------

export interface PortalRequestRow {
  number: number;
  subject: string;
  status: HdStatus;
  status_label: string;
  tone: "accent" | "warn" | "ok" | "neutral";
  request_type_title: string | null;
  created_at: string;
  updated_at: string;
  /** The request was joined with (merged into) this one; null when not. */
  joined_into: number | null;
}

function portalStatus(status: HdStatus, inWorkflow: boolean, joinedInto: number | null = null): { label: string; tone: PortalRequestRow["tone"] } {
  if (joinedInto) return { label: `Joined with #${joinedInto}`, tone: "neutral" };
  if (inWorkflow && status !== "solved" && status !== "closed") return { label: "In progress", tone: "accent" };
  const label = HD_STATUS_LABEL_REQUESTER[status] ?? status;
  const tone = status === "pending" ? "warn" : status === "solved" || status === "closed" ? "ok" : status === "on_hold" ? "neutral" : "accent";
  return { label, tone };
}

/** A contact's own requests (and those theirs were joined with), newest activity first. */
export async function listContactRequests(contactId: number): Promise<PortalRequestRow[]> {
  const rows = await hq<{ number: number; subject: string; status: HdStatus; request_type_title: string | null; created_at: string; updated_at: string; run_state: string | null; joined_into: number | null }>(
    `SELECT t.number, t.subject, t.status, rt.title AS request_type_title, t.created_at, t.updated_at, r.state AS run_state,
            (SELECT p.number FROM hd_tickets p WHERE p.id = t.merged_into AND p.deleted_at IS NULL) AS joined_into
       FROM hd_tickets t
       LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id
       LEFT JOIN hd_workflow_runs r ON r.id = t.workflow_run_id
      WHERE t.id IN ${contactReachSql("$1::int")} AND t.parent_ticket_id IS NULL
      ORDER BY t.updated_at DESC, t.id DESC LIMIT 200`,
    [contactId]
  );
  return rows.map((r) => {
    const st = portalStatus(r.status, !!r.run_state && (HD_ACTIVE_RUN_STATES as readonly string[]).includes(r.run_state), r.joined_into);
    return {
      number: r.number,
      subject: r.subject,
      status: r.status,
      status_label: st.label,
      tone: st.tone,
      request_type_title: r.request_type_title,
      created_at: r.created_at,
      updated_at: r.updated_at,
      joined_into: r.joined_into,
    };
  });
}

export interface PortalMessage {
  id: number;
  /** "You", or an agent's first name. */
  author: string;
  mine: boolean;
  /** The agent's team ("Support team"); null for the contact's own messages. */
  team: string | null;
  body: string;
  created_at: string;
  attachments: { id: number; name: string; size: number }[];
}

export interface PortalRequestDetail extends PortalRequestRow {
  answers: { label: string; value: string }[];
  /** 1.20.6 (lib/helpdesk/custom-fields): the Public custom fields that have a value; [] when none. Never an agent-only field. */
  details: { label: string; value: string }[];
  messages: PortalMessage[];
  /** A closed request takes no reply. */
  can_reply: boolean;
}

interface PortalTicketRow {
  id: number;
  number: number;
  subject: string;
  status: HdStatus;
  request_type_id: number | null;
  form_answers: HdFormAnswers;
  created_at: string;
  updated_at: string;
  requester_email: string;
  team_id: number | null;
  run_state: string | null;
  request_type_title: string | null;
  form: HdFormField[] | null;
  /** The number of the ticket this one was merged into, or null. */
  joined_into: number | null;
}

/**
 * The contact's ticket by number, or undefined: the one ownership check
 * every read and write goes through. Their own portal tickets, and the
 * tickets those were merged into (contactReachSql).
 */
export async function contactTicket(contactId: number, number: number): Promise<PortalTicketRow | undefined> {
  if (!Number.isInteger(number) || number <= 0 || number > 2_000_000_000) return undefined;
  return hqOne<PortalTicketRow>(
    `SELECT t.id, t.number, t.subject, t.status, t.request_type_id, t.form_answers, t.created_at, t.updated_at,
            t.requester_email, t.team_id, r.state AS run_state, rt.title AS request_type_title, rt.form,
            (SELECT p.number FROM hd_tickets p WHERE p.id = t.merged_into AND p.deleted_at IS NULL) AS joined_into
       FROM hd_tickets t
       LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id
       LEFT JOIN hd_workflow_runs r ON r.id = t.workflow_run_id
      WHERE t.number = $1 AND t.id IN ${contactReachSql("$2::int")} AND t.parent_ticket_id IS NULL`,
    [number, contactId]
  );
}

function answerLine(f: HdFormField, v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  if (f.type === "checkbox") return v === true ? "Yes" : "No";
  if (f.type === "choice" || f.type === "select") return f.options?.find((o) => o.value === v)?.label ?? String(v);
  if (f.type === "user") return "";
  return String(v);
}

/** What a contact reads of their request: public messages only, agents by first name and team. */
export async function contactRequestDetail(contact: Pick<PortalContact, "id" | "email">, number: number): Promise<PortalRequestDetail | null> {
  const t = await contactTicket(contact.id, number);
  if (!t) return null;
  const msgs = await hq<{
    id: number;
    author_id: number | null;
    author_name: string;
    author_email: string;
    body: string;
    attachments: HdAttachment[];
    created_at: string;
    team_name: string | null;
  }>(
    `SELECT m.id, m.author_id, m.author_name, m.author_email, m.body, m.attachments, m.created_at,
            CASE WHEN m.author_id IS NULL THEN NULL
                 ELSE (SELECT tm.name FROM hd_team_members mm JOIN hd_teams tm ON tm.id = mm.team_id
                        WHERE mm.user_id = m.author_id
                        ORDER BY (mm.team_id IS NOT DISTINCT FROM $2::int) DESC, tm.position, tm.id LIMIT 1) END AS team_name
       FROM hd_messages m
      WHERE m.ticket_id = $1 AND m.kind = 'public'
        AND COALESCE(m.review_state, '') NOT IN ('pending', 'returned')
      ORDER BY m.created_at, m.id LIMIT 1000`,
    [t.id, t.team_id]
  );
  const mineEmail = contact.email.toLowerCase();
  const st = portalStatus(t.status, !!t.run_state && (HD_ACTIVE_RUN_STATES as readonly string[]).includes(t.run_state), t.joined_into);
  const form = Array.isArray(t.form) ? t.form : [];
  return {
    number: t.number,
    subject: t.subject,
    status: t.status,
    status_label: st.label,
    tone: st.tone,
    request_type_title: t.request_type_title,
    created_at: t.created_at,
    updated_at: t.updated_at,
    joined_into: t.joined_into,
    can_reply: t.status !== "closed" && !t.joined_into,
    answers: form
      .map((f) => ({ label: f.label, value: answerLine(f, (t.form_answers ?? {})[f.key]) }))
      .filter((a) => a.value !== ""),
    // 1.20.6: Public custom fields only, and never a person's name (as the answers above leave people out).
    details: (await (await import("./custom-fields")).publicCustomDetails({ id: t.id, team_id: t.team_id }, { people: false }).catch(() => [])).map((d) => ({ label: d.label, value: d.value })),
    messages: msgs.map((m) => {
      const mine = m.author_id === null && m.author_email.toLowerCase() === mineEmail;
      return {
        id: m.id,
        author: mine ? "You" : firstName(m.author_name) || "Support",
        mine,
        team: mine || m.author_id === null ? null : m.team_name,
        body: m.body,
        created_at: m.created_at,
        attachments: (Array.isArray(m.attachments) ? m.attachments : []).map((a) => ({ id: Number(a.id), name: String(a.name), size: Number(a.size) || 0 })),
      };
    }),
  };
}

/** A file the contact may download: on their ticket, on a public message that was sent. */
export async function contactAttachment(contactId: number, attachmentId: number) {
  if (!Number.isInteger(attachmentId) || attachmentId <= 0) return undefined;
  return hqOne<{ id: number; stored_name: string; filename: string; mime_type: string; size: number }>(
    `SELECT a.id, a.stored_name, a.filename, a.mime_type, a.size
       FROM hd_attachments a
       JOIN hd_messages m ON m.id = a.message_id
       JOIN hd_tickets t ON t.id = a.ticket_id AND t.id = m.ticket_id
      WHERE a.id = $1 AND t.id IN ${contactReachSql("$2::int")} AND t.parent_ticket_id IS NULL AND m.kind = 'public'
        AND COALESCE(m.review_state, '') NOT IN ('pending', 'returned')`,
    [attachmentId, contactId]
  );
}

// --- Files from the portal ---------------------------------------------------------

export const PORTAL_FILE_LIMITS = {
  perMessage: 5,
  maxBytes: 10 * 1024 * 1024,
  /** A contact's files in 24 hours. */
  dayFiles: 30,
  dayBytes: 100 * 1024 * 1024,
} as const;

export class PortalRefusal extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface PortalFile {
  name: string;
  buf: Buffer;
}

/** Check files before anything is stored: count, size, type and the contact's daily quota. */
export async function checkPortalFiles(contactId: number, files: PortalFile[]): Promise<void> {
  if (!files.length) return;
  if (files.length > PORTAL_FILE_LIMITS.perMessage) throw new PortalRefusal(`Attach up to ${PORTAL_FILE_LIMITS.perMessage} files at a time.`);
  const { classifyUpload, AttachmentRejectedError } = await import("./attachments");
  let total = 0;
  for (const f of files) {
    if (f.buf.length > PORTAL_FILE_LIMITS.maxBytes) throw new PortalRefusal(`“${f.name}” is too big. Files can be up to ${PORTAL_FILE_LIMITS.maxBytes / 1024 / 1024} MB.`, 413);
    try {
      classifyUpload(f.buf, f.name);
    } catch (e) {
      if (e instanceof AttachmentRejectedError) throw new PortalRefusal(`“${f.name}”: ${e.message}`, 415);
      throw e;
    }
    total += f.buf.length;
  }
  const used = await hqOne<{ n: number; bytes: string | number }>(
    `SELECT count(*)::int AS n, coalesce(sum(a.size), 0) AS bytes
       FROM hd_attachments a JOIN hd_messages m ON m.id = a.message_id
      WHERE a.ticket_id IN ${contactReachSql("$1::int")} AND m.author_id IS NULL
        AND lower(m.author_email) = (SELECT lower(c.email) FROM hd_portal_contacts c WHERE c.id = $1)
        AND a.created_at > now() - interval '1 day'`,
    [contactId]
  );
  if ((used?.n ?? 0) + files.length > PORTAL_FILE_LIMITS.dayFiles || Number(used?.bytes ?? 0) + total > PORTAL_FILE_LIMITS.dayBytes) {
    throw new PortalRefusal("You've sent as many files as we can take today. Try again tomorrow, or describe it in words.", 413);
  }
}

/** Store checked files, unbound and owned by nobody until bindPortalFiles puts them on the message. */
async function storePortalFiles(files: PortalFile[]): Promise<HdAttachment[]> {
  const { saveHelpdeskAttachment } = await import("./attachments");
  const out: HdAttachment[] = [];
  try {
    for (const f of files) out.push(await saveHelpdeskAttachment({ buf: f.buf, filename: f.name }));
  } catch (e) {
    await dropPortalFiles(out);
    throw e;
  }
  return out;
}

async function dropPortalFiles(atts: HdAttachment[]): Promise<void> {
  if (!atts.length) return;
  const rows = await hq<{ stored_name: string }>(
    "DELETE FROM hd_attachments WHERE id = ANY($1::bigint[]) AND message_id IS NULL RETURNING stored_name",
    [atts.map((a) => a.id)]
  );
  for (const r of rows) await deleteUpload(r.stored_name);
}

async function bindPortalFiles(atts: HdAttachment[], ticketId: number, messageId: number, client?: Parameters<typeof hq>[2]): Promise<void> {
  if (!atts.length) return;
  await hq(
    `UPDATE hd_attachments SET ticket_id = $2, message_id = $3
      WHERE id = ANY($1::bigint[]) AND message_id IS NULL AND ticket_id IS NULL AND uploaded_by IS NULL`,
    [atts.map((a) => a.id), ticketId, messageId],
    client
  );
}

// --- Raising a request and replying ------------------------------------------------

export interface PortalRequestInput {
  request_type_id: number;
  subject: string;
  body: string;
  answers: unknown;
  name?: string;
  files: PortalFile[];
}

const SUBJECT_MAX = 300;
const BODY_MAX = 20_000;

function textOf(answers: HdFormAnswers): string {
  return Object.values(answers)
    .filter((v) => typeof v === "string")
    .join("\n");
}

/** Raise a request as a contact. Throws PortalRefusal with the sentence to show. */
export async function createPortalRequest(
  contact: PortalContact,
  input: PortalRequestInput,
  ctx: { settings?: PortalSettings; /** Not used for links (portalHookOrigin). */ origin?: string; ip?: string | null } = {}
): Promise<{ number: number }> {
  const settings = ctx.settings ?? (await getPortalSettings());
  const offered = await offeredTypes(settings);
  const type = offered.find((t) => t.id === input.request_type_id);
  if (!type) throw new PortalRefusal("That kind of request isn't available.");
  const { getRequestType, validateAnswers } = await import("./request-types");
  const rt = await getRequestType(type.id);
  if (!rt) throw new PortalRefusal("That kind of request isn't available.");
  const checked = await validateAnswers(type.form, input.answers ?? {});
  if (!checked.ok) throw new PortalRefusal(checked.error);
  const subject = (input.subject ?? "").trim() || rt.title;
  const body = (input.body ?? "").trim();
  if (subject.length > SUBJECT_MAX) throw new PortalRefusal(`Keep the subject under ${SUBJECT_MAX} characters.`);
  if (body.length > BODY_MAX) throw new PortalRefusal("The description is too long.");
  const asksText = type.form.some((f) => f.type === "textarea");
  if (!asksText && !body) throw new PortalRefusal("Describe what you need.");
  const name = (input.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, PORTAL_TEXT_LIMITS.name);
  if (blockedWordIn(`${subject}\n${body}\n${name}\n${textOf(checked.value)}`, settings.blocked_words)) {
    throw new PortalRefusal("This request can't be sent as written. Please rephrase it.");
  }
  // New requests per mailbox per hour (the database count: a restart does
  // not reset it; "bob+1@" counts as bob@).
  const mailbox = canonicalMailbox(contact.email);
  const recent = await hqOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM hd_tickets t JOIN hd_portal_contacts c ON c.id = t.portal_contact_id
      WHERE ${mailboxSql("c.email")} = $1 AND t.created_at > now() - interval '1 hour'`,
    [mailbox]
  );
  if ((recent?.n ?? 0) >= settings.limits.requests_per_email_hour || hdRateLimited(`portal-new:${mailbox}`, settings.limits.requests_per_email_hour, 3_600_000)) {
    throw new PortalRefusal("You've sent several requests in the last hour. Try again a little later.", 429);
  }
  await checkPortalFiles(contact.id, input.files);
  if (name && name !== contact.name) await hq("UPDATE hd_portal_contacts SET name = $2 WHERE id = $1", [contact.id, name]);
  const displayName = name || contact.name || contact.email;

  const atts = await storePortalFiles(input.files);
  let row: { id: number; number: number; request_type_id: number | null; source: string; parent_ticket_id: number | null };
  try {
    const { insertTicketTx } = await import("./tickets");
    row = await withTx(async (client) => {
      const r = await insertTicketTx(client, {
        subject,
        body,
        requester: { id: null, name: displayName, email: contact.email },
        via: "customer_portal",
        source: "portal_external",
        source_ref: {},
        request_type_id: type.id,
        answers: checked.value,
        team_id: type.team_id,
        attachments: atts,
      });
      // In the same transaction, so every hook after the commit sees a portal ticket.
      await client.query("UPDATE hd_tickets SET portal_contact_id = $2 WHERE id = $1", [r.id, contact.id]);
      if (atts.length) {
        const first = (await client.query<{ id: number }>("SELECT id FROM hd_messages WHERE ticket_id = $1 ORDER BY id LIMIT 1", [r.id])).rows[0];
        if (first) await bindPortalFiles(atts, r.id, first.id, client);
      }
      return r;
    });
  } catch (e) {
    await dropPortalFiles(atts);
    throw e;
  }
  const { afterTicketCreated } = await import("./events");
  // Never ctx.origin (the request's Host): portalHookOrigin.
  await afterTicketCreated(row, { origin: await portalHookOrigin(), actorId: null, actorName: displayName });
  return { number: row.number };
}

/** A contact's reply on their own request. Throws PortalRefusal with the sentence to show. */
export async function addPortalReply(
  contact: PortalContact,
  number: number,
  input: { body: string; files: PortalFile[] },
  ctx: { settings?: PortalSettings; /** Not used for links (portalHookOrigin). */ origin?: string } = {}
): Promise<{ status: HdStatus }> {
  const settings = ctx.settings ?? (await getPortalSettings());
  const t = await contactTicket(contact.id, number);
  if (!t) throw new PortalRefusal("Not found.", 404);
  if (t.joined_into) throw new PortalRefusal(`This request was joined with #${t.joined_into}. Reply there.`, 409);
  if (t.status === "closed") throw new PortalRefusal("This request is closed. Send a new one.", 409);
  const body = (input.body ?? "").trim();
  if (body.length > BODY_MAX) throw new PortalRefusal("The reply is too long.");
  if (!body && !input.files.length) throw new PortalRefusal("Write a reply.");
  if (blockedWordIn(body, settings.blocked_words)) throw new PortalRefusal("This reply can't be sent as written. Please rephrase it.");
  await checkPortalFiles(contact.id, input.files);
  const atts = await storePortalFiles(input.files);
  const { addMessage } = await import("./messages");
  let res;
  try {
    res = await addMessage(
      t.id,
      {
        kind: "public",
        body,
        author: { id: null, name: (contact.name || contact.email).slice(0, 200), email: contact.email },
        via: "customer_portal",
        asRequester: true,
        attachments: atts,
      },
      // Never ctx.origin (the request's Host): portalHookOrigin.
      { origin: await portalHookOrigin(), actorId: null, actorName: contact.name || contact.email }
    );
  } catch (e) {
    await dropPortalFiles(atts);
    throw e;
  }
  if (!res) {
    await dropPortalFiles(atts);
    throw new PortalRefusal("Not found.", 404);
  }
  await bindPortalFiles(atts, t.id, res.message.id);
  return { status: res.status };
}

// --- Admin: contacts ------------------------------------------------------------------

export interface PortalContactRow extends PortalContact {
  requests: number;
  sessions: number;
}

export async function listPortalContacts(query = "", limit = 50): Promise<PortalContactRow[]> {
  const q = query.trim().toLowerCase().slice(0, 100);
  return hq<PortalContactRow>(
    `SELECT c.*,
            (SELECT count(*)::int FROM hd_tickets t WHERE t.portal_contact_id = c.id) AS requests,
            (SELECT count(*)::int FROM hd_portal_sessions s WHERE s.contact_id = c.id AND s.expires_at > now()) AS sessions
       FROM hd_portal_contacts c
      WHERE ($1 = '' OR lower(c.email) LIKE '%' || $1 || '%' OR lower(c.name) LIKE '%' || $1 || '%')
        AND (c.last_seen_at IS NOT NULL OR c.blocked = 1 OR EXISTS (SELECT 1 FROM hd_tickets t WHERE t.portal_contact_id = c.id))
      ORDER BY c.blocked DESC, c.last_seen_at DESC NULLS LAST, c.id DESC
      LIMIT $2`,
    [q.replace(/[%_\\]/g, (m) => `\\${m}`), Math.min(Math.max(limit, 1), 200)]
  );
}

/** Block or unblock a contact. Blocking signs every browser of theirs out. Answers whether it changed. */
export async function setContactBlocked(contactId: number, blocked: boolean): Promise<{ contact: PortalContact; changed: boolean; signedOut: number } | null> {
  const before = await getContact(contactId);
  if (!before) return null;
  const want = blocked ? 1 : 0;
  if (before.blocked === want) return { contact: before, changed: false, signedOut: 0 };
  const contact = (await hqOne<PortalContact>("UPDATE hd_portal_contacts SET blocked = $2 WHERE id = $1 RETURNING *", [contactId, want]))!;
  const signedOut = blocked ? await revokeContactSessions(contactId) : 0;
  if (blocked) await hq("UPDATE hd_portal_links SET used_at = now() WHERE contact_id = $1 AND used_at IS NULL", [contactId]);
  return { contact, changed: true, signedOut };
}

// --- The sweep ------------------------------------------------------------------------

/**
 * Housekeeping (lib/periodic HELPDESK_SWEEPS): spent and expired links
 * after a day, expired sessions, and contacts who asked for a link but
 * never signed in, raised nothing and are not blocked, after a week.
 */
export async function sweepPortal(): Promise<{ links: number; sessions: number; contacts: number }> {
  const links = await hq("DELETE FROM hd_portal_links WHERE expires_at < now() - interval '1 day' RETURNING contact_id");
  const sessions = await hq("DELETE FROM hd_portal_sessions WHERE expires_at < now() RETURNING id");
  const contacts = await hq(
    `DELETE FROM hd_portal_contacts c
      WHERE c.last_seen_at IS NULL AND c.blocked = 0 AND c.created_at < now() - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM hd_tickets t WHERE t.portal_contact_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM hd_portal_links l WHERE l.contact_id = c.id AND l.expires_at > now())
      RETURNING id`
  );
  return { links: links.length, sessions: sessions.length, contacts: contacts.length };
}
