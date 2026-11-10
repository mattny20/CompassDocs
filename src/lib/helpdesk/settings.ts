// Helpdesk 1.19.0: the workspace's helpdesk settings, one JSON value under
// the settings key `helpdesk_settings` (business hours, email, CSAT, the
// setup checklist). Reads fill every missing field from the defaults, so a
// value written by an earlier build, or none at all, still parses; writes
// validate and clamp. Server-only.

import "server-only";
import { randomBytes } from "node:crypto";
import { getSetting } from "../db";
import { openSecret } from "../secretbox";
import { withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import { HD_SETUP_STEPS } from "./types";
import type { HdBusinessHours, HdSettings, HdSetupStep } from "./types";

export const HD_SETTINGS_KEY = "helpdesk_settings";

/**
 * The defaults. `timezone` is the last resort only: a read without a stored
 * zone takes the workspace's (Settings → Workspace, `timezone`), so a
 * workspace in New York never starts on London business hours.
 */
export const HD_DEFAULT_SETTINGS: HdSettings = {
  timezone: "UTC",
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:30",
  holidays: [],
  outside_senders: false,
  inbound_address: "",
  inbound_secret: "",
  csat_enabled: true,
  setup_steps_done: [],
  email_from_name: "Helpdesk",
  setup_complete: false,
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fill and clamp: what every read returns and every write stores. Never
 * throws. `fallbackZone` (the workspace's zone) stands in for a missing or
 * unusable timezone before the UTC default.
 */
export function normalizeSettings(raw: unknown, fallbackZone?: string | null): HdSettings {
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof HdSettings, unknown>>;
  const d = { ...HD_DEFAULT_SETTINGS, timezone: fallbackZone && validTimezone(fallbackZone) ? fallbackZone : HD_DEFAULT_SETTINGS.timezone };
  const days = Array.isArray(v.days)
    ? [...new Set(v.days.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort()
    : d.days;
  let start = typeof v.start === "string" && TIME.test(v.start) ? v.start : d.start;
  let end = typeof v.end === "string" && TIME.test(v.end) ? v.end : d.end;
  if (end <= start) {
    start = d.start;
    end = d.end;
  }
  const holidays = Array.isArray(v.holidays)
    ? [...new Set(v.holidays.filter((h): h is string => typeof h === "string" && DATE.test(h)))].sort().slice(0, 366)
    : d.holidays;
  const steps = Array.isArray(v.setup_steps_done)
    ? v.setup_steps_done.filter((s): s is HdSetupStep => (HD_SETUP_STEPS as readonly string[]).includes(s as string))
    : d.setup_steps_done;
  const str = (x: unknown, fallback: string, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : fallback);
  return {
    timezone: typeof v.timezone === "string" && validTimezone(v.timezone) ? v.timezone : d.timezone,
    days: days.length ? days : d.days,
    start,
    end,
    holidays,
    outside_senders: v.outside_senders === true,
    inbound_address: str(v.inbound_address, d.inbound_address, 200),
    inbound_secret: typeof v.inbound_secret === "string" && /^[A-Za-z0-9_-]{0,64}$/.test(v.inbound_secret) ? v.inbound_secret : "",
    csat_enabled: v.csat_enabled === undefined ? d.csat_enabled : v.csat_enabled === true,
    setup_steps_done: [...new Set(steps)],
    email_from_name: str(v.email_from_name, d.email_from_name, 80) || d.email_from_name,
    setup_complete: v.setup_complete === true,
  };
}

export async function getHelpdeskSettings(client?: HdQueryable): Promise<HdSettings> {
  // With `client` (a caller's transaction) the read stays on it: the pool has five connections.
  const read = (key: string) =>
    client
      ? client.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]).then((r) => (r.rows[0] ? openSecret(r.rows[0].value) : undefined))
      : getSetting(key);
  const raw = await read(HD_SETTINGS_KEY);
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const stored = parsed && typeof parsed === "object" ? (parsed as { timezone?: unknown }).timezone : undefined;
  // No usable zone stored: the workspace's (read only then).
  const zone = typeof stored === "string" && validTimezone(stored) ? null : ((await read("timezone").catch(() => undefined)) ?? "").trim();
  return normalizeSettings(parsed, zone);
}

/** The business-hours part only (what lib/helpdesk/sla needs). */
export async function getBusinessHours(client?: HdQueryable): Promise<HdBusinessHours> {
  const s = await getHelpdeskSettings(client);
  return { timezone: s.timezone, days: s.days, start: s.start, end: s.end, holidays: s.holidays };
}

/**
 * Merge a patch into the stored settings and save. Returns the saved value
 * and the keys that changed (for the audit row; the inbound secret's value
 * is never in it).
 */
export async function saveHelpdeskSettings(
  patch: Partial<HdSettings>,
  opts: { syncMailboxes?: boolean } = {}
): Promise<{ settings: HdSettings; changed: (keyof HdSettings)[] }> {
  // 1.20.2: read and written under the row's lock, on one connection. The
  // mailbox module rewrites two keys of this value inside its own
  // transactions (mirrorDefaultToSettings); without the lock a save that
  // read before such a write would put the older address back.
  const { next, changed } = await withTx(async (client) => {
    await client.query("SELECT 1 FROM settings WHERE key = $1 FOR UPDATE", [HD_SETTINGS_KEY]);
    const before = await getHelpdeskSettings(client);
    const next = normalizeSettings({ ...before, ...patch }, before.timezone);
    const changed = (Object.keys(next) as (keyof HdSettings)[]).filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(before[k])
    );
    if (changed.length) {
      await client.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [HD_SETTINGS_KEY, JSON.stringify(next)]);
    }
    return { next, changed };
  });
  // 1.20.2 (lib/helpdesk/mailboxes): inbound_address and email_from_name are
  // the default mailbox's address and name. A write to them here moves that
  // mailbox, so the two never disagree; the mailbox module's own mirror
  // passes syncMailboxes: false.
  if (opts.syncMailboxes !== false && (changed.includes("inbound_address") || changed.includes("email_from_name"))) {
    const { syncDefaultMailboxFromSettings } = await import("./mailboxes");
    await syncDefaultMailboxFromSettings(next, changed);
  }
  return { settings: next, changed };
}

/** A fresh inbound secret (32 url-safe characters). */
export function newInboundSecret(): string {
  return randomBytes(24).toString("base64url");
}

/** Mark checklist steps done (idempotent). */
export async function markSetupSteps(steps: HdSetupStep[], complete?: boolean): Promise<HdSettings> {
  const cur = await getHelpdeskSettings();
  const done = [...new Set([...cur.setup_steps_done, ...steps])];
  const { settings } = await saveHelpdeskSettings({
    setup_steps_done: done,
    ...(complete !== undefined ? { setup_complete: complete || cur.setup_complete } : {}),
  });
  return settings;
}

/** The settings as an admin page reads them: the inbound secret masked to whether it is set. */
export function publicSettings(s: HdSettings): Omit<HdSettings, "inbound_secret"> & { inbound_enabled: boolean } {
  const { inbound_secret, ...rest } = s;
  return { ...rest, inbound_enabled: inbound_secret !== "" };
}
