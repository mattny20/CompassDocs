// Helpdesk 1.19.0: Web Push to agents' browsers and phones (Chrome, Edge,
// Firefox, Safari on macOS 13+, Safari on iOS/iPadOS 16.4+ once the desk is
// added to the Home Screen, Brave with Google push messaging on).
//
// - VAPID: one key pair per workspace, generated on first use and stored
//   sealed (lib/secretbox) in settings under `helpdesk_vapid`.
// - Subscriptions: hd_push_subscriptions, one row per browser endpoint,
//   owned by the agent who subscribed last on that browser, and tied to
//   the session that did it (session_sid): signing that session out, "sign
//   out everywhere" and disabling the account drop the device (lib/db
//   forgetPushDevices); sending skips and drops anyone no longer an
//   active desk member.
// - Sending: the `web-push` library builds the request (VAPID JWT and the
//   aes128gcm payload encryption); it goes out through lib/safe-fetch so
//   HTTPS_PROXY is honoured. Endpoints must belong to a known push service
//   (an endpoint is a URL the browser hands us, and the page could hand us
//   any URL), so the server never posts to an internal address.
// - A 404 or 410 from the push service means the subscription is gone: the
//   row is deleted. Other failures are kept on the row as `last_error`.
//
// Payloads stay under 3 KB and carry no ticket text when the agent chose
// private previews (lib/helpdesk/notify-prefs builds them). Server-only.

import "server-only";
import { createHash } from "node:crypto";
import webpush from "web-push";
import { getSetting } from "../db";
import { safeFetch } from "../safe-fetch";
import { openSecret, sealSecret } from "../secretbox";
import { hq, hqOne } from "./db-core";
import {
  describeDevice,
  deviceLabel,
  HD_BROWSERS,
  HD_OSES,
  type HdPushBrowser,
  type HdPushDevice,
  type HdPushOs,
  type HdPushPayload,
} from "./push-shared";

export type { HdPushDevice, HdPushPayload } from "./push-shared";

const VAPID_SETTING = "helpdesk_vapid";
/** Devices one agent may register; the least recently used goes first. */
export const MAX_DEVICES_PER_USER = 20;
/** Push services cap payloads near 4 KB after encryption; stay well clear. */
export const MAX_PAYLOAD_BYTES = 3000;

// --- VAPID keys -------------------------------------------------------------------

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cachedKeys: VapidKeys | null = null;

function parseKeys(raw: string | undefined): VapidKeys | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(openSecret(raw)) as Partial<VapidKeys>;
    if (typeof v.publicKey === "string" && typeof v.privateKey === "string" && v.publicKey && v.privateKey) {
      return { publicKey: v.publicKey, privateKey: v.privateKey };
    }
  } catch {
    /* unreadable: treated as absent below only when nothing is stored */
  }
  return null;
}

/**
 * The workspace's VAPID key pair, created on first use. Concurrent first
 * calls race on INSERT … ON CONFLICT DO NOTHING and all read the winner.
 */
export async function vapidKeys(): Promise<VapidKeys> {
  if (cachedKeys) return cachedKeys;
  const readRaw = async () =>
    (await hqOne<{ value: string }>("SELECT value FROM settings WHERE key = $1", [VAPID_SETTING]))?.value;
  let raw = await readRaw();
  if (raw === undefined) {
    const fresh = webpush.generateVAPIDKeys();
    await hq("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [
      VAPID_SETTING,
      sealSecret(JSON.stringify(fresh)),
    ]);
    raw = await readRaw();
  }
  const keys = parseKeys(raw);
  if (!keys) throw new Error("The stored push keys are unreadable. Check the encryption key (COMPASSDOCS_SECRET_KEY).");
  cachedKeys = keys;
  return keys;
}

/** The public key the browser subscribes with (base64url). */
export async function vapidPublicKey(): Promise<string> {
  return (await vapidKeys()).publicKey;
}

/** Forget the cached pair (tests). */
export function resetVapidCache(): void {
  cachedKeys = null;
}

let rememberedOrigin = "";
/** Routes pass the request origin so the VAPID contact can name the site. */
export function rememberPushOrigin(origin: string | null | undefined): void {
  if (origin && /^https:\/\/[^/\s]+$/.test(origin) && !/\/\/(localhost|127\.|\[::1\])/.test(origin)) rememberedOrigin = origin;
}

/**
 * The VAPID `sub` claim: a contact for the push service operator. Safari
 * insists on a valid https: or mailto: URL. Env override, then the custom
 * domain, the site's own https origin, the SMTP sender, a placeholder.
 */
async function vapidSubject(): Promise<string> {
  const env = process.env.COMPASSDOCS_PUSH_SUBJECT?.trim();
  if (env && /^(https:\/\/|mailto:)\S+$/.test(env)) return env;
  try {
    const domain = (await getSetting("custom_domain"))?.trim();
    if (domain && /^[a-z0-9.-]+$/i.test(domain)) return `https://${domain}`;
  } catch {
    /* fall through */
  }
  if (rememberedOrigin) return rememberedOrigin;
  try {
    const from = (await getSetting("smtp_from"))?.trim() ?? "";
    const m = from.match(/[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+/);
    if (m) return `mailto:${m[0]}`;
  } catch {
    /* fall through */
  }
  return "mailto:helpdesk@compassdocs.invalid";
}

// --- Endpoint and key validation --------------------------------------------------

/** Hosts of the browser push services. Operators can add more (comma list). */
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com", // Chrome, Edge on Android, Brave, Opera, Samsung
  "android.googleapis.com", // older Chrome subscriptions
  "push.services.mozilla.com", // Firefox (updates.push.services.mozilla.com)
  "push.apple.com", // Safari (web.push.apple.com)
  "notify.windows.com", // Edge on Windows (wns2-*.notify.windows.com)
];

function extraPushHosts(): string[] {
  return (process.env.COMPASSDOCS_PUSH_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+$/.test(h));
}

/** True for an https URL on a known push service (or an operator-added host). */
export function pushEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return [...PUSH_HOST_SUFFIXES, ...extraPushHosts()].some((s) => host === s || host.endsWith(`.${s}`));
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const decodedLength = (s: string) => Buffer.from(s.replace(/=+$/, ""), "base64url").length;

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The problem with a browser subscription, or null when it is usable. */
export function subscriptionProblem(input: unknown): string | null {
  const v = input as Partial<PushSubscriptionInput> | null;
  if (!v || typeof v !== "object") return "Send the browser's push subscription.";
  if (typeof v.endpoint !== "string" || v.endpoint.length > 1024) return "The subscription has no usable endpoint.";
  if (!pushEndpointAllowed(v.endpoint)) return "That push service isn't one CompassDocs sends to.";
  const k = v.keys;
  if (!k || typeof k.p256dh !== "string" || typeof k.auth !== "string") return "The subscription is missing its keys.";
  if (k.p256dh.length > 120 || !B64URL.test(k.p256dh) || decodedLength(k.p256dh) !== 65) return "The subscription's public key is malformed.";
  if (k.auth.length > 40 || !B64URL.test(k.auth) || decodedLength(k.auth) !== 16) return "The subscription's auth secret is malformed.";
  return null;
}

export function endpointFingerprint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
}

// --- Rows -------------------------------------------------------------------------

interface SubRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  label: string;
  platform: string;
  created_at: string;
  last_used_at: string | null;
  last_error: string | null;
}

function splitPlatform(platform: string): { browser: HdPushBrowser; os: HdPushOs } {
  const [b, o] = (platform || "").split(":");
  return {
    browser: (HD_BROWSERS as string[]).includes(b) ? (b as HdPushBrowser) : "other",
    os: (HD_OSES as string[]).includes(o) ? (o as HdPushOs) : "other",
  };
}

function toDevice(r: SubRow): HdPushDevice {
  const { browser, os } = splitPlatform(r.platform);
  return {
    id: r.id,
    label: r.label || deviceLabel({ browser, os }),
    browser,
    os,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    last_error: r.last_error ?? "",
    fingerprint: endpointFingerprint(r.endpoint),
  };
}

/** Collapse whitespace and control characters, cap the length. */
export function cleanLabel(raw: unknown, max = 60): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export async function listPushDevices(userId: number): Promise<HdPushDevice[]> {
  const rows = await hq<SubRow>(
    "SELECT * FROM hd_push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC, id DESC",
    [userId]
  );
  return rows.map(toDevice);
}

export async function countPushDevices(userId: number): Promise<number> {
  const r = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_push_subscriptions WHERE user_id = $1", [userId]);
  return r?.n ?? 0;
}

/**
 * Store (or move to this agent) a browser's subscription. Re-subscribing
 * the same browser updates its keys and keeps its label. Returns the device.
 */
export async function subscribePush(
  userId: number,
  input: PushSubscriptionInput,
  meta: { userAgent?: string; label?: string; brave?: boolean; touchMac?: boolean; sessionSid?: string | null } = {}
): Promise<HdPushDevice> {
  const problem = subscriptionProblem(input);
  if (problem) throw new Error(problem);
  const ua = (meta.userAgent || "").slice(0, 400);
  const d = describeDevice(ua, { brave: meta.brave, touchMac: meta.touchMac });
  const label = cleanLabel(meta.label);
  const row = await hqOne<SubRow>(
    `INSERT INTO hd_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, label, platform, last_error, session_sid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '', $8)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       session_sid = EXCLUDED.session_sid,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       platform = EXCLUDED.platform,
       label = CASE WHEN hd_push_subscriptions.user_id = EXCLUDED.user_id AND EXCLUDED.label = ''
                    THEN hd_push_subscriptions.label ELSE EXCLUDED.label END,
       created_at = CASE WHEN hd_push_subscriptions.user_id = EXCLUDED.user_id
                         THEN hd_push_subscriptions.created_at ELSE now() END,
       last_error = ''
     RETURNING *`,
    [userId, input.endpoint, input.keys.p256dh, input.keys.auth, ua, label, `${d.browser}:${d.os}`, meta.sessionSid ?? null]
  );
  // Keep the newest MAX_DEVICES_PER_USER; a browser that never came back goes first.
  await hq(
    `DELETE FROM hd_push_subscriptions WHERE id IN (
       SELECT id FROM hd_push_subscriptions WHERE user_id = $1
       ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC OFFSET $2)`,
    [userId, MAX_DEVICES_PER_USER]
  );
  return toDevice(row!);
}

/** Remove one of the agent's devices, by id or by endpoint. True when a row went. */
export async function unsubscribePush(userId: number, by: { id?: number; endpoint?: string }): Promise<boolean> {
  if (by.id !== undefined) {
    const r = await hq("DELETE FROM hd_push_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id", [by.id, userId]);
    return r.length > 0;
  }
  if (by.endpoint) {
    const r = await hq("DELETE FROM hd_push_subscriptions WHERE endpoint = $1 AND user_id = $2 RETURNING id", [
      by.endpoint,
      userId,
    ]);
    return r.length > 0;
  }
  return false;
}

export async function renamePushDevice(userId: number, id: number, label: string): Promise<HdPushDevice | null> {
  const row = await hqOne<SubRow>(
    "UPDATE hd_push_subscriptions SET label = $3 WHERE id = $1 AND user_id = $2 RETURNING *",
    [id, userId, cleanLabel(label)]
  );
  return row ? toDevice(row) : null;
}

// --- Sending ----------------------------------------------------------------------

/** What a push service answered. */
export interface PushResponse {
  status: number;
  text: string;
}

export type PushTransport = (endpoint: string, init: { headers: Record<string, string>; body: Buffer | null }) => Promise<PushResponse>;

const defaultTransport: PushTransport = async (endpoint, init) => {
  // fetch sets Content-Length from the body itself.
  const headers = Object.fromEntries(Object.entries(init.headers).filter(([k]) => k.toLowerCase() !== "content-length"));
  const res = await safeFetch(endpoint, {
    method: "POST",
    headers,
    body: init.body ? new Uint8Array(init.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, text: text.slice(0, 300) };
};

let transport: PushTransport = defaultTransport;

/**
 * Test seam: swap the network call for a fake push service. Encryption and
 * VAPID signing still run for real; only the HTTP POST is replaced.
 */
export function setPushTransportForTests(t: PushTransport | null): void {
  transport = t ?? defaultTransport;
}

export interface SendOptions {
  /** Seconds the push service keeps an undelivered message. */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Replaces an undelivered message with the same topic (≤ 32 URL-safe chars). */
  topic?: string;
  /** Only this device (the Send test button). */
  deviceId?: number;
}

export interface SendResult {
  attempted: number;
  sent: number;
  removed: number;
  failed: number;
}

/** Encode, check the size, and trim the body until it fits. */
export function encodePayload(p: HdPushPayload): string {
  let payload = { ...p, title: p.title.slice(0, 120), body: p.body.slice(0, 600) };
  let s = JSON.stringify(payload);
  while (Buffer.byteLength(s) > MAX_PAYLOAD_BYTES && payload.body.length > 0) {
    payload = { ...payload, body: payload.body.slice(0, Math.max(0, Math.floor(payload.body.length * 0.7) - 1)) + "…" };
    if (payload.body === "…") payload.body = "";
    s = JSON.stringify(payload);
  }
  if (Buffer.byteLength(s) > MAX_PAYLOAD_BYTES) {
    s = JSON.stringify({ ...payload, title: payload.title.slice(0, 60), url: "/desk" });
  }
  return s;
}

/**
 * Is this person still someone the desk pushes to: an active account with
 * a desk role? Push is agents-only (the subscribe route is), so anyone else
 * has their devices dropped instead of reached (a deactivated or
 * offboarded agent still assigned to open tickets, say).
 */
async function stillPushable(userId: number): Promise<boolean> {
  const u = await hqOne<{ status: string }>("SELECT status FROM users WHERE id = $1", [userId]);
  if (!u || u.status !== "active") return false;
  const { hdRoleOf } = await import("./roles");
  return (await hdRoleOf(userId)) !== null;
}

/** Send one payload to every device of the agent (or one device). Never throws for a push-service refusal. */
export async function sendPushToUser(userId: number, payload: HdPushPayload, opts: SendOptions = {}): Promise<SendResult> {
  if (!(await stillPushable(userId))) {
    const gone = await hq("DELETE FROM hd_push_subscriptions WHERE user_id = $1 RETURNING id", [userId]);
    return { attempted: 0, sent: 0, removed: gone.length, failed: 0 };
  }
  const rows = await hq<SubRow>(
    opts.deviceId !== undefined
      ? "SELECT * FROM hd_push_subscriptions WHERE user_id = $1 AND id = $2"
      : "SELECT * FROM hd_push_subscriptions WHERE user_id = $1",
    opts.deviceId !== undefined ? [userId, opts.deviceId] : [userId]
  );
  const result: SendResult = { attempted: rows.length, sent: 0, removed: 0, failed: 0 };
  if (rows.length === 0) return result;
  const keys = await vapidKeys();
  const subject = await vapidSubject();
  const body = encodePayload(payload);
  const topic = opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic) ? opts.topic : undefined;

  await Promise.all(
    rows.map(async (row) => {
      if (!pushEndpointAllowed(row.endpoint)) {
        // Stored before an operator narrowed COMPASSDOCS_PUSH_HOSTS: drop it.
        await hq("DELETE FROM hd_push_subscriptions WHERE id = $1", [row.id]);
        result.removed++;
        return;
      }
      let status = 0;
      let detail = "";
      try {
        const req = webpush.generateRequestDetails({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body, {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: Math.max(0, Math.min(opts.ttl ?? 86_400, 2_419_200)),
          urgency: opts.urgency ?? "normal",
          topic,
          contentEncoding: "aes128gcm",
        });
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && v !== null) headers[k] = String(v);
        const res = await transport(row.endpoint, { headers, body: req.body });
        status = res.status;
        detail = res.text;
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e);
      }
      if (status >= 200 && status < 300) {
        result.sent++;
        await hq("UPDATE hd_push_subscriptions SET last_used_at = now(), last_error = '' WHERE id = $1", [row.id]);
      } else if (status === 404 || status === 410) {
        result.removed++;
        await hq("DELETE FROM hd_push_subscriptions WHERE id = $1", [row.id]);
      } else {
        result.failed++;
        const msg = (status ? `${status} ${detail}` : detail || "No answer from the push service").replace(/\s+/g, " ").trim().slice(0, 200);
        console.error(`helpdesk push: device ${row.id} of user ${userId}: ${msg}`);
        await hq("UPDATE hd_push_subscriptions SET last_error = $2 WHERE id = $1", [row.id, msg]);
      }
    })
  );
  return result;
}

/** The Send test button: a short-lived notification to one device or all. */
export async function sendTestPush(userId: number, deviceId?: number): Promise<SendResult> {
  return sendPushToUser(
    userId,
    {
      v: 1,
      title: "Desk notifications are on",
      body: "This is a test from CompassDocs Desk. New tickets and replies will arrive like this.",
      tag: "hd-test",
      url: "/desk/settings/notifications",
      ticket: null,
      silent: false,
      renotify: true,
      ts: Date.now(),
    },
    { ttl: 300, urgency: "normal", deviceId, topic: "hd-test" }
  );
}

// --- Rate limits ------------------------------------------------------------------

const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Per-process limiter for the push routes (test sends, subscribes). Answers
 * the seconds to wait, or 0 when allowed. Like lib/rate-limit, a cost guard
 * on top of auth, not a security boundary.
 */
export function pushRetryAfter(key: string, max: number, windowMs: number, now = Date.now()): number {
  let w = buckets.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + windowMs };
    buckets.set(key, w);
  }
  w.count++;
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  return w.count > max ? Math.max(1, Math.ceil((w.resetAt - now) / 1000)) : 0;
}
