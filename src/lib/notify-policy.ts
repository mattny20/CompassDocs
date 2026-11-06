// The one notification decision (1.19.0). Every sender asks
// shouldNotify(userId, event, channel) (or the batch shouldNotifyMany, or
// the emailGate helper for a send loop) instead of reading preference
// columns itself; the answer combines the workspace policy (settings key
// `notification_policy`), the person's choices (user_notify_prefs, or the
// pre-1.19 columns on users for anyone who has not saved the new page),
// the desk's own choices for agents (hd_notify_prefs, agent F), quiet hours
// and a pause. The rules are pure and live in lib/notify-policy-shared;
// this module loads the inputs, stores both shapes and runs the digest
// queue. Server-only.
//
// Storage decision: a new table rather than the users.notify_prefs column.
// That column holds the pre-1.19 sparse opt-outs, which older code and a
// rollback still read; the new shape (channels × events, digest frequency,
// quiet hours, pause) lives beside it, and every save also writes the old
// columns (legacyFromPrefs), so the two never disagree about what they
// both describe. No eager migration runs: a person without a row is read
// through prefsFromLegacy, which keeps their effective behaviour exactly.
//
// Digests: CompassDocs had only weekly digests (lib/digest, lib/team-digest),
// so email in an hourly or daily mode goes to notify_digest_queue and the
// hourly tick (sendNotificationDigests) mails one summary per person.

import "server-only";
import { pool, getSetting, setSetting } from "./db";
import { logEvent } from "./log";
import { NOTIFY_POLICY_SCHEMA } from "./notify-policy-schema";
import {
  NOTIFY_EVENTS,
  NOTIFY_SECTIONS,
  NOTIFY_SECTION_INFO,
  NOTIFY_MODE_LABEL,
  compactPolicy,
  decide,
  emptyPrefs,
  legacyFromPrefs,
  mergeLegacyIntoPrefs,
  notifyEvent,
  pausedAt,
  policyCell,
  policyMode,
  prefsFromLegacy,
  quietAt,
  resolvePolicy,
  resolveUserPrefs,
  zoneFor,
  type DeskPrefsView,
  type LegacyPrefs,
  type NotifyChannel,
  type NotifyDecision,
  type NotifyEventDef,
  type NotifyMode,
  type NotifyPolicy,
  type NotifySection,
  type UserNotifyPrefs,
} from "./notify-policy-shared";
import { holdReason, resolvePrefs as resolveDeskPrefs, type HdNotifyEvent } from "./helpdesk/notify-prefs-shared";

export type { NotifyChannel, NotifyDecision, NotifyMode, NotifyPolicy, UserNotifyPrefs } from "./notify-policy-shared";
export { deskEvent, eventForKind } from "./notify-policy-shared";

/**
 * The schema this module needs (lib/notify-policy-schema, appended to lib/db
 * SCHEMA after the Helpdesk block, where boot runs it under the schema lock
 * with the column and index guards).
 */
export { NOTIFY_POLICY_SCHEMA };

let schemaReady: Promise<void> | null = null;

/**
 * Wait for the boot schema, which carries these tables. No DDL of its own
 * at runtime: re-running the raw block outside boot's lock and guards took
 * table locks on every new process (finding #32).
 */
export function ensureNotifySchema(): Promise<void> {
  schemaReady ??= (async () => {
    const { dbReady } = await import("./db");
    await dbReady();
  })().catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

// --- The workspace policy ----------------------------------------------------------

export const NOTIFY_POLICY_KEY = "notification_policy";
let policyCache: { at: number; policy: NotifyPolicy } | null = null;
const POLICY_TTL_MS = 10_000;

export async function getNotifyPolicy(): Promise<NotifyPolicy> {
  if (policyCache && Date.now() - policyCache.at < POLICY_TTL_MS) return policyCache.policy;
  let policy: NotifyPolicy;
  try {
    const raw = await getSetting(NOTIFY_POLICY_KEY);
    policy = resolvePolicy(raw ? JSON.parse(raw) : null);
  } catch {
    policy = resolvePolicy(null);
  }
  policyCache = { at: Date.now(), policy };
  return policy;
}

/** Save a (validated) policy, compacted to what differs from the catalog. Returns what was stored. */
export async function saveNotifyPolicy(policy: NotifyPolicy): Promise<NotifyPolicy> {
  const stored = compactPolicy(policy);
  await setSetting(NOTIFY_POLICY_KEY, JSON.stringify(stored));
  policyCache = { at: Date.now(), policy: stored };
  return stored;
}

/** Drop the cached policy (tests that write the setting directly). */
export function forgetNotifyPolicyCache(): void {
  policyCache = null;
}

/** Event ids whose stored policy differs between two policies (the audit's details). */
export function changedPolicyEvents(before: NotifyPolicy, after: NotifyPolicy): string[] {
  const ids = new Set([...Object.keys(before.events), ...Object.keys(after.events)]);
  return [...ids].filter((id) => JSON.stringify(before.events[id] ?? {}) !== JSON.stringify(after.events[id] ?? {})).sort();
}

// --- The catalog, for pages and other modules ---------------------------------------

export interface CatalogEvent extends NotifyEventDef {
  sectionLabel: string;
}

/** Every event the product sends, its labels, section, channels and defaults (catalog order). */
export function notificationEventCatalog(): {
  sections: { key: NotifySection; label: string; description: string; feature?: string; personal: boolean }[];
  events: CatalogEvent[];
} {
  return {
    sections: NOTIFY_SECTIONS.map((key) => ({ key, ...NOTIFY_SECTION_INFO[key] })),
    events: NOTIFY_EVENTS.map((e) => ({ ...e, sectionLabel: NOTIFY_SECTION_INFO[e.section].label })),
  };
}

// --- Loading people ----------------------------------------------------------------

interface PersonRow {
  id: number;
  status: string;
  email: string;
  timezone: string;
  notify_prefs: Record<string, Record<string, boolean>> | null;
  email_notifications: number;
  weekly_digest: number;
  v2: unknown;
  desk: unknown;
}

interface Person {
  id: number;
  email: string;
  active: boolean;
  timeZone: string;
  stored: boolean;
  prefs: UserNotifyPrefs;
  legacy: LegacyPrefs;
  desk: DeskPrefsView | null;
}

async function workspaceZone(): Promise<string> {
  return (await getSetting("timezone").catch(() => undefined))?.trim() || "UTC";
}

function deskView(raw: unknown, timeZone: string, now: Date): DeskPrefsView | null {
  if (raw == null) return null;
  const matrix = raw && typeof raw === "object" && "matrix" in raw && raw.matrix && typeof raw.matrix === "object" ? (raw.matrix as DeskPrefsView["matrix"]) : {};
  const resolved = resolveDeskPrefs(raw);
  return {
    matrix,
    hold: (event: HdNotifyEvent, urgent: boolean) => holdReason(resolved, event, urgent, now, timeZone),
  };
}

async function loadPeople(ids: number[], now: Date): Promise<Map<number, Person>> {
  const out = new Map<number, Person>();
  const unique = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  if (unique.length === 0) return out;
  await ensureNotifySchema();
  const zone = await workspaceZone();
  let rows: PersonRow[];
  try {
    rows = (
      await pool().query<PersonRow>(
        `SELECT u.id, u.status, u.email, u.timezone, u.notify_prefs, u.email_notifications, u.weekly_digest,
                p.prefs AS v2, h.prefs AS desk
           FROM users u
           LEFT JOIN user_notify_prefs p ON p.user_id = u.id
           LEFT JOIN hd_notify_prefs h ON h.user_id = u.id
          WHERE u.id = ANY($1)`,
        [unique]
      )
    ).rows;
  } catch {
    // hd_notify_prefs belongs to the helpdesk schema; without it, read the rest.
    rows = (
      await pool().query<PersonRow>(
        `SELECT u.id, u.status, u.email, u.timezone, u.notify_prefs, u.email_notifications, u.weekly_digest,
                p.prefs AS v2, NULL AS desk
           FROM users u LEFT JOIN user_notify_prefs p ON p.user_id = u.id
          WHERE u.id = ANY($1)`,
        [unique]
      )
    ).rows;
  }
  for (const r of rows) {
    const legacy: LegacyPrefs = { notify_prefs: r.notify_prefs, email_notifications: r.email_notifications, weekly_digest: r.weekly_digest };
    const timeZone = zoneFor(r.timezone, zone);
    out.set(r.id, {
      id: r.id,
      email: r.email ?? "",
      active: r.status === "active",
      timeZone,
      stored: r.v2 != null,
      prefs: r.v2 != null ? resolveUserPrefs(r.v2) : prefsFromLegacy(legacy),
      legacy,
      desk: deskView(r.desk, timeZone, now),
    });
  }
  return out;
}

// --- The decision ------------------------------------------------------------------

export interface ShouldNotifyOptions {
  /** Urgent tickets and the like come through quiet hours (never a pause). */
  urgent?: boolean;
  now?: Date;
  /** An automated ticket (alert intake): requester events answer send: false. */
  automated?: boolean;
}

const UNKNOWN_PERSON: NotifyDecision = { send: false, mode: "instant", reason: "no_channel" };

/**
 * Whether `event` reaches the person on `channel` now: { send, mode, reason }.
 * `mode` matters for email only: "instant" sends now, "digest_*" means
 * enqueueDigest() instead. An unknown user answers send: false; an event
 * missing from the catalog falls back to the pre-1.19 columns.
 */
export async function shouldNotify(
  userId: number,
  event: string,
  channel: NotifyChannel,
  opts: ShouldNotifyOptions = {}
): Promise<NotifyDecision> {
  return (await shouldNotifyMany([userId], event, channel, opts)).get(userId) ?? UNKNOWN_PERSON;
}

/** shouldNotify for a fan-out: one query for everyone. Users that don't exist are left out of the map. */
export async function shouldNotifyMany(
  userIds: number[],
  event: string,
  channel: NotifyChannel,
  opts: ShouldNotifyOptions = {}
): Promise<Map<number, NotifyDecision>> {
  const now = opts.now ?? new Date();
  const out = new Map<number, NotifyDecision>();
  if (userIds.length === 0) return out;
  const [policy, people] = await Promise.all([getNotifyPolicy(), loadPeople(userIds, now)]);
  for (const [id, p] of people) {
    out.set(
      id,
      decide(event, channel, { policy, prefs: p.prefs, timeZone: p.timeZone, now, urgent: opts.urgent, automated: opts.automated, desk: p.desk, legacy: p.legacy })
    );
  }
  return out;
}

/** Several channels for a fan-out in one load (the bell inbox asks bell and webhook together). */
export async function shouldNotifyChannels<C extends NotifyChannel>(
  userIds: number[],
  event: string,
  channels: readonly C[],
  opts: ShouldNotifyOptions = {}
): Promise<Map<number, Record<C, NotifyDecision>>> {
  const now = opts.now ?? new Date();
  const out = new Map<number, Record<C, NotifyDecision>>();
  if (userIds.length === 0) return out;
  const [policy, people] = await Promise.all([getNotifyPolicy(), loadPeople(userIds, now)]);
  for (const [id, p] of people) {
    const row = {} as Record<C, NotifyDecision>;
    for (const ch of channels) {
      row[ch] = decide(event, ch, { policy, prefs: p.prefs, timeZone: p.timeZone, now, urgent: opts.urgent, automated: opts.automated, desk: p.desk, legacy: p.legacy });
    }
    out.set(id, row);
  }
  return out;
}

/**
 * A send loop's helper: decide email for everyone at once, then per person
 * `allows(id)` (send now or queue) and `route(id, item, sendNow)`, which
 * sends, queues the item for the person's digest, or skips, and says which.
 * A decision lookup that fails sends only what must never be silenced:
 * compliance evidence (read confirmations) and security mail. Everything
 * else is skipped (fails closed), so a database hiccup never mails people
 * who opted out; the sender's next run tries again.
 */
export interface EmailGate {
  decision(id: number): NotifyDecision;
  allows(id: number): boolean;
  route(id: number, item: DigestItem, sendNow: () => Promise<unknown>): Promise<"sent" | "queued" | "skipped">;
}

/** emailGate's answer when the decision lookup failed: send only compliance evidence and security mail (fail closed otherwise). */
export function gateFallback(event: string): NotifyDecision {
  const def = notifyEvent(event);
  if (def?.security) return { send: true, mode: "instant", reason: "security" };
  if (def?.evidence) return { send: true, mode: "instant", reason: "locked_on" };
  return { send: false, mode: "instant", reason: "lookup_failed" };
}

export async function emailGate(userIds: number[], event: string, opts: ShouldNotifyOptions = {}): Promise<EmailGate> {
  let decisions: Map<number, NotifyDecision>;
  let failed = false;
  try {
    decisions = await shouldNotifyMany(userIds, event, "email", opts);
  } catch (e) {
    logEvent("error", "notify_policy.decide_failed", { event, error: e instanceof Error ? e.message : String(e) });
    decisions = new Map();
    failed = true;
  }
  const fallback: NotifyDecision = failed ? gateFallback(event) : UNKNOWN_PERSON;
  const decision = (id: number) => decisions.get(id) ?? fallback;
  return {
    decision,
    allows: (id) => decision(id).send,
    async route(id, item, sendNow) {
      const d = decision(id);
      if (!d.send) return "skipped";
      if (d.mode !== "instant") {
        await enqueueDigest(id, event, d.mode, item);
        return "queued";
      }
      await sendNow();
      return "sent";
    },
  };
}

/** One person's email: decide, then send now, queue for the digest, or skip. */
export async function routeEmail(
  userId: number,
  event: string,
  item: DigestItem,
  sendNow: () => Promise<unknown>,
  opts: ShouldNotifyOptions = {}
): Promise<"sent" | "queued" | "skipped"> {
  return (await emailGate([userId], event, opts)).route(userId, item, sendNow);
}

/**
 * For senders that only have addresses (newsletters, announcements): the
 * addresses that belong to no account are always mailed (a test send, an
 * outside list); account holders go through the gate. Instant only (these
 * events never wait in a digest).
 */
export async function emailAllowedAddresses(emails: string[], event: string): Promise<Set<string>> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const ok = new Set(wanted);
  if (wanted.length === 0) return ok;
  try {
    const rows = (
      await pool().query<{ id: number; email: string }>("SELECT id, lower(email) AS email FROM users WHERE lower(email) = ANY($1)", [wanted])
    ).rows;
    if (rows.length === 0) return ok;
    const gate = await emailGate(rows.map((r) => r.id), event);
    const byEmail = new Map<string, boolean>();
    // Two accounts on one address: mailed when either still wants it.
    for (const r of rows) byEmail.set(r.email, (byEmail.get(r.email) ?? false) || gate.allows(r.id));
    for (const [email, allowed] of byEmail) if (!allowed) ok.delete(email);
  } catch (e) {
    logEvent("error", "notify_policy.address_gate_failed", { event, error: e instanceof Error ? e.message : String(e) });
  }
  return ok;
}

/** Active accounts with an address among `ids` (senders that start from ids). */
export async function emailRecipients(ids: number[]): Promise<{ id: number; email: string; name: string }[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  return (
    await pool().query<{ id: number; email: string; name: string }>(
      "SELECT id, email, name FROM users WHERE id = ANY($1) AND status = 'active' AND email <> '' ORDER BY id",
      [unique]
    )
  ).rows;
}

// --- Personal prefs ----------------------------------------------------------------

/** One person's prefs: the saved row, or what the pre-1.19 columns say. */
export async function getUserNotifyPrefs(userId: number): Promise<{ prefs: UserNotifyPrefs; stored: boolean; timeZone: string } | null> {
  const p = (await loadPeople([userId], new Date())).get(userId);
  return p ? { prefs: p.prefs, stored: p.stored, timeZone: p.timeZone } : null;
}

/**
 * Save one person's prefs (already validated) and mirror them into the
 * pre-1.19 columns. Choices the workspace has locked are dropped: a lock
 * decides without them, and an unlock should fall back to the default.
 */
export async function saveUserNotifyPrefs(userId: number, prefs: UserNotifyPrefs): Promise<UserNotifyPrefs> {
  await ensureNotifySchema();
  const policy = await getNotifyPolicy();
  const clean = resolveUserPrefs(prefs);
  for (const [id, row] of Object.entries(clean.channels)) {
    const def = notifyEvent(id)!;
    for (const ch of Object.keys(row) as NotifyChannel[]) {
      if (policyCell(policy, def, ch).control !== "choose") delete row[ch];
    }
    if (Object.keys(row).length === 0) delete clean.channels[id];
  }
  const legacy = legacyFromPrefs(clean);
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_notify_prefs (user_id, prefs, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
      [userId, JSON.stringify(clean)]
    );
    await client.query("UPDATE users SET notify_prefs = $1, email_notifications = $2, weekly_digest = $3 WHERE id = $4", [
      JSON.stringify(legacy.notify_prefs),
      legacy.email_notifications,
      legacy.weekly_digest,
      userId,
    ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return clean;
}

/**
 * After something wrote the pre-1.19 columns (the legacy PATCH route), lay
 * them over the person's saved row so both say the same. No row: nothing
 * to do, the columns are already what decide() reads.
 */
export async function syncLegacyIntoNotifyPrefs(userId: number): Promise<void> {
  await ensureNotifySchema();
  const r = (
    await pool().query<{ v2: unknown; notify_prefs: LegacyPrefs["notify_prefs"]; email_notifications: number; weekly_digest: number }>(
      `SELECT p.prefs AS v2, u.notify_prefs, u.email_notifications, u.weekly_digest
         FROM users u JOIN user_notify_prefs p ON p.user_id = u.id WHERE u.id = $1`,
      [userId]
    )
  ).rows[0];
  if (!r) return;
  const merged = mergeLegacyIntoPrefs(resolveUserPrefs(r.v2), r);
  await pool().query("UPDATE user_notify_prefs SET prefs = $1, updated_at = now() WHERE user_id = $2", [JSON.stringify(merged), userId]);
}

/** The effective answer for every personal event and channel, for the personal page. */
export async function effectiveMatrix(
  userId: number,
  now = new Date()
): Promise<Record<string, Partial<Record<NotifyChannel, { on: boolean; locked: boolean; reason: string }>>>> {
  const policy = await getNotifyPolicy();
  const p = (await loadPeople([userId], now)).get(userId);
  const out: Record<string, Partial<Record<NotifyChannel, { on: boolean; locked: boolean; reason: string }>>> = {};
  if (!p) return out;
  for (const def of NOTIFY_EVENTS) {
    for (const ch of Object.keys(def.channels) as NotifyChannel[]) {
      const cell = policyCell(policy, def, ch);
      // Ignore pause and quiet hours here: the matrix shows the switch, the page shows the pause.
      const d = decide(def.id, ch, { policy, prefs: { ...p.prefs, pause: null, quiet: { ...p.prefs.quiet, enabled: false } }, timeZone: p.timeZone, now, desk: p.desk });
      (out[def.id] ??= {})[ch] = { on: d.send, locked: cell.control !== "choose", reason: d.reason };
    }
  }
  return out;
}

/** What a page needs to draw the policy for one person: defaults and locks per cell, modes per event. */
export function policyView(policy: NotifyPolicy): Record<
  string,
  { channels: Partial<Record<NotifyChannel, { default: boolean; control: string }>>; mode: NotifyMode; modeLocked: boolean }
> {
  const out: ReturnType<typeof policyView> = {};
  for (const def of NOTIFY_EVENTS) {
    const channels: Partial<Record<NotifyChannel, { default: boolean; control: string }>> = {};
    for (const ch of Object.keys(def.channels) as NotifyChannel[]) channels[ch] = policyCell(policy, def, ch);
    const m = policyMode(policy, def);
    out[def.id] = { channels, mode: m.mode, modeLocked: m.locked };
  }
  return out;
}

// --- Digests -----------------------------------------------------------------------

export interface DigestItem {
  title: string;
  body?: string;
  /** In-app path ("/doc/12#comments") or an absolute URL. */
  link?: string;
}

/** Queue one email for the person's hourly or daily digest (instead of sending it now). */
export async function enqueueDigest(userId: number, event: string, mode: Exclude<NotifyMode, "instant">, item: DigestItem): Promise<void> {
  await ensureNotifySchema();
  await pool().query("INSERT INTO notify_digest_queue (user_id, event, mode, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)", [
    userId,
    event.slice(0, 80),
    mode === "digest_daily" ? "digest_daily" : "digest_hourly",
    item.title.slice(0, 300),
    (item.body ?? "").slice(0, 600),
    (item.link ?? "").slice(0, 500),
  ]);
}

type DigestMailer = (to: string[], subject: string, text: string, html?: string) => Promise<unknown>;

export interface DigestRunOptions {
  now?: Date;
  /** Omit for the SMTP settings; a function to inject one (tests). */
  mailer?: DigestMailer | null;
  /** Only these people (tests sharing a database). */
  userIds?: number[];
  /** The local hour daily digests go out at (default 8). */
  dailyHour?: number;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The digest mail for one person: one line per item, grouped by section, oldest first. */
export function renderDigest(
  items: { event: string; title: string; body: string; link: string; created_at: string | Date }[],
  origin: string,
  orgName: string
): { subject: string; text: string; html: string } {
  const bySection = new Map<string, typeof items>();
  for (const it of items) {
    const section = notifyEvent(it.event)?.section;
    const label = section ? NOTIFY_SECTION_INFO[section].label : "Other";
    bySection.set(label, [...(bySection.get(label) ?? []), it]);
  }
  const abs = (link: string) => (!link ? "" : /^https?:\/\//.test(link) ? link : `${origin}${link}`);
  const n = items.length;
  const subject = `${n} ${n === 1 ? "notification" : "notifications"} from ${orgName || "CompassDocs"}`;
  const text: string[] = [subject, ""];
  let html = `<p style="margin:0 0 12px">${esc(subject)}</p>`;
  for (const [label, rows] of bySection) {
    text.push(label);
    html += `<h3 style="margin:16px 0 6px;font-size:14px">${esc(label)}</h3><ul style="margin:0;padding-left:18px">`;
    for (const r of rows) {
      const url = abs(r.link);
      text.push(`- ${r.title}${r.body ? `: ${r.body}` : ""}${url ? `\n  ${url}` : ""}`);
      const title = url ? `<a href="${esc(url)}">${esc(r.title)}</a>` : esc(r.title);
      html += `<li style="margin:0 0 6px">${title}${r.body ? `<br><span style="color:#64748b">${esc(r.body)}</span>` : ""}</li>`;
    }
    text.push("");
    html += `</ul>`;
  }
  const manage = origin ? `${origin}/account/notifications` : "/account/notifications";
  text.push(`Change how often these arrive: ${manage}`);
  html += `<p style="margin:16px 0 0;font-size:12px;color:#64748b"><a href="${esc(manage)}">Change how often these arrive</a></p>`;
  return { subject, text: text.join("\n"), html };
}

/** The desk's event name of a queued row (desk_*, hd_approval_needed), or null for any other section. */
function deskRowEvent(event: string): HdNotifyEvent | null {
  if (event === "hd_approval_needed") return "approval_needed";
  return event.startsWith("desk_") ? (event.slice(5) as HdNotifyEvent) : null;
}

/** The links' origin for a digest: the custom domain, else the last request's (lib/helpdesk/email helpdeskOrigin), else ''. */
async function digestOrigin(): Promise<string> {
  try {
    const { helpdeskOrigin } = await import("./helpdesk/email");
    return (await helpdeskOrigin()).replace(/\/+$/, "");
  } catch {
    const d = (await getSetting("custom_domain").catch(() => undefined))?.trim();
    return d ? `https://${d}` : "";
  }
}

/**
 * The hourly tick: for each person with queued items, mail the hourly ones
 * (and, once a local day from `dailyHour`, the daily ones) unless they are
 * paused or inside their quiet hours (the queue waits for them; desk rows
 * also wait for the desk's own pause and quiet hours). Rows are claimed
 * with FOR UPDATE SKIP LOCKED, so every instance may run this. A refused
 * mail releases its rows for the next tick; rows of a mail that went out
 * are deleted, or marked sent_at when the delete fails, and are never
 * released again. The day's daily summary counts as done only once it was
 * sent and no daily row is left waiting. Never throws.
 */
export async function sendNotificationDigests(opts: DigestRunOptions = {}): Promise<{ sent: number; people: number; held: number }> {
  const now = opts.now ?? new Date();
  const result = { sent: 0, people: 0, held: 0 };
  try {
    await ensureNotifySchema();
    let mailer: DigestMailer | null;
    if (opts.mailer !== undefined) mailer = opts.mailer;
    else {
      const { getSmtpConfig, smtpConfigured } = await import("./smtp-config");
      const { sendMail } = await import("./mailer");
      mailer = smtpConfigured(await getSmtpConfig()) ? sendMail : null;
    }
    if (!mailer) return result;
    const scoped = opts.userIds ? "AND user_id = ANY($1)" : "";
    const scopedArgs = opts.userIds ? [opts.userIds] : [];
    // Rows of a digest already sent whose delete failed: finish the delete.
    await pool().query(`DELETE FROM notify_digest_queue WHERE sent_at IS NOT NULL ${scoped}`, scopedArgs);
    // A claim older than an hour belongs to an instance that died mid-send.
    await pool().query("UPDATE notify_digest_queue SET claimed_at = NULL WHERE claimed_at < now() - interval '1 hour' AND sent_at IS NULL");
    const waiting = (
      await pool().query<{ user_id: number }>(`SELECT DISTINCT user_id FROM notify_digest_queue WHERE claimed_at IS NULL ${scoped}`, scopedArgs)
    ).rows.map((r) => r.user_id);
    if (waiting.length === 0) return result;
    const people = await loadPeople(waiting, now);
    const origin = await digestOrigin();
    const orgName = (await getSetting("company_name").catch(() => undefined))?.trim() || "CompassDocs";
    const dailyHour = opts.dailyHour ?? 8;
    const { localClock } = await import("./helpdesk/notify-prefs-shared");

    for (const userId of waiting) {
      const p = people.get(userId);
      if (!p || !p.active || !p.email) {
        await pool().query("DELETE FROM notify_digest_queue WHERE user_id = $1 AND claimed_at IS NULL", [userId]);
        continue;
      }
      if (pausedAt(p.prefs, now) || quietAt(p.prefs, now, p.timeZone)) {
        result.held++;
        continue;
      }
      // Desk rows wait for the desk's own pause and quiet hours (hd_notify_prefs).
      const events = (
        await pool().query<{ event: string }>("SELECT DISTINCT event FROM notify_digest_queue WHERE user_id = $1 AND claimed_at IS NULL", [userId])
      ).rows.map((r) => r.event);
      const heldEvents = events.filter((e) => {
        const dn = deskRowEvent(e);
        return dn !== null && p.desk !== null && p.desk.hold(dn, false) !== null;
      });
      if (heldEvents.length && heldEvents.length === events.length) {
        result.held++;
        continue;
      }
      const clock = localClock(now, p.timeZone);
      const today = `${clock.y}-${String(clock.m).padStart(2, "0")}-${String(clock.d).padStart(2, "0")}`;
      let daily = false;
      if (clock.minutes >= dailyHour * 60) {
        const st = (await pool().query<{ last: string | null }>("SELECT to_char(last_daily_on, 'YYYY-MM-DD') AS last FROM notify_digest_state WHERE user_id = $1", [userId])).rows[0];
        daily = !st?.last || st.last < today;
      }
      const markDailyIfDone = async () => {
        if (!daily) return;
        const left = await pool().query("SELECT 1 FROM notify_digest_queue WHERE user_id = $1 AND mode = 'digest_daily' AND claimed_at IS NULL LIMIT 1", [userId]);
        if (left.rowCount) return; // the rest go out on the next tick, today
        await pool().query(
          `INSERT INTO notify_digest_state (user_id, last_daily_on) VALUES ($1, $2::date)
           ON CONFLICT (user_id) DO UPDATE SET last_daily_on = EXCLUDED.last_daily_on`,
          [userId, today]
        );
      };
      const modes = daily ? ["digest_hourly", "digest_daily"] : ["digest_hourly"];
      const claimed = (
        await pool().query<{ id: string; event: string; title: string; body: string; link: string; created_at: Date }>(
          `UPDATE notify_digest_queue SET claimed_at = now()
            WHERE id IN (SELECT id FROM notify_digest_queue
                          WHERE user_id = $1 AND claimed_at IS NULL AND mode = ANY($2) AND event <> ALL($3::text[])
                          ORDER BY created_at, id LIMIT 200 FOR UPDATE SKIP LOCKED)
            RETURNING id, event, title, body, link, created_at`,
          [userId, modes, heldEvents]
        )
      ).rows.sort((a, b) => +a.created_at - +b.created_at || Number(a.id) - Number(b.id));
      if (claimed.length === 0) {
        await markDailyIfDone();
        continue;
      }
      const mail = renderDigest(claimed, origin, orgName);
      const ids = claimed.map((r) => r.id);
      try {
        await mailer([p.email], mail.subject, mail.text, mail.html);
      } catch (e) {
        // Not sent: the rows wait for the next tick, and today's daily isn't done.
        await pool()
          .query("UPDATE notify_digest_queue SET claimed_at = NULL WHERE id = ANY($1::bigint[]) AND sent_at IS NULL", [ids])
          .catch(() => undefined);
        logEvent("error", "notify_policy.digest_failed", { user_id: userId, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      result.sent += claimed.length;
      result.people++;
      // Sent: these rows never go out again, whatever fails from here.
      try {
        await pool().query("DELETE FROM notify_digest_queue WHERE id = ANY($1::bigint[])", [ids]);
      } catch (e) {
        await pool()
          .query("UPDATE notify_digest_queue SET sent_at = now() WHERE id = ANY($1::bigint[])", [ids])
          .catch(() => undefined);
        logEvent("error", "notify_policy.digest_cleanup_failed", { user_id: userId, error: e instanceof Error ? e.message : String(e) });
      }
      await markDailyIfDone().catch((e) =>
        logEvent("error", "notify_policy.digest_state_failed", { user_id: userId, error: e instanceof Error ? e.message : String(e) })
      );
    }
  } catch (e) {
    logEvent("error", "notify_policy.digest_run_failed", { error: e instanceof Error ? e.message : String(e) });
  }
  return result;
}

/** Re-exported for pages that label modes. */
export { NOTIFY_MODE_LABEL, emptyPrefs };
