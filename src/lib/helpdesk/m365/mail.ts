// Helpdesk 1.20.7: the Microsoft 365 mailbox connection. The desk reads each
// connected help mailbox directly through Microsoft Graph: no forwarding, no
// inbound provider, no EWS, no IMAP. The existing inbound webhook
// (lib/helpdesk/inbound) is untouched and keeps working beside it.
//
//   connection   one per workspace: a tenant, an app registration and its
//                client secret (sealed), saved under one settings key. The
//                one-click setup (enterprise overlay, ee/m365-mail-setup)
//                and the manual form both end in saveM365Connection. The
//                app is registered with NO Graph mail permission: an admin
//                grants it two Exchange Online roles over the help mailboxes
//                only (lib/helpdesk/m365-mail-shared restrictCommands), and
//                "Check access" (checkM365Access) says what it can reach.
//   mailboxes    hd_m365_mailboxes: shared or user mailboxes by their main
//                address. A help address (hd_mailboxes) is linked to the
//                mailbox it lives on (hd_m365_links); several may share one
//                (aliases) and the message is routed by the address it was
//                sent to, with the existing logic.
//   intake       every message becomes an InboundEmail (m365/message) and
//                goes through processInboundEmail, so sender verification,
//                reply tokens, who may add to a ticket, loops, duplicates,
//                rate limits and attachments are the pipeline's own. A
//                message is claimed in hd_m365_messages by its Graph id
//                before it is read, so it is taken in once whatever delivers
//                it (a notification, the timer, a restart, two instances).
//                Afterwards it is marked read or moved to a folder; one the
//                pipeline dropped (a loop, a duplicate, an auto-reply) too.
//                One that fails is left as it is and tried again, up to five
//                times, then counted and shown on the page.
//   new mail     Graph change notifications (a subscription per Inbox, POSTed
//                to /api/helpdesk/m365/notify/<key>) fetch the named message
//                at once; a delta query on a timer is the safety net and the
//                only way for an install Microsoft cannot reach. Mail that
//                was already in the Inbox when the mailbox was connected is
//                left alone.
//   background   m365MailSweep (lib/periodic, every minute): creates, renews
//                and re-creates subscriptions, runs the delta reads that are
//                due, retries, prunes. Idle (one settings read) when nothing
//                is connected.
//
// Everything is audited (helpdesk.m365.*). Server-only.

import "server-only";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { getSetting, setSetting } from "../../db";
import { audit, type AuditActor } from "../../audit";
import { logEvent } from "../../log";
import { openSecret, sealSecret } from "../../secretbox";
import { hq, hqOne } from "../db-core";
import { cleanMailboxAddress } from "../mailboxes-shared";
import type { InboundFile } from "../inbound-parse";
import {
  M365_DEFAULTS,
  M365_MAIL_LIMITS,
  M365_RENEW_BEFORE_MINUTES,
  M365_SAFETY_NET_MINUTES,
  M365_SUBSCRIPTION_MINUTES,
  M365_TENANT_WIDE,
  cleanFolderName,
  isGuid,
  m365CredentialsProblem,
  type M365AccessCheck,
  type M365AfterIntake,
  type M365LinkView,
  type M365MailView,
  type M365MailboxView,
  type M365Mode,
} from "../m365-mail-shared";
import { M365Error, graph, graphLink, m365TestBase, m365Token, userPath, type M365Credentials } from "./graph";
import { M365_MESSAGE_SELECT, graphMessageMeta, graphMessageToInbound } from "./message";
import { M365_MAIL_KEY, refreshM365State } from "./state";

export class M365MailError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = ""
  ) {
    super(message);
  }
}

export interface M365Actor {
  actor: AuditActor;
  ip?: string | null;
}

const IMMUTABLE = 'IdType="ImmutableId"';
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// --- The connection ----------------------------------------------------------------

export interface M365Config {
  tenant: string;
  client_id: string;
  /** '' = not connected. */
  secret: string;
  sp_object_id: string;
  setup: "one_click" | "manual" | "";
  secret_expires: string;
  verified: boolean;
  notify_key: string;
  notify_origin: string;
  after: M365AfterIntake;
  folder: string;
  notifications: boolean;
  poll_minutes: number;
  access: M365AccessCheck | null;
  /** The tenant the listed mailboxes belong to (kept when the connection is removed). */
  last_tenant: string;
}

const clampPoll = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(M365_MAIL_LIMITS.pollMax, Math.max(M365_MAIL_LIMITS.pollMin, n)) : M365_DEFAULTS.poll_minutes;
};

export async function getM365Config(): Promise<M365Config> {
  let v: Record<string, unknown> = {};
  try {
    const raw = await getSetting(M365_MAIL_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) v = parsed;
  } catch {
    v = {};
  }
  const open = (x: unknown) => {
    try {
      return typeof x === "string" && x ? openSecret(x) : "";
    } catch {
      return "";
    }
  };
  const access = v.access && typeof v.access === "object" ? (v.access as M365AccessCheck) : null;
  return {
    tenant: str(v.tenant),
    client_id: str(v.client_id),
    secret: open(v.key),
    sp_object_id: str(v.sp_object_id),
    setup: v.setup === "one_click" || v.setup === "manual" ? v.setup : "",
    secret_expires: str(v.secret_expires),
    verified: v.verified === true,
    notify_key: open(v.nk),
    notify_origin: str(v.notify_origin),
    after: v.after === "move" ? "move" : "read",
    folder: cleanFolderName(v.folder) || M365_DEFAULTS.folder,
    notifications: v.notifications !== false,
    poll_minutes: v.poll_minutes === undefined ? M365_DEFAULTS.poll_minutes : clampPoll(v.poll_minutes),
    access,
    last_tenant: str(v.last_tenant),
  };
}

async function writeConfig(c: M365Config): Promise<void> {
  await setSetting(
    M365_MAIL_KEY,
    JSON.stringify({
      tenant: c.tenant,
      client_id: c.client_id,
      key: c.secret ? sealSecret(c.secret) : "",
      sp_object_id: c.sp_object_id,
      setup: c.setup,
      secret_expires: c.secret_expires,
      verified: c.verified,
      nk: c.notify_key ? sealSecret(c.notify_key) : "",
      notify_origin: c.notify_origin,
      after: c.after,
      folder: c.folder,
      notifications: c.notifications,
      poll_minutes: c.poll_minutes,
      access: c.access,
      last_tenant: c.last_tenant,
    })
  );
  await refreshM365State();
  keyMemo = null;
}

const connected = (c: M365Config) => !!(c.tenant && c.client_id && c.secret);
const creds = (c: M365Config): M365Credentials => ({ tenant: c.tenant, clientId: c.client_id, secret: c.secret });

// --- Rows --------------------------------------------------------------------------

interface MbRow {
  id: number;
  address: string;
  sub_id: string;
  sub_expires_at: string | null;
  sub_state: string;
  sub_error: string;
  sub_error_at: string | null;
  last_notified_at: string | null;
  delta_link: string;
  poll_due: boolean;
  last_poll_at: string | null;
  last_ok_at: string | null;
  last_error: string;
  last_error_at: string | null;
  taken_in: number;
  dropped: number;
  failed: number;
  processed_folder_id: string;
  claimed_until: string | null;
  connected_at: string;
}

const listRows = () => hq<MbRow>("SELECT * FROM hd_m365_mailboxes ORDER BY id");
const getRow = (id: number) => hqOne<MbRow>("SELECT * FROM hd_m365_mailboxes WHERE id = $1", [id]);

interface LinkRow {
  mailbox_id: number;
  m365_mailbox_id: number;
  send_via: boolean;
  send_error: string;
  send_error_at: string | null;
  address: string;
  m365_address: string;
  send_address_id: number | null;
}

const LINKS = `SELECT l.mailbox_id, l.m365_mailbox_id, l.send_via, l.send_error, l.send_error_at, b.address, b.send_address_id, m.address AS m365_address
                 FROM hd_m365_links l JOIN hd_mailboxes b ON b.id = l.mailbox_id JOIN hd_m365_mailboxes m ON m.id = l.m365_mailbox_id`;
const listLinks = () => hq<LinkRow>(`${LINKS} ORDER BY b.position, b.id`);

/** The help addresses on one Microsoft 365 mailbox: the one that IS the mailbox's address first, then by position. */
async function ownAddresses(mb: { id: number; address: string }): Promise<string[]> {
  const rows = await hq<{ address: string }>(
    "SELECT b.address FROM hd_m365_links l JOIN hd_mailboxes b ON b.id = l.mailbox_id WHERE l.m365_mailbox_id = $1 ORDER BY (lower(b.address) = lower($2)) DESC, b.position, b.id",
    [mb.id, mb.address]
  );
  return rows.map((r) => r.address);
}

// --- Notifications: the address Microsoft posts to ------------------------------------

/**
 * The origin Microsoft could reach, or null: https, a real host name. The
 * test seam also admits loopback http, so the fake Microsoft can call back.
 */
export function notifyBase(origin: string): string | null {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1";
  if (m365TestBase() && u.protocol === "http:" && loopback) return u.origin;
  if (u.protocol !== "https:") return null;
  if (loopback || !host.includes(".") || host.includes(":") || /\.(local|internal|lan|test|invalid)$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host)) return null;
  return u.origin;
}

export const M365_NOTIFY_PATH = "/api/helpdesk/m365/notify";
const notifyUrl = (c: M365Config): string | null => {
  const base = notifyBase(c.notify_origin);
  return base && c.notify_key ? `${base}${M365_NOTIFY_PATH}/${c.notify_key}` : null;
};

function modeOf(c: M365Config, mb: MbRow, now: number): M365Mode {
  if (!c.notifications) return "timer_off";
  if (!notifyUrl(c)) return "timer_no_address";
  if (mb.sub_error) return "timer_refused";
  if (mb.sub_id && mb.sub_expires_at && Date.parse(mb.sub_expires_at) > now) return "notifications";
  return "timer_pending";
}

// --- The view ----------------------------------------------------------------------

/**
 * What the Email settings page shows. `origin`: where the admin opened the
 * desk; it is remembered as the address Microsoft posts notifications to
 * while none that Microsoft could reach is known. After that it changes
 * only when an admin says so (saveM365Settings notify_origin), so two
 * people opening the desk at two addresses never move it back and forth.
 */
export async function m365MailView(origin?: string | null): Promise<M365MailView> {
  let c = await getM365Config();
  if (origin && connected(c) && origin !== c.notify_origin && !notifyBase(c.notify_origin)) {
    c = { ...c, notify_origin: origin };
    await writeConfig(c);
  }
  const [rows, links] = await Promise.all([listRows(), listLinks()]);
  const now = Date.now();
  const mailboxes: M365MailboxView[] = rows.map((mb) => ({
    id: mb.id,
    address: mb.address,
    mode: modeOf(c, mb, now),
    sub_expires_at: mb.sub_id ? mb.sub_expires_at : null,
    sub_error: mb.sub_error,
    sub_error_at: mb.sub_error_at,
    last_notified_at: mb.last_notified_at,
    last_poll_at: mb.last_poll_at,
    last_ok_at: mb.last_ok_at,
    last_error: mb.last_error,
    last_error_at: mb.last_error_at,
    taken_in: mb.taken_in,
    dropped: mb.dropped,
    failed: mb.failed,
    connected_at: mb.connected_at,
    addresses: links.filter((l) => l.m365_mailbox_id === mb.id).map((l) => ({ id: l.mailbox_id, address: l.address, send_via: l.send_via && !l.send_address_id })),
  }));
  const linkViews: M365LinkView[] = links.map((l) => ({
    mailbox_id: l.mailbox_id,
    m365_mailbox_id: l.m365_mailbox_id,
    m365_address: l.m365_address,
    send_via: l.send_via && !l.send_address_id,
    send_error: l.send_error,
    send_error_at: l.send_error_at,
  }));
  return {
    connected: connected(c),
    tenant: c.tenant,
    client_id: c.client_id,
    sp_object_id: c.sp_object_id,
    secret_set: !!c.secret,
    secret_expires: c.secret_expires,
    setup: c.setup,
    verified: c.verified,
    after: c.after,
    folder: c.folder,
    notifications: c.notifications,
    poll_minutes: c.poll_minutes,
    notify_url_ok: !!notifyUrl(c),
    notify_origin: c.notify_origin,
    mailboxes,
    links: linkViews,
    access: connected(c) ? c.access : null,
    limit: M365_MAIL_LIMITS.mailboxes,
    orphaned: !connected(c) && rows.length > 0,
  };
}

// --- Saving the connection -----------------------------------------------------------

const OTHER_TENANT =
  "The mailboxes connected here belong to another Microsoft 365 organisation. Disconnect them first, then connect the new one.";

/** What the one-click setup must know before it creates anything in Entra. */
export async function m365SetupState(): Promise<{ connected: boolean; tenantInUse: string }> {
  const c = await getM365Config();
  const any = await hqOne("SELECT 1 FROM hd_m365_mailboxes LIMIT 1");
  return { connected: connected(c), tenantInUse: any ? c.last_tenant : "" };
}

export interface M365ConnectionInput {
  tenant?: unknown;
  client_id?: unknown;
  secret?: unknown;
}

/**
 * Save an app registration, after signing in with it. The tenant kept is the
 * one the token signs in to (its `tid`), never the text that was typed; the
 * enterprise application's object ID (the token's `oid`) is kept for the
 * restrict-access commands.
 *
 *   setup "manual"     the form: a refused sign-in refuses the save (409,
 *                      Microsoft's reason). An empty secret keeps the saved
 *                      one when the tenant and client ID are unchanged.
 *   setup "one_click"  the enterprise overlay, with an app it created a
 *                      moment ago in `tenantId`: `verify: false` saves it
 *                      although Microsoft has not finished activating it
 *                      (the secret is shown once), and the page says so.
 *
 * Mailboxes listed from another tenant refuse it ("tenant_change").
 */
export async function saveM365Connection(
  raw: M365ConnectionInput,
  by: M365Actor,
  opts: { setup?: "manual" | "one_click"; verify?: boolean; tenantId?: string; spObjectId?: string; secretExpires?: string } = {}
): Promise<{ created: boolean; verified: boolean; tenant: string; client_id: string }> {
  const setup = opts.setup ?? "manual";
  const cur = await getM365Config();
  const tenantTyped = str(raw.tenant).trim().toLowerCase();
  const clientId = str(raw.client_id).trim().toLowerCase();
  let secret = str(raw.secret).trim();
  const sameApp = connected(cur) && cur.client_id === clientId && (cur.tenant === tenantTyped || !tenantTyped);
  const problem = m365CredentialsProblem({ tenant: tenantTyped || (sameApp ? cur.tenant : ""), client_id: clientId, secret }, sameApp);
  if (problem) throw new M365MailError(problem);
  if (!secret) secret = cur.secret;
  let tenant = tenantTyped || cur.tenant;
  if (setup === "one_click") {
    const tid = (opts.tenantId ?? "").trim().toLowerCase();
    if (!isGuid(tid) || tenant !== tid) throw new M365MailError("The app registration's tenant must be the ID of the tenant it was created in.");
  }

  let verified = false;
  let oid = (opts.spObjectId ?? "").trim().toLowerCase();
  if (opts.verify !== false) {
    try {
      const token = await m365Token({ tenant, clientId, secret }, true);
      verified = true;
      if (token.claims.tid) tenant = token.claims.tid;
      if (token.claims.oid) oid = token.claims.oid;
    } catch (e) {
      if (e instanceof M365Error) throw new M365MailError(e.message, e.kind === "auth" ? 409 : 502, e.kind === "auth" ? "signin" : "unreachable");
      throw e;
    }
  }
  const any = await hqOne("SELECT 1 FROM hd_m365_mailboxes LIMIT 1");
  if (any && cur.last_tenant && isGuid(tenant) && cur.last_tenant !== tenant) throw new M365MailError(OTHER_TENANT, 409, "tenant_change");

  const created = !connected(cur);
  const changed: string[] = [];
  if (cur.tenant !== tenant) changed.push("tenant");
  if (cur.client_id !== clientId) changed.push("client_id");
  if (cur.secret !== secret) changed.push("secret");
  const next: M365Config = {
    ...cur,
    tenant,
    client_id: clientId,
    secret,
    sp_object_id: isGuid(oid) ? oid : sameApp ? cur.sp_object_id : "",
    setup,
    secret_expires: opts.secretExpires ?? (cur.secret === secret ? cur.secret_expires : ""),
    verified,
    notify_key: cur.notify_key || randomBytes(24).toString("base64url"),
    access: sameApp ? cur.access : null,
    last_tenant: isGuid(tenant) ? tenant : cur.last_tenant,
  };
  await writeConfig(next);
  if (!sameApp) {
    // Another app: its subscriptions and delta links are not this one's.
    await hq("UPDATE hd_m365_mailboxes SET sub_id = '', sub_state = '', sub_expires_at = NULL, sub_error = '', sub_error_at = NULL, poll_due = true, updated_at = now()");
  }
  await audit({
    actor: by.actor,
    action: "helpdesk.m365.connection_saved",
    targetType: "helpdesk_settings",
    targetId: "m365_mail",
    targetLabel: "Email: Microsoft 365",
    // What changed, the tenant and client ID; never the secret.
    details: { created, changed, tenant, client_id: clientId, setup, verified, ...(opts.secretExpires ? { secret_expires: opts.secretExpires } : {}) },
    ip: by.ip ?? null,
  });
  return { created, verified, tenant, client_id: clientId };
}

/** Forget the app registration. Subscriptions are deleted at Microsoft first (best effort); the mailboxes stay listed, idle. */
export async function removeM365Connection(by: M365Actor): Promise<boolean> {
  const cur = await getM365Config();
  if (!connected(cur)) return false;
  for (const mb of await listRows()) if (mb.sub_id) await dropSubscription(cur, mb);
  await writeConfig({ ...cur, client_id: "", secret: "", sp_object_id: "", setup: "", secret_expires: "", verified: false, access: null });
  await hq("UPDATE hd_m365_mailboxes SET sub_id = '', sub_state = '', sub_expires_at = NULL, sub_error = '', sub_error_at = NULL, delta_link = '', poll_due = false, claimed_until = NULL, updated_at = now()");
  await hq("UPDATE hd_m365_links SET send_error = '', send_error_at = NULL");
  await audit({
    actor: by.actor,
    action: "helpdesk.m365.connection_removed",
    targetType: "helpdesk_settings",
    targetId: "m365_mail",
    targetLabel: "Email: Microsoft 365",
    details: { tenant: cur.tenant, client_id: cur.client_id },
    ip: by.ip ?? null,
  });
  return true;
}

export interface M365SettingsInput {
  after?: unknown;
  folder?: unknown;
  notifications?: unknown;
  poll_minutes?: unknown;
  /** The address Microsoft posts notifications to (the origin the admin has the desk open at). */
  notify_origin?: unknown;
}

/** The workspace's choices: what happens to a message after intake, notifications on or off, the timer. */
export async function saveM365Settings(raw: M365SettingsInput, by: M365Actor): Promise<string[]> {
  const cur = await getM365Config();
  const next = { ...cur };
  if (raw.after !== undefined) {
    if (raw.after !== "read" && raw.after !== "move") throw new M365MailError("Choose Mark as read or Move to a folder.");
    next.after = raw.after;
  }
  if (raw.folder !== undefined) {
    const folder = cleanFolderName(raw.folder);
    if (!folder) throw new M365MailError("Give the folder a name.");
    next.folder = folder;
  }
  if (raw.notifications !== undefined) next.notifications = raw.notifications === true;
  if (raw.poll_minutes !== undefined) {
    const n = Number(raw.poll_minutes);
    if (!Number.isInteger(n) || n < M365_MAIL_LIMITS.pollMin || n > M365_MAIL_LIMITS.pollMax) {
      throw new M365MailError(`Check between every ${M365_MAIL_LIMITS.pollMin} and every ${M365_MAIL_LIMITS.pollMax} minutes.`);
    }
    next.poll_minutes = n;
  }
  if (raw.notify_origin !== undefined) {
    const base = notifyBase(str(raw.notify_origin));
    if (!base) throw new M365MailError("Microsoft can't reach that address. It needs a public https address.");
    next.notify_origin = base;
  }
  const changed = (["after", "folder", "notifications", "poll_minutes", "notify_origin"] as const).filter((k) => cur[k] !== next[k]);
  if (!changed.length) return [];
  await writeConfig(next);
  if (changed.includes("folder") || changed.includes("after")) await hq("UPDATE hd_m365_mailboxes SET processed_folder_id = '', updated_at = now()");
  // Off: the subscriptions go. Another address: they still name the old one, so they go too and the next tick makes new ones.
  if (((changed.includes("notifications") && !next.notifications) || changed.includes("notify_origin")) && connected(next)) {
    for (const mb of await listRows()) if (mb.sub_id) await dropSubscription(next, mb);
  }
  await audit({
    actor: by.actor,
    action: "helpdesk.m365.settings_changed",
    targetType: "helpdesk_settings",
    targetId: "m365_mail",
    targetLabel: "Email: Microsoft 365",
    details: { changed, after: next.after, folder: next.folder, notifications: next.notifications, poll_minutes: next.poll_minutes, notify_origin: next.notify_origin },
    ip: by.ip ?? null,
  });
  return changed;
}

// --- Mailboxes -----------------------------------------------------------------------

export const NOT_A_MAILBOX =
  "Distribution lists, Microsoft 365 groups, mail contacts and mailboxes in another organisation can't be connected. Use a shared mailbox instead.";
const WAITING = "Microsoft 365 has not let the app read this mailbox yet. Run the commands under Limit access, then press Check access. A change can take up to two hours to apply.";

/** Whether a refusal says "this is not a mailbox the app could ever read" (as opposed to "not allowed yet"). */
const notAMailbox = (e: M365Error) => {
  const c = e.code.toLowerCase();
  return e.status === 404 || c === "errorinvaliduser" || c === "resourcenotfound" || c === "request_resourcenotfound" || c === "mailboxnotenabledforrestapi" || c === "mailboxnotsupportedforrestapi";
};

async function probeInbox(c: M365Config, address: string): Promise<void> {
  await graph(creds(c), { path: `${userPath(address)}/mailFolders/inbox?$select=id`, what: "read this mailbox" });
}

/**
 * Connect a mailbox by its main address. Microsoft is asked for its Inbox
 * first: an address that is no mailbox (a distribution list, a group, a
 * contact, another organisation's) is refused with what to use instead. A
 * mailbox the app is not allowed to read yet is listed all the same, waiting:
 * the restrict-access commands need its address before they can be run.
 */
export async function connectM365Mailbox(rawAddress: unknown, by: M365Actor): Promise<{ id: number; address: string; waiting: boolean; linked: string | null }> {
  const c = await getM365Config();
  if (!connected(c)) throw new M365MailError("Connect Microsoft 365 first.", 409);
  const typed = str(rawAddress).trim();
  if (!typed) throw new M365MailError("Enter the mailbox's address.");
  if (typed.includes("+")) throw new M365MailError("Leave out the + tag: enter the mailbox's main address.");
  const address = cleanMailboxAddress(typed);
  if (!address) throw new M365MailError("That is not an email address.");
  const rows = await listRows();
  if (rows.some((r) => r.address.toLowerCase() === address)) throw new M365MailError("That mailbox is already connected.", 409);
  if (rows.length >= M365_MAIL_LIMITS.mailboxes) throw new M365MailError(`Up to ${M365_MAIL_LIMITS.mailboxes} mailboxes can be connected.`, 409);

  let waiting = false;
  try {
    await probeInbox(c, address);
  } catch (e) {
    if (!(e instanceof M365Error)) throw e;
    if (notAMailbox(e)) throw new M365MailError(`${e.message} ${NOT_A_MAILBOX}`, 422, "not_a_mailbox");
    if (e.status === 403) waiting = true;
    else throw new M365MailError(e.message, e.kind === "auth" ? 409 : 502);
  }
  let id: number;
  try {
    const row = await hqOne<{ id: number }>("INSERT INTO hd_m365_mailboxes (address, last_error, last_error_at, poll_due) VALUES ($1, $2, $3, $4) RETURNING id", [
      address,
      waiting ? WAITING : "",
      waiting ? new Date().toISOString() : null,
      !waiting,
    ]);
    id = row!.id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new M365MailError("That mailbox is already connected.", 409);
    throw e;
  }
  // A help address with the same address lives on this mailbox, unless it is already placed elsewhere.
  const own = await hqOne<{ id: number; address: string }>(
    "INSERT INTO hd_m365_links (mailbox_id, m365_mailbox_id) SELECT b.id, $1 FROM hd_mailboxes b WHERE lower(b.address) = $2 ON CONFLICT (mailbox_id) DO NOTHING RETURNING mailbox_id AS id, $2 AS address",
    [id, address]
  );
  await refreshM365State();
  await audit({
    actor: by.actor,
    action: "helpdesk.m365.mailbox_connected",
    targetType: "helpdesk_m365_mailbox",
    targetId: id,
    targetLabel: address,
    details: { address, waiting_for_access: waiting, linked_help_address: own ? address : null },
    ip: by.ip ?? null,
  });
  return { id, address, waiting, linked: own ? address : null };
}

/** Stop reading a mailbox: its subscription is deleted at Microsoft (best effort), its links and its record of read messages go with it. */
export async function disconnectM365Mailbox(id: number, by: M365Actor): Promise<{ address: string; unlinked: string[] } | undefined> {
  const mb = await getRow(id);
  if (!mb) return undefined;
  const c = await getM365Config();
  if (mb.sub_id && connected(c)) await dropSubscription(c, mb);
  const unlinked = (await hq<{ address: string }>("SELECT b.address FROM hd_m365_links l JOIN hd_mailboxes b ON b.id = l.mailbox_id WHERE l.m365_mailbox_id = $1", [id])).map((r) => r.address);
  await hq("DELETE FROM hd_m365_mailboxes WHERE id = $1", [id]);
  await refreshM365State();
  await audit({
    actor: by.actor,
    action: "helpdesk.m365.mailbox_disconnected",
    targetType: "helpdesk_m365_mailbox",
    targetId: id,
    targetLabel: mb.address,
    details: { address: mb.address, help_addresses: unlinked },
    ip: by.ip ?? null,
  });
  return { address: mb.address, unlinked };
}

export interface M365LinkInput {
  /** The connected mailbox this help address lives on; null = none (the inbound webhook). */
  m365_mailbox_id?: unknown;
  send_via?: unknown;
}

/**
 * Say which connected mailbox a help address lives on, and whether its
 * replies go out through Microsoft Graph. Sending through Graph is one more
 * choice of "Send replies from": choosing it clears a picked send-from
 * address (through updateMailbox, so its own rules and audit hold), and a
 * send-from address picked later takes over again.
 */
export async function setM365AddressLink(helpMailboxId: number, raw: M365LinkInput, by: M365Actor): Promise<M365LinkView | null> {
  const mailboxes = await import("../mailboxes");
  const box = await mailboxes.getMailbox(helpMailboxId);
  if (!box) throw new M365MailError("That address is no longer listed.", 404);
  const before = await hqOne<LinkRow>(`${LINKS} WHERE l.mailbox_id = $1`, [helpMailboxId]);
  const target = raw.m365_mailbox_id === undefined ? (before?.m365_mailbox_id ?? null) : raw.m365_mailbox_id;
  if (target === null) {
    if (before) {
      await hq("DELETE FROM hd_m365_links WHERE mailbox_id = $1", [helpMailboxId]);
      await refreshM365State();
      await audit({
        actor: by.actor,
        action: "helpdesk.m365.address_changed",
        targetType: "helpdesk_mailbox",
        targetId: helpMailboxId,
        targetLabel: box.address,
        details: { address: box.address, mailbox: null, was: before.m365_address, send_via: false },
        ip: by.ip ?? null,
      });
    }
    return null;
  }
  if (typeof target !== "number" || !Number.isInteger(target)) throw new M365MailError("Choose a connected mailbox.");
  const mb = await getRow(target);
  if (!mb) throw new M365MailError("That mailbox is no longer connected.", 409);
  const sendVia = raw.send_via === undefined ? (before?.m365_mailbox_id === target ? before.send_via : false) : raw.send_via === true;
  if (sendVia && box.send_address_id) await mailboxes.updateMailbox(helpMailboxId, { send_address_id: null }, by);
  await hq(
    `INSERT INTO hd_m365_links (mailbox_id, m365_mailbox_id, send_via) VALUES ($1, $2, $3)
     ON CONFLICT (mailbox_id) DO UPDATE SET m365_mailbox_id = EXCLUDED.m365_mailbox_id, send_via = EXCLUDED.send_via,
       send_error = CASE WHEN EXCLUDED.send_via AND hd_m365_links.m365_mailbox_id = EXCLUDED.m365_mailbox_id THEN hd_m365_links.send_error ELSE '' END,
       send_error_at = CASE WHEN EXCLUDED.send_via AND hd_m365_links.m365_mailbox_id = EXCLUDED.m365_mailbox_id THEN hd_m365_links.send_error_at ELSE NULL END,
       updated_at = now()`,
    [helpMailboxId, target, sendVia]
  );
  await refreshM365State();
  if (!before || before.m365_mailbox_id !== target || before.send_via !== sendVia) {
    await audit({
      actor: by.actor,
      action: "helpdesk.m365.address_changed",
      targetType: "helpdesk_mailbox",
      targetId: helpMailboxId,
      targetLabel: box.address,
      details: { address: box.address, mailbox: mb.address, was: before?.m365_address ?? null, send_via: sendVia },
      ip: by.ip ?? null,
    });
  }
  const now = await hqOne<LinkRow>(`${LINKS} WHERE l.mailbox_id = $1`, [helpMailboxId]);
  return now ? { mailbox_id: now.mailbox_id, m365_mailbox_id: now.m365_mailbox_id, m365_address: now.m365_address, send_via: now.send_via && !now.send_address_id, send_error: now.send_error, send_error_at: now.send_error_at } : null;
}

// --- Check access ----------------------------------------------------------------------

/**
 * What the app can reach right now, in plain terms: whether its token
 * carries Graph mail permissions granted in Entra (then it reaches EVERY
 * mailbox, whatever Exchange was told), whether each connected mailbox can
 * be read, and, when the admin names one, whether a mailbox that should be
 * out of reach really is. Saved for the page and audited.
 */
export async function checkM365Access(raw: { probe?: unknown }, by: M365Actor): Promise<M365AccessCheck> {
  const c = await getM365Config();
  if (!connected(c)) throw new M365MailError("Connect Microsoft 365 first.", 409);
  let probeAddress: string | null = null;
  if (raw.probe !== undefined && raw.probe !== null && str(raw.probe).trim()) {
    probeAddress = cleanMailboxAddress(str(raw.probe));
    if (!probeAddress) throw new M365MailError("The mailbox to test is not an email address.");
  }
  let claims;
  try {
    claims = (await m365Token(creds(c), true)).claims;
  } catch (e) {
    if (e instanceof M365Error) throw new M365MailError(e.message, e.kind === "auth" ? 409 : 502);
    throw e;
  }
  const wide = new Set(M365_TENANT_WIDE.map((r) => r.toLowerCase()));
  const tenantWide = claims.roles.filter((r) => wide.has(r.toLowerCase()));
  const rows = await listRows();
  const mailboxes: M365AccessCheck["mailboxes"] = [];
  for (const mb of rows) {
    try {
      await probeInbox(c, mb.address);
      mailboxes.push({ address: mb.address, ok: true, error: "" });
      // Reachable now: a mailbox that was waiting is read at the next tick.
      await hq("UPDATE hd_m365_mailboxes SET last_error = '', last_error_at = NULL, poll_due = true, updated_at = now() WHERE id = $1 AND last_error = $2", [mb.id, WAITING]);
    } catch (e) {
      const m = e instanceof M365Error ? (notAMailbox(e) ? `${e.message} ${NOT_A_MAILBOX}` : e.message) : "The check failed.";
      mailboxes.push({ address: mb.address, ok: false, error: m });
    }
  }
  let probe: M365AccessCheck["probe"] = null;
  if (probeAddress) {
    if (rows.some((r) => r.address.toLowerCase() === probeAddress)) {
      probe = { address: probeAddress, reachable: true, note: "This is one of the connected mailboxes. Name a mailbox the desk should not reach." };
    } else {
      try {
        await probeInbox(c, probeAddress);
        probe = { address: probeAddress, reachable: true, note: "The app can read this mailbox. It is not limited to your help mailboxes." };
      } catch (e) {
        if (e instanceof M365Error && e.status === 403) probe = { address: probeAddress, reachable: false, note: "Microsoft 365 refused, as it should. The app can't read this mailbox." };
        else if (e instanceof M365Error && notAMailbox(e)) probe = { address: probeAddress, reachable: false, note: "Microsoft 365 found no mailbox with that address, so this proves nothing. Name a real mailbox." };
        else probe = { address: probeAddress, reachable: false, note: e instanceof M365Error ? e.message : "The check failed." };
      }
    }
  }
  const access: M365AccessCheck = { at: new Date().toISOString(), tenant_wide: tenantWide, mailboxes, probe };
  const fresh = await getM365Config();
  await writeConfig({ ...fresh, access, verified: true, sp_object_id: claims.oid || fresh.sp_object_id, tenant: claims.tid || fresh.tenant, last_tenant: claims.tid || fresh.last_tenant });
  await audit({
    actor: by.actor,
    action: "helpdesk.m365.access_checked",
    targetType: "helpdesk_settings",
    targetId: "m365_mail",
    targetLabel: "Email: Microsoft 365",
    details: {
      tenant_wide: tenantWide,
      reachable: mailboxes.filter((m) => m.ok).map((m) => m.address),
      refused: mailboxes.filter((m) => !m.ok).map((m) => m.address),
      ...(probe ? { probe: probe.address, probe_reachable: probe.reachable } : {}),
    },
    ip: by.ip ?? null,
  });
  return access;
}

// --- Intake ----------------------------------------------------------------------------

type IntakeResult = "taken" | "dropped" | "skipped" | "deferred" | "failed" | "busy";

const TAKEN = new Set(["created", "appended", "follow_up", "alert_created", "alert_updated", "alert_reopened", "alert_resolved"]);
/** Only mail that arrived after the mailbox was connected, and never older than two weeks (a full re-read after a lost delta link must not replay history). */
const floorOf = (mb: MbRow, now: number) => Math.max(Date.parse(mb.connected_at) || 0, now - 14 * 86_400_000);
const validId = (id: string) => id.length > 0 && id.length <= 1024 && !/[\s\u0000-\u001f]/.test(id);

let oversize: Buffer | null = null;
/** Stands in for a file that is too large to fetch: the pipeline refuses it by its length alone, in its own words. */
function oversizeStub(limit: number): Buffer {
  return (oversize ??= Buffer.alloc(limit + 1));
}

/** A message's file attachments as the pipeline takes them. Sizes and names are the sender's: nothing over the pipeline's own limits is fetched. */
async function fetchFiles(c: M365Config, mb: MbRow, id: string): Promise<InboundFile[]> {
  const { INBOUND_LIMITS } = await import("../inbound");
  const base = `${userPath(mb.address)}/messages/${encodeURIComponent(id)}/attachments`;
  const list = await graph<{ value?: unknown[] }>(creds(c), { path: `${base}?$select=id,name,contentType,size,isInline&$top=30`, prefer: [IMMUTABLE], what: "read a message's attachments" });
  const files: InboundFile[] = [];
  let total = 0;
  for (const raw of (Array.isArray(list.value) ? list.value : []).slice(0, 30)) {
    const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const aid = str(a?.id);
    if (!a || !aid) continue;
    const name = str(a.name).slice(0, 300) || "attachment";
    const type = str(a.contentType).slice(0, 200);
    const size = Number(a.size) || 0;
    const kind = str(a["@odata.type"]).toLowerCase();
    if (kind && !kind.endsWith("fileattachment")) {
      // An attached message or a link to a cloud file: not a file the desk stores. The pipeline lists it as not added.
      files.push({ name: `${name}.item`, type, data: Buffer.from("x") });
      continue;
    }
    if (size > INBOUND_LIMITS.fileBytes * 1.4 || total > INBOUND_LIMITS.totalBytes + INBOUND_LIMITS.fileBytes) {
      files.push({ name, type, data: oversizeStub(INBOUND_LIMITS.fileBytes) });
      continue;
    }
    let data: Buffer;
    try {
      data = await graph<Buffer>(creds(c), { path: `${base}/${encodeURIComponent(aid)}/$value`, as: "bytes", maxBytes: INBOUND_LIMITS.fileBytes + 1, prefer: [IMMUTABLE], what: "read an attachment" });
    } catch (e) {
      if (e instanceof M365Error && e.kind === "too_large") data = oversizeStub(INBOUND_LIMITS.fileBytes);
      else throw e;
    }
    total += data.length;
    files.push({ name, type, data });
  }
  return files;
}

async function finish(mb: MbRow, id: string, outcome: string, opts: { filed?: boolean; count?: "taken_in" | "dropped" } = {}): Promise<void> {
  await hq("UPDATE hd_m365_messages SET state = 'done', outcome = $3, error = '', filed = $4, updated_at = now() WHERE mailbox_id = $1 AND message_id = $2", [mb.id, id, outcome.slice(0, 60), opts.filed === true]);
  if (opts.count) await hq(`UPDATE hd_m365_mailboxes SET ${opts.count} = ${opts.count} + 1, updated_at = now() WHERE id = $1`, [mb.id]);
}

/**
 * Take one message in, exactly once. The claim is a row keyed by the
 * message's Graph id: whoever inserts it (or takes over a failed or stale
 * one) works the message; everyone else leaves it.
 */
async function intakeOne(c: M365Config, mb: MbRow, id: string): Promise<IntakeResult> {
  if (!validId(id)) return "skipped";
  const claim = await hqOne<{ attempts: number }>(
    `INSERT INTO hd_m365_messages (mailbox_id, message_id, state, attempts, claimed_at) VALUES ($1, $2, 'working', 1, now())
     ON CONFLICT (mailbox_id, message_id) DO UPDATE SET state = 'working', attempts = hd_m365_messages.attempts + 1, claimed_at = now(), updated_at = now()
       WHERE hd_m365_messages.attempts < $3
         AND (hd_m365_messages.state = 'failed' OR (hd_m365_messages.state = 'working' AND hd_m365_messages.claimed_at < now() - interval '10 minutes'))
     RETURNING attempts`,
    [mb.id, id, M365_MAIL_LIMITS.attempts]
  );
  if (!claim) return "busy";
  try {
    const msg = await graph(creds(c), {
      path: `${userPath(mb.address)}/messages/${encodeURIComponent(id)}?$select=${M365_MESSAGE_SELECT}`,
      prefer: [IMMUTABLE],
      what: "read a message",
    });
    const meta = graphMessageMeta(msg);
    if (!meta) throw new Error("Microsoft 365 sent no message.");
    // A draft was never delivered by Exchange (someone with the mailbox open wrote it there): not mail.
    if (meta.isDraft) {
      await finish(mb, id, "skipped_draft", { filed: true });
      return "skipped";
    }
    const received = Date.parse(meta.receivedAt);
    if (Number.isFinite(received) && received < floorOf(mb, Date.now())) {
      await finish(mb, id, "skipped_old", { filed: true });
      return "skipped";
    }
    const body = msg.body && typeof msg.body === "object" ? str((msg.body as Record<string, unknown>).content) : "";
    const files = meta.hasAttachments || /\bcid:/i.test(body.slice(0, 2_000_000)) ? await fetchFiles(c, mb, id) : [];
    const conv = graphMessageToInbound(msg, files, await ownAddresses(mb));
    if (!conv) {
      await finish(mb, id, "skipped_no_sender", { count: "dropped" });
      await fileMessage(c, mb, id).catch(() => {});
      return "dropped";
    }
    const { processInboundEmail } = await import("../inbound");
    const origin = notifyBase(c.notify_origin) ?? undefined;
    const result = await processInboundEmail(conv.email, { origin, ip: null });
    if (result.status === 429) {
      // The pipeline's own rate limit: not a failure of this message. It is tried again without using up a try.
      await hq(
        "UPDATE hd_m365_messages SET state = 'failed', attempts = GREATEST(attempts - 1, 0), error = $3, updated_at = now() WHERE mailbox_id = $1 AND message_id = $2",
        [mb.id, id, "Too many messages at once. It is tried again shortly."]
      );
      return "deferred";
    }
    if (result.status !== 200) throw new Error(result.body.error || `The inbound pipeline answered ${result.status}.`);
    const outcome = result.body.outcome ?? "";
    const taken = TAKEN.has(outcome);
    await finish(mb, id, outcome, { count: taken ? "taken_in" : "dropped" });
    logEvent("info", "helpdesk.m365_intake", { mailbox: mb.address, outcome, sender_check: conv.verdict.kind, ticket: result.body.ticket ?? null });
    // Dropped ones (a loop, a duplicate, an auto-reply, a refused sender) are filed too, so the Inbox does not fill up.
    await fileMessage(c, mb, id).catch((e) => logEvent("warn", "helpdesk.m365_file_failed", { mailbox: mb.address, error: e instanceof Error ? e.message : String(e) }));
    return taken ? "taken" : "dropped";
  } catch (e) {
    if (e instanceof M365Error && e.status === 404) {
      // Deleted or moved by a person before the desk read it.
      await finish(mb, id, "gone", { filed: true });
      return "skipped";
    }
    const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
    const final = claim.attempts >= M365_MAIL_LIMITS.attempts;
    await hq("UPDATE hd_m365_messages SET state = 'failed', error = $3, updated_at = now() WHERE mailbox_id = $1 AND message_id = $2", [mb.id, id, message]);
    logEvent(final ? "error" : "warn", "helpdesk.m365_intake_failed", { mailbox: mb.address, attempt: claim.attempts, final, error: message });
    if (final) {
      await hq("UPDATE hd_m365_mailboxes SET failed = failed + 1, updated_at = now() WHERE id = $1", [mb.id]);
      await audit({
        actor: { name: "Microsoft 365 mail" },
        action: "helpdesk.m365.intake_failed",
        targetType: "helpdesk_m365_mailbox",
        targetId: mb.id,
        targetLabel: mb.address,
        details: { address: mb.address, attempts: claim.attempts, error: message },
      });
    }
    return "failed";
  }
}

const odataQuote = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** The id of the folder messages are moved to: found by name at the top of the mailbox, else made. */
async function processedFolder(c: M365Config, mb: MbRow, fresh = false): Promise<string> {
  if (mb.processed_folder_id && !fresh) return mb.processed_folder_id;
  const find = async (): Promise<string> => {
    const r = await graph<{ value?: { id?: string; displayName?: string }[] }>(creds(c), {
      path: `${userPath(mb.address)}/mailFolders?$filter=${encodeURIComponent(`displayName eq ${odataQuote(c.folder)}`)}&$select=id,displayName&$top=10`,
      what: "look for the folder",
    });
    return str((r.value ?? []).find((f) => str(f.displayName).toLowerCase() === c.folder.toLowerCase())?.id);
  };
  let id = await find();
  if (!id) {
    try {
      id = str((await graph<{ id?: string }>(creds(c), { method: "POST", path: `${userPath(mb.address)}/mailFolders`, body: { displayName: c.folder }, what: "make the folder" })).id);
    } catch (e) {
      // Made by another instance in the same moment.
      if (e instanceof M365Error && (e.status === 409 || /exists/i.test(e.code))) id = await find();
      else throw e;
    }
  }
  if (!id) throw new M365Error(`Microsoft 365 did not hand back the "${c.folder}" folder.`, 0, "not_json");
  await hq("UPDATE hd_m365_mailboxes SET processed_folder_id = $2, updated_at = now() WHERE id = $1", [mb.id, id]);
  mb.processed_folder_id = id;
  return id;
}

/** After intake: mark the message read, and move it when that is the workspace's choice. */
async function fileMessage(c: M365Config, mb: MbRow, id: string): Promise<void> {
  const path = `${userPath(mb.address)}/messages/${encodeURIComponent(id)}`;
  const done = () => hq("UPDATE hd_m365_messages SET filed = true, updated_at = now() WHERE mailbox_id = $1 AND message_id = $2", [mb.id, id]);
  try {
    await graph(creds(c), { method: "PATCH", path, body: { isRead: true }, prefer: [IMMUTABLE], what: "mark a message as read" });
    if (c.after === "move") {
      const move = async (fresh: boolean) =>
        graph(creds(c), { method: "POST", path: `${path}/move`, body: { destinationId: await processedFolder(c, mb, fresh) }, prefer: [IMMUTABLE], what: "move a message" });
      try {
        await move(false);
      } catch (e) {
        // The folder was deleted or renamed away: find or make it again, once.
        if (!(e instanceof M365Error) || (e.status !== 404 && e.status !== 400)) throw e;
        await move(true);
      }
    }
  } catch (e) {
    if (e instanceof M365Error && e.status === 404) {
      await done();
      return;
    }
    throw e;
  }
  await done();
}

const isResync = (e: unknown) => e instanceof M365Error && (e.status === 410 || /^(syncstatenotfound|resyncrequired|syncstateinvalid)$/i.test(e.code));
const DELTA_PAGE = 50;
const DELTA_MAX_PAGES = 40;

/** One round of the delta query for a mailbox's Inbox: every message that arrived since the last round is taken in. */
async function deltaRound(c: M365Config, mb: MbRow): Promise<void> {
  const prefer = [IMMUTABLE, `odata.maxpagesize=${DELTA_PAGE}`];
  const first = `${userPath(mb.address)}/mailFolders/inbox/messages/delta?$select=id,receivedDateTime,isDraft`;
  const floor = floorOf(mb, Date.now());
  let link = mb.delta_link;
  let restarted = false;
  for (let page = 0; page < DELTA_MAX_PAGES; page++) {
    let r: Record<string, unknown>;
    try {
      r = await graph(creds(c), link ? { link, prefer, what: "read the mailbox" } : { path: first, prefer, what: "read the mailbox" });
    } catch (e) {
      // The link expired at Microsoft (410), or the stored one is not a Graph link: a full round, once.
      if (link && !restarted && (isResync(e) || (e instanceof M365Error && e.kind === "blocked" && e.status === 0))) {
        restarted = true;
        link = "";
        await hq("UPDATE hd_m365_mailboxes SET delta_link = '', updated_at = now() WHERE id = $1", [mb.id]);
        logEvent("info", "helpdesk.m365_resync", { mailbox: mb.address });
        page = -1;
        continue;
      }
      throw e;
    }
    for (const raw of Array.isArray(r.value) ? r.value : []) {
      const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      // Deleted or moved out of the Inbox (by a person, or by the desk after intake): nothing to take in.
      if (!item || item["@removed"]) continue;
      const meta = graphMessageMeta(item);
      if (!meta || meta.isDraft) continue;
      const received = Date.parse(meta.receivedAt);
      if (Number.isFinite(received) && received < floor) continue;
      await intakeOne(c, mb, meta.id);
    }
    const next = str(r["@odata.nextLink"]);
    const delta = str(r["@odata.deltaLink"]);
    // Kept only after graphLink has checked it; a crash resumes from the last page read.
    link = graphLink(next || delta);
    await hq("UPDATE hd_m365_mailboxes SET delta_link = $2, updated_at = now() WHERE id = $1", [mb.id, link]);
    if (!next) return;
  }
}

/**
 * Messages that failed in an earlier read (and stale claims), then messages
 * taken in but not yet marked or moved. `before`: when this read began; a
 * message that failed a moment ago in this same read waits for the next.
 */
async function retryRound(c: M365Config, mb: MbRow, before: Date): Promise<void> {
  await hq(
    "UPDATE hd_m365_messages SET state = 'failed', updated_at = now() WHERE mailbox_id = $1 AND state = 'working' AND attempts >= $2 AND claimed_at < now() - interval '10 minutes'",
    [mb.id, M365_MAIL_LIMITS.attempts]
  );
  const again = await hq<{ message_id: string }>(
    `SELECT message_id FROM hd_m365_messages WHERE mailbox_id = $1 AND attempts < $2
        AND ((state = 'failed' AND updated_at < $3) OR (state = 'working' AND claimed_at < now() - interval '10 minutes')) ORDER BY created_at LIMIT 25`,
    [mb.id, M365_MAIL_LIMITS.attempts, before.toISOString()]
  );
  for (const r of again) await intakeOne(c, mb, r.message_id);
  const unfiled = await hq<{ message_id: string }>(
    "SELECT message_id FROM hd_m365_messages WHERE mailbox_id = $1 AND state = 'done' AND NOT filed AND updated_at > now() - interval '2 days' ORDER BY created_at LIMIT 25",
    [mb.id]
  );
  let fileError: unknown = null;
  for (const r of unfiled) await fileMessage(c, mb, r.message_id).catch((e) => (fileError = e));
  if (fileError) {
    const why = fileError instanceof M365Error ? fileError.message : "it could not be reached";
    throw new M365Error(`New mail was taken in, but could not be ${c.after === "move" ? `moved to "${c.folder}"` : "marked as read"}: ${why}`, 0, "http");
  }
}

/**
 * Read one mailbox now: the delta round, the retries, the filing. One
 * instance at a time (claimed_until). Answers what happened in a sentence
 * for "Check now"; the row keeps the same.
 */
export async function pollM365Mailbox(c: M365Config, id: number): Promise<{ ok: boolean; busy?: boolean; error?: string }> {
  const mb = await hqOne<MbRow>(
    "UPDATE hd_m365_mailboxes SET claimed_until = now() + interval '5 minutes', poll_due = false, last_poll_at = now(), updated_at = now() WHERE id = $1 AND (claimed_until IS NULL OR claimed_until < now()) RETURNING *",
    [id]
  );
  if (!mb) return { ok: false, busy: true };
  try {
    const began = (await hqOne<{ now: string }>("SELECT now() AS now"))!.now;
    await deltaRound(c, mb);
    await retryRound(c, mb, new Date(began));
    const stuck = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_m365_messages WHERE mailbox_id = $1 AND state = 'failed' AND attempts >= $2 AND updated_at > now() - interval '7 days'", [
      mb.id,
      M365_MAIL_LIMITS.attempts,
    ]);
    const n = stuck?.n ?? 0;
    const note = n > 0 ? `${n === 1 ? "1 message" : `${n} messages`} could not be taken in after ${M365_MAIL_LIMITS.attempts} tries. ${n === 1 ? "It is" : "They are"} still in the Inbox, unread. Open ${n === 1 ? "it" : "them"} in Outlook.` : "";
    await hq("UPDATE hd_m365_mailboxes SET claimed_until = NULL, last_ok_at = now(), last_error = $2, last_error_at = $3, updated_at = now() WHERE id = $1", [mb.id, note, note ? new Date().toISOString() : null]);
    return { ok: true, ...(note ? { error: note } : {}) };
  } catch (e) {
    let message = e instanceof M365Error ? e.message : `The desk could not read this mailbox: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
    if (e instanceof M365Error && notAMailbox(e)) message = `${message} ${NOT_A_MAILBOX}`;
    else if (e instanceof M365Error && e.status === 403) message = WAITING;
    await hq("UPDATE hd_m365_mailboxes SET claimed_until = NULL, last_error = $2, last_error_at = now(), updated_at = now() WHERE id = $1", [mb.id, message.slice(0, 500)]);
    logEvent("warn", "helpdesk.m365_poll_failed", { mailbox: mb.address, error: message });
    return { ok: false, error: message };
  }
}

// --- Subscriptions -------------------------------------------------------------------

async function dropSubscription(c: M365Config, mb: MbRow): Promise<void> {
  if (mb.sub_id) {
    await graph(creds(c), { method: "DELETE", path: `/subscriptions/${encodeURIComponent(mb.sub_id)}`, what: "turn off notifications" }).catch(() => {});
  }
  await hq("UPDATE hd_m365_mailboxes SET sub_id = '', sub_state = '', sub_expires_at = NULL, sub_error = '', sub_error_at = NULL, updated_at = now() WHERE id = $1", [mb.id]);
}

const SUB_RETRY_MS = 15 * 60_000;

/**
 * Keep a mailbox's subscription alive: create it, renew it a day before it
 * ends, make a new one when Microsoft no longer knows it. A refusal is kept
 * on the row (the timer reads the mailbox meanwhile), audited once per
 * streak, and tried again every 15 minutes.
 */
async function ensureSubscription(c: M365Config, mb: MbRow, now: number, force = false): Promise<void> {
  const url = notifyUrl(c);
  if (!c.notifications || !url) {
    if (mb.sub_id) await dropSubscription(c, mb);
    return;
  }
  const left = mb.sub_id && mb.sub_expires_at ? Date.parse(mb.sub_expires_at) - now : 0;
  if (!force && left > M365_RENEW_BEFORE_MINUTES * 60_000) return;
  if (!force && mb.sub_error && mb.sub_error_at && now - Date.parse(mb.sub_error_at) < SUB_RETRY_MS) return;
  const expires = new Date(now + M365_SUBSCRIPTION_MINUTES * 60_000).toISOString();
  try {
    if (mb.sub_id) {
      try {
        const r = await graph<{ expirationDateTime?: string }>(creds(c), {
          method: "PATCH",
          path: `/subscriptions/${encodeURIComponent(mb.sub_id)}`,
          body: { expirationDateTime: expires },
          what: "renew notifications",
        });
        await hq("UPDATE hd_m365_mailboxes SET sub_expires_at = $2, sub_error = '', sub_error_at = NULL, updated_at = now() WHERE id = $1", [mb.id, str(r.expirationDateTime) || expires]);
        return;
      } catch (e) {
        // Microsoft busy or unreachable: the subscription is still there, so it is kept and renewed at the next tick.
        if (e instanceof M365Error && (e.status === 0 || e.status === 429 || e.status >= 500)) {
          logEvent("warn", "helpdesk.m365_renew_deferred", { mailbox: mb.address, status: e.status });
          return;
        }
        if (!(e instanceof M365Error) || e.status !== 404) throw e;
        // Microsoft no longer has it: a new one below.
      }
    }
    // One instance makes the new subscription: it takes the row from the state this one read (the same old id, no
    // one else already at it) and holds it for two minutes. The clientState is saved before Microsoft is asked, so
    // the first notification of the new subscription is recognised.
    const state = randomBytes(32).toString("hex");
    const mine = await hqOne(
      `UPDATE hd_m365_mailboxes SET sub_id = '', sub_state = $2, sub_expires_at = now() + interval '2 minutes', updated_at = now()
        WHERE id = $1 AND sub_id = $3 AND ($3 <> '' OR sub_expires_at IS NULL OR sub_expires_at < now()) RETURNING id`,
      [mb.id, state, mb.sub_id]
    );
    if (!mine) return;
    const r = await graph<{ id?: string; expirationDateTime?: string }>(creds(c), {
      method: "POST",
      path: "/subscriptions",
      body: {
        changeType: "created",
        notificationUrl: url,
        lifecycleNotificationUrl: url,
        resource: `users/${mb.address}/mailFolders('inbox')/messages`,
        expirationDateTime: expires,
        clientState: state,
      },
      prefer: [IMMUTABLE],
      what: "turn on notifications",
    });
    const id = str(r.id);
    if (!id) throw new M365Error("Microsoft 365 did not hand back a subscription.", 0, "not_json");
    // Mail may have arrived while there was no subscription: one read.
    const kept = await hqOne(
      "UPDATE hd_m365_mailboxes SET sub_id = $2, sub_expires_at = $3, sub_error = '', sub_error_at = NULL, poll_due = true, updated_at = now() WHERE id = $1 AND sub_state = $4 RETURNING id",
      [mb.id, id, str(r.expirationDateTime) || expires, state]
    );
    // The row moved on meanwhile (disconnected, notifications turned off, another clientState): this subscription is nobody's.
    if (!kept) await graph(creds(c), { method: "DELETE", path: `/subscriptions/${encodeURIComponent(id)}`, what: "turn off notifications" }).catch(() => {});
  } catch (e) {
    let message = e instanceof M365Error ? e.message : "Notifications could not be set up.";
    if (e instanceof M365Error && e.status === 400) message = "Microsoft could not reach this desk's notification address, or it did not answer in time.";
    else if (e instanceof M365Error && e.status === 403) message = "Microsoft 365 did not let the app turn on notifications for this mailbox. The app may not be allowed to read it yet.";
    const streak = !mb.sub_error;
    await hq("UPDATE hd_m365_mailboxes SET sub_id = '', sub_expires_at = NULL, sub_error = $2, sub_error_at = now(), updated_at = now() WHERE id = $1", [mb.id, message.slice(0, 500)]);
    logEvent("warn", "helpdesk.m365_subscription_failed", { mailbox: mb.address, error: message });
    if (streak) {
      await audit({
        actor: { name: "Microsoft 365 mail" },
        action: "helpdesk.m365.subscription_failed",
        targetType: "helpdesk_m365_mailbox",
        targetId: mb.id,
        targetLabel: mb.address,
        details: { address: mb.address, error: message, fallback: "timer" },
      });
    }
  }
}

// --- The notification endpoint ---------------------------------------------------------

const hits = new Map<string, { count: number; resetAt: number }>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  let w = hits.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + windowMs };
    hits.set(key, w);
  }
  w.count++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
  return w.count > max;
}
/** Tests: forget the counters. */
export function resetM365NotifyLimitsForTests(): void {
  hits.clear();
  keyMemo = null;
}

export const M365_NOTIFY_LIMITS = { perMinute: 1200, perIpWrongKey: 30, bodyBytes: 256 * 1024, items: 100, token: 2048 } as const;

let keyMemo: { at: number; cfg: M365Config } | null = null;
const sameSecret = (a: string, b: string) => {
  if (!a || !b) return false;
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
};

/** The connection, when `key` is its notification key (compared in constant time). Read from memory; a miss re-reads at most every five seconds. */
async function configForKey(key: string): Promise<M365Config | null> {
  const ok = (c: M365Config | undefined) => !!c && connected(c) && sameSecret(key, c.notify_key);
  if (ok(keyMemo?.cfg)) return keyMemo!.cfg;
  if (keyMemo && Date.now() - keyMemo.at < 5000) return null;
  keyMemo = { at: Date.now(), cfg: await getM365Config() };
  return ok(keyMemo.cfg) ? keyMemo.cfg : null;
}

export interface M365NotifyAnswer {
  status: number;
  /** A text/plain body (the validation handshake). */
  text?: string;
  /** What to do after the answer has been sent. */
  work?: () => Promise<void>;
}

/**
 * POST /api/helpdesk/m365/notify/<key>: Microsoft Graph's change and
 * lifecycle notifications. No session: the key in the path is known only to
 * Microsoft (it is part of the address each subscription was created with),
 * and every notification must also carry the clientState of the
 * subscription it names, compared in constant time. Nothing in the body is
 * trusted beyond the ids: the message is fetched from Graph as the app.
 *
 *   wrong key                    404 (and counted per caller)
 *   the helpdesk is unlicensed   402
 *   ?validationToken=…           200 text/plain, the token as sent (the
 *                                handshake Graph runs when a subscription is
 *                                created or renewed)
 *   notifications                202 at once; the work happens after
 */
export async function handleM365Notification(req: Request, key: string, opts: { ip?: string | null } = {}): Promise<M365NotifyAnswer> {
  // A caller without the key is counted on its own: it can't use up the allowance Microsoft's notifications share.
  const c = key.length <= 200 ? await configForKey(key) : null;
  if (!c) {
    if (limited(`bad:${opts.ip ?? "?"}`, M365_NOTIFY_LIMITS.perIpWrongKey, 60_000)) return { status: 429 };
    return { status: 404 };
  }
  if (limited("all", M365_NOTIFY_LIMITS.perMinute, 60_000)) return { status: 429 };
  const { helpdeskLicensed } = await import("../access");
  if (!(await helpdeskLicensed())) return { status: 402 };
  const token = new URL(req.url).searchParams.get("validationToken");
  if (token !== null) {
    if (!token || token.length > M365_NOTIFY_LIMITS.token) return { status: 400 };
    return { status: 200, text: token };
  }
  // Read through a byte cap, however the body is framed.
  let text: string;
  try {
    const { readCappedBody } = await import("../inbound-parse");
    text = (await readCappedBody(req, M365_NOTIFY_LIMITS.bodyBytes)).toString("utf8");
  } catch {
    return { status: 413 };
  }
  let items: unknown[] = [];
  try {
    const body = JSON.parse(text || "{}");
    if (body && Array.isArray(body.value)) items = body.value.slice(0, M365_NOTIFY_LIMITS.items);
  } catch {
    return { status: 400 };
  }
  const named = [...new Set(items.map((i) => (i && typeof i === "object" ? str((i as Record<string, unknown>).subscriptionId) : "")).filter((s) => s && s.length <= 200))];
  const rows = named.length ? await hq<MbRow>("SELECT * FROM hd_m365_mailboxes WHERE sub_id = ANY($1)", [named]) : [];
  const bySub = new Map(rows.map((r) => [r.sub_id, r]));
  const fetch = new Map<number, Set<string>>();
  const renew = new Set<number>();
  const read = new Set<number>();
  const gone = new Set<number>();
  let refused = 0;
  for (const raw of items) {
    const n = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const mb = n ? bySub.get(str(n.subscriptionId)) : undefined;
    if (!n || !mb || !sameSecret(str(n.clientState), mb.sub_state)) {
      refused++;
      continue;
    }
    const life = str(n.lifecycleEvent);
    if (life) {
      if (life === "reauthorizationRequired") renew.add(mb.id);
      else if (life === "subscriptionRemoved") gone.add(mb.id);
      else if (life === "missed") read.add(mb.id);
      continue;
    }
    if (str(n.changeType).toLowerCase() !== "created") continue;
    const data = n.resourceData && typeof n.resourceData === "object" ? (n.resourceData as Record<string, unknown>) : null;
    const id = str(data?.id);
    if (!validId(id)) {
      read.add(mb.id);
      continue;
    }
    if (!fetch.has(mb.id)) fetch.set(mb.id, new Set());
    fetch.get(mb.id)!.add(id);
  }
  if (refused) logEvent("warn", "helpdesk.m365_notification_refused", { count: refused, ip: opts.ip ?? null });
  const touched = [...new Set([...fetch.keys(), ...renew, ...read, ...gone])];
  if (!touched.length) return { status: 202 };
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    status: 202,
    work: async () => {
      try {
        await hq("UPDATE hd_m365_mailboxes SET last_notified_at = now(), updated_at = now() WHERE id = ANY($1)", [touched]);
        if (gone.size) await hq("UPDATE hd_m365_mailboxes SET sub_id = '', sub_state = '', sub_expires_at = NULL, poll_due = true, updated_at = now() WHERE id = ANY($1)", [[...gone]]);
        if (read.size) await hq("UPDATE hd_m365_mailboxes SET poll_due = true, updated_at = now() WHERE id = ANY($1)", [[...read]]);
        for (const id of renew) await ensureSubscription(c, byId.get(id)!, Date.now(), true);
        for (const [id, ids] of fetch) {
          const mb = byId.get(id)!;
          let again = false;
          for (const messageId of ids) {
            const r = await intakeOne(c, mb, messageId);
            if (r === "failed" || r === "deferred") again = true;
          }
          if (again) await hq("UPDATE hd_m365_mailboxes SET poll_due = true, updated_at = now() WHERE id = $1", [id]);
        }
      } catch (e) {
        logEvent("error", "helpdesk.m365_notification_failed", { error: e instanceof Error ? e.message : String(e) });
        await hq("UPDATE hd_m365_mailboxes SET poll_due = true, updated_at = now() WHERE id = ANY($1)", [touched]).catch(() => {});
      }
    },
  };
}

// --- The scheduler ---------------------------------------------------------------------

let lastPrune = 0;

/**
 * One minute's work (lib/periodic HELPDESK_SWEEPS, licence-gated there).
 * Nothing connected: one settings read and out. Otherwise, per mailbox:
 * keep its subscription alive, and read it when a notification asked for
 * it or the timer is due (every poll_minutes without working
 * notifications, every 15 minutes with them). Every instance may run this
 * at once: a mailbox is claimed for its read.
 */
export async function m365MailSweep(now: Date = new Date()): Promise<{ polled: number }> {
  const state = await refreshM365State();
  if (!state.configured) return { polled: 0 };
  const c = await getM365Config();
  if (!connected(c)) return { polled: 0 };
  const t = now.getTime();
  let polled = 0;
  for (const row of await listRows()) {
    // A mailbox the app may not read yet gets no subscription attempt: the read below finds out when it may.
    if (row.last_error !== WAITING) await ensureSubscription(c, row, t).catch((e) => logEvent("error", "helpdesk.m365_subscription_error", { mailbox: row.address, error: e instanceof Error ? e.message : String(e) }));
    const mb = (await getRow(row.id)) ?? row;
    const every = modeOf(c, mb, t) === "notifications" ? Math.max(M365_SAFETY_NET_MINUTES, c.poll_minutes) : c.poll_minutes;
    const due = mb.poll_due || !mb.last_poll_at || t - Date.parse(mb.last_poll_at) >= every * 60_000 - 5000;
    if (!due) continue;
    const r = await pollM365Mailbox(c, mb.id);
    if (!r.busy) polled++;
  }
  if (t - lastPrune > 3_600_000) {
    lastPrune = t;
    await hq("DELETE FROM hd_m365_messages WHERE updated_at < now() - interval '45 days'").catch(() => {});
  }
  return { polled };
}

/** "Check now" on one mailbox: its subscription, then a read, whatever the timer says. */
export async function checkM365MailboxNow(id: number): Promise<{ ok: boolean; busy?: boolean; error?: string } | undefined> {
  const c = await getM365Config();
  if (!connected(c)) throw new M365MailError("Connect Microsoft 365 first.", 409);
  const mb = await getRow(id);
  if (!mb) return undefined;
  const r = await pollM365Mailbox(c, id);
  // The read worked (or another instance is on it): notifications are set up or renewed too.
  if (r.ok) await ensureSubscription(c, (await getRow(id)) ?? mb, Date.now(), true);
  return r;
}
