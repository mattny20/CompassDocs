// Helpdesk 1.19.0: Web Push and the agents' notification preferences
// (lib/helpdesk/push, lib/helpdesk/notify-prefs, the push and
// notification-prefs routes).
//
// Pure rules first (defaults, merge and validation, quiet hours across
// midnight and time zones, break-through, pause, private previews, the
// endpoint allowlist), then against the database: subscriptions, sending
// through a fake push service (the HTTP POST is swapped; the VAPID
// signature and aes128gcm encryption run for real, and the test decrypts
// what the "push service" received with the browser's private key), dead
// subscriptions removed on 410, deliverAgentNotification's fan-out under
// the agent's preferences, and the routes (licence 402, agent-only, rate
// limit). Accounts, teams and devices are this file's own.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-push.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { createECDH, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { pool, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next ------------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-push.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-push.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
const edition = { present: true, features: ["helpdesk"] as string[] };
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;

  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;

  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if (request === "./ee" || request === "../ee") {
      if (parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

// Loaded after the stubs are in place.
/* eslint-disable @typescript-eslint/no-require-imports */
const shared = require("../src/lib/helpdesk/notify-prefs-shared") as typeof import("../src/lib/helpdesk/notify-prefs-shared");
const prefsMod = require("../src/lib/helpdesk/notify-prefs") as typeof import("../src/lib/helpdesk/notify-prefs");
const push = require("../src/lib/helpdesk/push") as typeof import("../src/lib/helpdesk/push");
const pushShared = require("../src/lib/helpdesk/push-shared") as typeof import("../src/lib/helpdesk/push-shared");
const subsRoute = require("../src/app/api/helpdesk/push/subscriptions/route") as typeof import("../src/app/api/helpdesk/push/subscriptions/route");
const devicesRoute = require("../src/app/api/helpdesk/push/devices/route") as typeof import("../src/app/api/helpdesk/push/devices/route");
const deviceRoute = require("../src/app/api/helpdesk/push/devices/[id]/route") as typeof import("../src/app/api/helpdesk/push/devices/[id]/route");
const testRoute = require("../src/app/api/helpdesk/push/test/route") as typeof import("../src/app/api/helpdesk/push/test/route");
const vapidRoute = require("../src/app/api/helpdesk/push/vapid/route") as typeof import("../src/app/api/helpdesk/push/vapid/route");
const prefsRoute = require("../src/app/api/helpdesk/me/notification-prefs/route") as typeof import("../src/app/api/helpdesk/me/notification-prefs/route");
/* eslint-enable @typescript-eslint/no-require-imports */

async function call(run: () => Promise<Response>, req: Request): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await run();
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON body */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string, body?: unknown, method = "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      cookie: `compass_session=${session}`,
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "x-forwarded-for": "203.0.113.77",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- A browser's push keys, and the push service's view ------------------------

interface FakeBrowser {
  ecdh: ReturnType<typeof createECDH>;
  auth: Buffer;
  sub: { endpoint: string; keys: { p256dh: string; auth: string } };
}

function fakeBrowser(host = "fcm.googleapis.com"): FakeBrowser {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    sub: {
      endpoint: `https://${host}/fcm/send/${randomBytes(12).toString("hex")}`,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    },
  };
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** RFC 8291 / 8188: what the service worker would read out of an aes128gcm body. */
function decrypt(b: FakeBrowser, body: Buffer): any {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const uaPublic = b.ecdh.getPublicKey();
  const secret = b.ecdh.computeSecret(asPublic);
  const prkKey = hmac(b.auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "binary")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "binary")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, "last record delimiter");
  return JSON.parse(plain.subarray(0, end).toString("utf8"));
}

interface Delivery {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer | null;
}
let deliveries: Delivery[] = [];
const answers = new Map<string, number>();

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdpush-${Date.now()}-${randomBytes(3).toString("hex")}`;
const ids: number[] = [];
const sessions: Record<string, string> = {};
const users: Record<string, number> = {};
let teamA = 0;
let teamB = 0;
const emails: { userId: number; template: string }[] = [];

async function person(key: string, agent: boolean): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, 'viewer', 'active', 'Europe/London') RETURNING id`,
    [`${STAMP}-${key}`, `${key} ${STAMP}`, `${STAMP}-${key}@example.test`]
  );
  const id = r.rows[0].id as number;
  ids.push(id);
  const s = newToken();
  await createSession(s, id, new Date(Date.now() + 3_600_000).toISOString());
  sessions[key] = s;
  users[key] = id;
  if (agent) {
    await pool().query(
      `INSERT INTO role_assignments (role_id, user_id, scope_type) SELECT id, $1, 'global' FROM roles WHERE key = 'helpdesk-agent'`,
      [id]
    );
  }
  return id;
}

before(async () => {
  await person("agent", true);
  await person("agent2", true);
  await person("viewer", false);
  await person("routes", true);
  const a = await pool().query("INSERT INTO hd_teams (name) VALUES ($1), ($2) RETURNING id", [`${STAMP} IT`, `${STAMP} HR`]);
  [teamA, teamB] = a.rows.map((r) => r.id as number);
  await pool().query("INSERT INTO hd_team_members (team_id, user_id) VALUES ($1, $3), ($2, $3)", [teamA, teamB, users.agent]);
  push.setPushTransportForTests(async (endpoint, init) => {
    deliveries.push({ endpoint, headers: init.headers, body: init.body });
    const status = answers.get(endpoint) ?? 201;
    return { status, text: status >= 400 ? "push service says no" : "" };
  });
  prefsMod.setAgentEmailSenderForTests(async (userId, template) => {
    emails.push({ userId, template });
    return true;
  });
});

after(async () => {
  push.setPushTransportForTests(null);
  prefsMod.setAgentEmailSenderForTests(null);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[teamA, teamB]]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM notify_digest_queue WHERE user_id = ANY($1)", [ids]).catch(() => {});
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  await pool().end();
});

// --- Preferences: defaults, merge, validation ---------------------------------------

describe("preferences", () => {
  test("defaults: every event on every channel it is meant for, full previews, sound, no quiet hours or pause", () => {
    const d = shared.defaultPrefs();
    for (const ev of shared.HD_NOTIFY_EVENTS) {
      assert.equal(d.matrix[ev].push, true, `${ev} push`);
      assert.equal(d.matrix[ev].bell, true, `${ev} bell`);
    }
    assert.equal(d.matrix.assigned_to_me.email, true);
    assert.equal(d.matrix.new_in_my_teams.email, false);
    assert.equal(d.matrix.sla_warning.email, false);
    assert.equal(d.matrix.review_requested.email, false);
    assert.deepEqual([d.preview, d.sound, d.quiet.enabled, d.pause], ["full", true, false, null]);
    assert.deepEqual(shared.AGENT_NOTIFY_EVENTS, shared.HD_NOTIFY_EVENTS);
  });

  test("stored prefs lay over the defaults; junk is dropped, never thrown", () => {
    const p = shared.resolvePrefs({
      matrix: { assigned_to_me: { email: false, push: "yes" }, made_up: { push: false } },
      teams: { "12": false, abc: true, "13": "no" },
      quiet: { enabled: true, start: "25:00", end: "07:30", days: [1, 1, 9, 5], breakthrough: false },
      preview: "loud",
      sound: false,
      pause: { until: "not a date" },
    });
    assert.equal(p.matrix.assigned_to_me.email, false);
    assert.equal(p.matrix.assigned_to_me.push, true);
    assert.deepEqual(p.teams, { "12": false });
    assert.deepEqual(p.quiet, { enabled: true, start: "18:00", end: "07:30", days: [1, 5], breakthrough: false });
    assert.equal(p.preview, "full");
    assert.equal(p.sound, false);
    assert.equal(p.pause, null);
    assert.deepEqual(shared.resolvePrefs("garbage"), shared.defaultPrefs());
  });

  test("a patch is checked strictly: unknown keys, events, channels and bad values are refused with a sentence", () => {
    assert.equal(shared.prefsPatchProblem({ matrix: { assigned_to_me: { push: false } }, pause: "1h" }), null);
    assert.match(shared.prefsPatchProblem({ colour: "red" })!, /Unknown preference/);
    assert.match(shared.prefsPatchProblem({ matrix: { nope: { push: true } } })!, /Unknown event/);
    assert.match(shared.prefsPatchProblem({ matrix: { reopened: { sms: true } } })!, /Unknown channel/);
    assert.match(shared.prefsPatchProblem({ matrix: { reopened: { push: 1 } } })!, /true or false/);
    assert.match(shared.prefsPatchProblem({ quiet: { start: "7pm" } })!, /18:00/);
    assert.match(shared.prefsPatchProblem({ quiet: { days: [7] } })!, /0 \(Sunday\)/);
    assert.match(shared.prefsPatchProblem({ pause: "forever" })!, /Pause/);
    assert.match(shared.prefsPatchProblem({ teams: { x: true } })!, /team is an id/);
    assert.match(shared.prefsPatchProblem([])!, /object/);
  });

  test("saving merges field by field and stores only the switched matrix cells", async () => {
    const id = users.agent2;
    await prefsMod.saveNotifyPrefs(id, { matrix: { reopened: { email: false } }, quiet: { enabled: true } });
    const after = await prefsMod.saveNotifyPrefs(id, { matrix: { reopened: { push: false } }, quiet: { start: "21:00" }, sound: false });
    assert.deepEqual(after.matrix.reopened, { push: false, email: false, bell: true });
    assert.equal(after.quiet.enabled, true);
    assert.equal(after.quiet.start, "21:00");
    assert.equal(after.sound, false);
    const raw = (await pool().query("SELECT prefs FROM hd_notify_prefs WHERE user_id = $1", [id])).rows[0].prefs;
    assert.deepEqual(raw.matrix, { reopened: { email: false, push: false } }, "untouched cells follow the workspace default");
    await assert.rejects(prefsMod.saveNotifyPrefs(id, { sound: "loud" }), prefsMod.NotifyPrefsError);
    await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = $1", [id]);
  });
});

// --- Quiet hours, pause, break-through ---------------------------------------------

describe("quiet hours", () => {
  const q = (o: Partial<import("../src/lib/helpdesk/notify-prefs-shared").HdQuietHours>) => ({ ...shared.DEFAULT_QUIET, enabled: true, ...o });

  test("a same-day window: inside is quiet, the end minute is not", () => {
    const quiet = q({ start: "12:00", end: "13:00", days: [5] });
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-06T12:30:00Z"), "UTC"), true); // Friday
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-06T13:00:00Z"), "UTC"), false);
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-07T12:30:00Z"), "UTC"), false); // Saturday not chosen
    assert.equal(shared.inQuietHours({ ...quiet, enabled: false }, new Date("2026-11-06T12:30:00Z"), "UTC"), false);
  });

  test("an overnight window belongs to the day it starts on", () => {
    const quiet = q({ start: "22:00", end: "07:00", days: [5] }); // Friday nights only
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-06T23:00:00Z"), "UTC"), true, "Friday 23:00");
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-07T03:00:00Z"), "UTC"), true, "Saturday 03:00, Friday's night");
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-07T07:00:00Z"), "UTC"), false, "Saturday 07:00");
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-07T23:00:00Z"), "UTC"), false, "Saturday 23:00");
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-06T03:00:00Z"), "UTC"), false, "Friday 03:00 is Thursday's night");
  });

  test("the window is read in the agent's time zone", () => {
    const quiet = q({ start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6] });
    const at = new Date("2026-11-06T22:30:00Z");
    assert.equal(shared.inQuietHours(quiet, at, "Europe/Berlin"), true, "23:30 in Berlin");
    assert.equal(shared.inQuietHours(quiet, at, "America/New_York"), false, "17:30 in New York");
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-06T13:30:00Z"), "Asia/Tokyo"), true, "22:30 in Tokyo");
    assert.equal(shared.inQuietHours(quiet, at, "Not/AZone"), true, "an unknown zone reads as UTC");
  });

  test("the same start and end mean the whole day", () => {
    const quiet = q({ start: "00:00", end: "00:00", days: [0, 6] });
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-07T15:00:00Z"), "UTC"), true);
    assert.equal(shared.inQuietHours(quiet, new Date("2026-11-06T15:00:00Z"), "UTC"), false);
  });

  test("wall clock to instant across a DST change", () => {
    assert.equal(shared.zonedTimeToUtc(2026, 3, 29, 8, 0, "Europe/London").toISOString(), "2026-03-29T07:00:00.000Z");
    assert.equal(shared.zonedTimeToUtc(2026, 3, 28, 8, 0, "Europe/London").toISOString(), "2026-03-28T08:00:00.000Z");
    assert.equal(shared.zonedTimeToUtc(2026, 11, 2, 8, 0, "America/New_York").toISOString(), "2026-11-02T13:00:00.000Z");
  });

  test("pause: an hour, until 08:00 tomorrow in the agent's zone, until resumed, off", () => {
    const now = new Date("2026-11-06T15:00:00Z");
    assert.equal(shared.pauseFor("1h", now, "UTC")!.until, "2026-11-06T16:00:00.000Z");
    // Already Saturday 00:00 in Tokyo, so "tomorrow" is Sunday 08:00 JST.
    assert.equal(shared.pauseFor("tomorrow", now, "Asia/Tokyo")!.until, "2026-11-07T23:00:00.000Z");
    assert.equal(shared.pauseFor("tomorrow", now, "Europe/London")!.until, "2026-11-07T08:00:00.000Z");
    assert.deepEqual(shared.pauseFor("indefinite", now, "UTC"), { until: null });
    assert.equal(shared.pauseFor("off", now, "UTC"), null);
    assert.equal(shared.isPaused({ pause: { until: "2026-11-06T16:00:00.000Z" } }, now), true);
    assert.equal(shared.isPaused({ pause: { until: "2026-11-06T14:00:00.000Z" } }, now), false);
    assert.equal(shared.isPaused({ pause: { until: null } }, now), true);
  });

  test("break-through: urgent tickets and SLA breaches pass quiet hours when allowed; a pause holds everything", () => {
    const prefs = shared.resolvePrefs({ quiet: { enabled: true, start: "00:00", end: "00:00", days: [0, 1, 2, 3, 4, 5, 6], breakthrough: true } });
    const now = new Date("2026-11-06T12:00:00Z");
    assert.equal(shared.holdReason(prefs, "assigned_to_me", false, now, "UTC"), "quiet");
    assert.equal(shared.holdReason(prefs, "assigned_to_me", true, now, "UTC"), null);
    assert.equal(shared.holdReason(prefs, "sla_breach", false, now, "UTC"), null);
    assert.equal(shared.holdReason(prefs, "sla_warning", false, now, "UTC"), "quiet");
    const strict = { ...prefs, quiet: { ...prefs.quiet, breakthrough: false } };
    assert.equal(shared.holdReason(strict, "sla_breach", true, now, "UTC"), "quiet");
    const paused = { ...prefs, pause: { until: null } };
    assert.equal(shared.holdReason(paused, "sla_breach", true, now, "UTC"), "paused");
    // The bell is never held.
    assert.deepEqual(prefsMod.localDecision(paused, "assigned_to_me", "bell", false, now, "UTC").send, true);
    assert.deepEqual(prefsMod.localDecision(paused, "assigned_to_me", "push", false, now, "UTC").send, false);
  });
});

// --- Payloads and endpoints --------------------------------------------------------

describe("payloads", () => {
  const n = {
    ticketNumber: 1048,
    title: "New in IT: #1048 Payroll export shows salaries",
    body: "From Priya Shah: the CSV includes everyone's salary",
    url: "/desk/tickets/1048",
  };

  test("a private preview carries the number only, no subject, body or name", () => {
    const p = prefsMod.buildPushPayload("new_in_my_teams", n, { preview: "private", sound: true });
    assert.equal(p.title, "New ticket #1048");
    assert.equal(p.body, "Open the desk to read it.");
    const json = JSON.stringify(p);
    assert.doesNotMatch(json, /Payroll|salar|Priya/);
    assert.equal(p.tag, "hd-t1048");
    assert.equal(p.url, "/desk/tickets/1048");
  });

  test("a full preview carries the title and body; sound off makes it silent", () => {
    const p = prefsMod.buildPushPayload("new_in_my_teams", n, { preview: "full", sound: false });
    assert.equal(p.title, n.title);
    assert.equal(p.body, n.body);
    assert.equal(p.silent, true);
  });

  test("only same-origin paths survive as the click target", () => {
    for (const bad of ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/\\evil", ""]) {
      assert.equal(prefsMod.safePath(bad), "/desk", bad);
    }
    assert.equal(prefsMod.safePath("/help/approvals"), "/help/approvals");
  });

  test("payloads stay under 3 KB however long the body", () => {
    const p = prefsMod.buildPushPayload("requester_replied", { ...n, body: "ü".repeat(20_000), title: "t".repeat(500) }, { preview: "full", sound: true });
    const s = push.encodePayload(p);
    assert.ok(Buffer.byteLength(s) <= push.MAX_PAYLOAD_BYTES, `${Buffer.byteLength(s)} bytes`);
    assert.equal(JSON.parse(s).ticket, 1048);
  });

  test("subscriptions must point at a known push service, over https, with well-formed keys", () => {
    const ok = fakeBrowser().sub;
    assert.equal(push.subscriptionProblem(ok), null);
    for (const host of ["updates.push.services.mozilla.com", "web.push.apple.com", "wns2-par02p.notify.windows.com"]) {
      assert.equal(push.subscriptionProblem(fakeBrowser(host).sub), null, host);
    }
    assert.match(push.subscriptionProblem({ ...ok, endpoint: "https://169.254.169.254/latest" })!, /push service/);
    assert.match(push.subscriptionProblem({ ...ok, endpoint: "https://fcm.googleapis.com.evil.example/x" })!, /push service/);
    assert.match(push.subscriptionProblem({ ...ok, endpoint: "http://fcm.googleapis.com/fcm/send/x" })!, /push service/);
    assert.match(push.subscriptionProblem({ ...ok, endpoint: "https://fcm.googleapis.com:8443/x" })!, /push service/);
    assert.match(push.subscriptionProblem({ ...ok, keys: { ...ok.keys, p256dh: "AAAA" } })!, /public key/);
    assert.match(push.subscriptionProblem({ ...ok, keys: { ...ok.keys, auth: "!!" } })!, /auth/);
    assert.match(push.subscriptionProblem(null)!, /subscription/);
  });

  test("the device is described from its user agent and the page's hints", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    assert.deepEqual(pushShared.describeDevice(mac), { browser: "safari", os: "macos" });
    assert.deepEqual(pushShared.describeDevice(mac, { touchMac: true }), { browser: "safari", os: "ipados" });
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    assert.equal(pushShared.deviceLabel(pushShared.describeDevice(iphone)), "Safari on iPhone");
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    assert.deepEqual(pushShared.describeDevice(chrome, { brave: true }), { browser: "brave", os: "windows" });
    assert.deepEqual(pushShared.describeDevice(chrome + " Edg/141.0.0.0"), { browser: "edge", os: "windows" });
    assert.deepEqual(pushShared.describeDevice("Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0"), { browser: "firefox", os: "android" });
  });
});

// --- Subscriptions and sending -------------------------------------------------------

describe("subscriptions and sending", () => {
  test("subscribe, list, rename, re-subscribe keeps the label; another agent on the same browser takes it over", async () => {
    const b = fakeBrowser();
    const d = await push.subscribePush(users.agent2, b.sub, { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36", brave: true });
    assert.equal(d.label, "Brave on Windows");
    assert.equal(d.fingerprint, push.endpointFingerprint(b.sub.endpoint));
    await push.renamePushDevice(users.agent2, d.id, "  Work\nlaptop  ");
    const again = await push.subscribePush(users.agent2, b.sub, { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36" });
    assert.equal(again.id, d.id);
    assert.equal(again.label, "Work laptop");
    const list = await push.listPushDevices(users.agent2);
    assert.equal(list.length, 1);
    assert.equal((list[0] as unknown as Record<string, unknown>).endpoint, undefined, "no endpoint in the list");
    // Someone else signs in on that browser and turns notifications on.
    const moved = await push.subscribePush(users.agent, b.sub, { userAgent: "x" });
    assert.equal(moved.id, d.id);
    assert.equal((await push.listPushDevices(users.agent2)).length, 0);
    assert.equal(await push.renamePushDevice(users.agent2, d.id, "mine"), null, "not theirs any more");
    assert.equal(await push.unsubscribePush(users.agent, { id: d.id }), true);
  });

  test("a send is VAPID-signed and aes128gcm-encrypted, with TTL, urgency and topic; the browser can read it", async () => {
    const b = fakeBrowser();
    await push.subscribePush(users.agent2, b.sub, {});
    deliveries = [];
    const r = await push.sendPushToUser(
      users.agent2,
      { v: 1, title: "Hello", body: "World", tag: "hd-t1", url: "/desk/tickets/1", ticket: 1, silent: false, renotify: true, ts: 1 },
      { ttl: 3600, urgency: "high", topic: "t1" }
    );
    assert.deepEqual(r, { attempted: 1, sent: 1, removed: 0, failed: 0 });
    const got = deliveries.find((x) => x.endpoint === b.sub.endpoint)!;
    assert.equal(got.headers["Content-Encoding"], "aes128gcm");
    assert.match(got.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(got.headers.TTL, "3600");
    assert.equal(got.headers.Urgency, "high");
    assert.equal(got.headers.Topic, "t1");
    assert.equal(decrypt(b, got.body!).title, "Hello");
    const row = (await pool().query("SELECT last_used_at, last_error FROM hd_push_subscriptions WHERE endpoint = $1", [b.sub.endpoint])).rows[0];
    assert.ok(row.last_used_at);
    assert.equal(row.last_error, "");
    await push.unsubscribePush(users.agent2, { endpoint: b.sub.endpoint });
  });

  test("a 410 or 404 deletes the dead subscription; other refusals are kept as last_error", async () => {
    const gone = fakeBrowser();
    const lost = fakeBrowser("updates.push.services.mozilla.com");
    const flaky = fakeBrowser("web.push.apple.com");
    for (const b of [gone, lost, flaky]) await push.subscribePush(users.agent2, b.sub, {});
    answers.set(gone.sub.endpoint, 410);
    answers.set(lost.sub.endpoint, 404);
    answers.set(flaky.sub.endpoint, 503);
    const r = await push.sendTestPush(users.agent2);
    assert.deepEqual(r, { attempted: 3, sent: 0, removed: 2, failed: 1 });
    const left = await push.listPushDevices(users.agent2);
    assert.equal(left.length, 1);
    assert.match(left[0].last_error, /^503 /);
    await push.unsubscribePush(users.agent2, { id: left[0].id });
  });

  test("an agent keeps at most 20 devices; the least recently used go first", async () => {
    const first = fakeBrowser();
    await push.subscribePush(users.agent2, first.sub, {});
    await pool().query("UPDATE hd_push_subscriptions SET created_at = now() - interval '1 day' WHERE endpoint = $1", [first.sub.endpoint]);
    for (let i = 0; i < push.MAX_DEVICES_PER_USER; i++) await push.subscribePush(users.agent2, fakeBrowser().sub, {});
    const list = await push.listPushDevices(users.agent2);
    assert.equal(list.length, push.MAX_DEVICES_PER_USER);
    assert.ok(!list.some((d) => d.fingerprint === push.endpointFingerprint(first.sub.endpoint)));
    await pool().query("DELETE FROM hd_push_subscriptions WHERE user_id = $1", [users.agent2]);
  });

  test("the VAPID key pair is made once and stored sealed", async () => {
    const k1 = await push.vapidPublicKey();
    push.resetVapidCache();
    assert.equal(await push.vapidPublicKey(), k1);
    const raw = (await pool().query("SELECT value FROM settings WHERE key = 'helpdesk_vapid'")).rows[0].value as string;
    assert.ok(raw.startsWith("enc:v1:"), "sealed at rest");
    assert.ok(!raw.includes(k1));
  });
});

// --- deliverAgentNotification ----------------------------------------------------------

describe("deliverAgentNotification", () => {
  const n = {
    ticketNumber: 2001,
    title: "Assigned to you: #2001 Laptop for Sam Lee",
    body: "Sam starts on Monday",
    url: "/desk/tickets/2001",
    teamId: 0,
    email: { template: "hd_assigned" as const, vars: { ticket_number: "2001" } },
  };
  let browser: FakeBrowser;
  const reset = async () => {
    deliveries = [];
    emails.length = 0;
    await pool().query("DELETE FROM notifications WHERE user_id = $1", [users.agent]);
    await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = $1", [users.agent]);
  };
  const bells = async () => (await pool().query("SELECT kind, title, link FROM notifications WHERE user_id = $1", [users.agent])).rows;
  const pushedTo = () => deliveries.filter((d) => d.endpoint === browser.sub.endpoint);

  before(async () => {
    browser = fakeBrowser();
    await push.subscribePush(users.agent, browser.sub, {});
  });

  test("defaults: bell, email and push all go out", async () => {
    await reset();
    const r = await prefsMod.deliverAgentNotification(users.agent, "assigned_to_me", n, new Date("2026-11-06T12:00:00Z"));
    assert.equal(r.bell, true);
    assert.equal(r.email, true);
    assert.equal(r.push?.sent, 1);
    assert.deepEqual(await bells(), [{ kind: "hd_ticket", title: n.title, link: n.url }]);
    assert.deepEqual(emails, [{ userId: users.agent, template: "hd_assigned" }]);
    const payload = decrypt(browser, pushedTo()[0].body!);
    assert.equal(payload.title, n.title);
    assert.equal(pushedTo()[0].headers.Topic, "t2001");
  });

  test("switched-off channels stay quiet; without an email template there is no email", async () => {
    await reset();
    await prefsMod.saveNotifyPrefs(users.agent, { matrix: { assigned_to_me: { email: false, bell: false } } });
    const r = await prefsMod.deliverAgentNotification(users.agent, "assigned_to_me", n, new Date("2026-11-06T12:00:00Z"));
    assert.deepEqual([r.bell, r.email, r.push?.sent], [false, false, 1]);
    assert.equal((await bells()).length, 0);
    assert.equal(emails.length, 0);
    await reset();
    const r2 = await prefsMod.deliverAgentNotification(users.agent, "reopened", { ...n, email: undefined }, new Date("2026-11-06T12:00:00Z"));
    assert.equal(r2.email, false);
    assert.equal(emails.length, 0);
  });

  test("private previews keep the ticket's text out of what the push service carries", async () => {
    await reset();
    await prefsMod.saveNotifyPrefs(users.agent, { preview: "private", sound: false });
    await prefsMod.deliverAgentNotification(users.agent, "assigned_to_me", n, new Date("2026-11-06T12:00:00Z"));
    const payload = decrypt(browser, pushedTo()[0].body!);
    assert.equal(payload.title, "Ticket #2001 assigned to you");
    assert.equal(payload.silent, true);
    assert.doesNotMatch(JSON.stringify(payload), /Laptop|Sam/);
    assert.match((await bells())[0].title, /Laptop/, "the bell keeps the full title");
  });

  test("quiet hours hold push (bell still records); urgent and SLA breaches break through; off when not allowed", async () => {
    await reset();
    // Quiet all day, every day, in London.
    await prefsMod.saveNotifyPrefs(users.agent, { quiet: { enabled: true, start: "00:00", end: "00:00", days: [0, 1, 2, 3, 4, 5, 6], breakthrough: true } });
    const at = new Date("2026-11-06T12:00:00Z");
    const held = await prefsMod.deliverAgentNotification(users.agent, "assigned_to_me", n, at);
    assert.equal(held.bell, true);
    assert.equal(held.push, null);
    assert.equal(held.held, "quiet");
    assert.equal(emails.length, 0, "no email sent now (a digest takes it)");
    const urgent = await prefsMod.deliverAgentNotification(users.agent, "assigned_to_me", { ...n, urgent: true }, at);
    assert.equal(urgent.push?.sent, 1);
    const breach = await prefsMod.deliverAgentNotification(users.agent, "sla_breach", { ...n, title: "#2001 missed its SLA target" }, at);
    assert.equal(breach.push?.sent, 1);
    await prefsMod.saveNotifyPrefs(users.agent, { quiet: { breakthrough: false } });
    const strict = await prefsMod.deliverAgentNotification(users.agent, "sla_breach", { ...n, urgent: true }, at);
    assert.equal(strict.push, null);
    // Outside the chosen days it all flows again.
    await prefsMod.saveNotifyPrefs(users.agent, { quiet: { days: [0] } });
    const friday = await prefsMod.deliverAgentNotification(users.agent, "assigned_to_me", n, at);
    assert.equal(friday.push?.sent, 1);
  });

  test("a pause holds push and email whatever the urgency; the bell keeps collecting", async () => {
    await reset();
    await prefsMod.saveNotifyPrefs(users.agent, { pause: "indefinite" });
    const r = await prefsMod.deliverAgentNotification(users.agent, "sla_breach", { ...n, urgent: true }, new Date());
    assert.deepEqual([r.bell, r.email, r.push, r.held], [true, false, null, "paused"]);
    assert.equal((await bells())[0].kind, "hd_sla");
    await prefsMod.saveNotifyPrefs(users.agent, { pause: "off" });
    const after = await prefsMod.deliverAgentNotification(users.agent, "sla_breach", n, new Date());
    assert.equal(after.push?.sent, 1);
  });

  test("a team switched off silences that team's new tickets only", async () => {
    await reset();
    await prefsMod.saveNotifyPrefs(users.agent, { teams: { [String(teamA)]: false } });
    const off = await prefsMod.deliverAgentNotification(users.agent, "new_in_my_teams", { ...n, teamId: teamA, email: undefined }, new Date("2026-11-06T12:00:00Z"));
    assert.deepEqual([off.bell, off.push, off.held], [false, null, "team_off"]);
    const on = await prefsMod.deliverAgentNotification(users.agent, "new_in_my_teams", { ...n, teamId: teamB, email: undefined }, new Date("2026-11-06T12:00:00Z"));
    assert.equal(on.bell, true);
    assert.equal(on.push?.sent, 1);
    const view = await prefsMod.notifyView(users.agent);
    assert.equal(view.teams.find((t) => t.id === teamA)?.on, false);
    assert.equal(view.teams.find((t) => t.id === teamB)?.on, true);
  });

  test("approvals ring the approval bell; an unknown event does nothing", async () => {
    await reset();
    const r = await prefsMod.deliverAgentNotification(users.agent, "approval_needed", { ...n, url: "/help/approvals", email: undefined }, new Date("2026-11-06T12:00:00Z"));
    assert.equal(r.bell, true);
    assert.equal((await bells())[0].kind, "hd_approval");
    const none = await prefsMod.deliverAgentNotification(users.agent, "nope" as never, n);
    assert.deepEqual(none, { bell: false, email: false, push: null, held: null });
  });
});

// --- Routes ----------------------------------------------------------------------------

describe("routes", () => {
  test("agents only: a viewer gets 403; without the licence everyone gets 402", async () => {
    const v = await call(() => vapidRoute.GET(), req("/api/helpdesk/push/vapid", sessions.viewer, undefined, "GET"));
    assert.equal(v.status, 403);
    const a = await call(() => vapidRoute.GET(), req("/api/helpdesk/push/vapid", sessions.routes, undefined, "GET"));
    assert.equal(a.status, 200);
    assert.match(a.body.public_key, /^[A-Za-z0-9_-]{80,}$/);
    edition.features = [];
    try {
      const r = await call(() => devicesRoute.GET(), req("/api/helpdesk/push/devices", sessions.routes, undefined, "GET"));
      assert.equal(r.status, 402);
      const p = await call(() => prefsRoute.GET(), req("/api/helpdesk/me/notification-prefs", sessions.routes, undefined, "GET"));
      assert.equal(p.status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });

  test("a cross-origin POST is refused", async () => {
    const r = new Request("http://localhost/api/helpdesk/push/subscriptions", {
      method: "POST",
      headers: { cookie: `compass_session=${sessions.routes}`, origin: "https://evil.example", host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ subscription: fakeBrowser().sub }),
    });
    assert.equal((await call(() => subsRoute.POST(r), r)).status, 403);
  });

  test("subscribe, list, rename, test, remove round-trip; bad input is refused", async () => {
    const b = fakeBrowser();
    const r0 = req("/api/helpdesk/push/subscriptions", sessions.routes, { subscription: { ...b.sub, endpoint: "https://intranet.local/x" } });
    const bad = await call(() => subsRoute.POST(r0), r0);
    assert.equal(bad.status, 400);
    const r1 = req("/api/helpdesk/push/subscriptions", sessions.routes, { subscription: b.sub, label: "Desk PC" });
    const s = await call(() => subsRoute.POST(r1), r1);
    assert.equal(s.status, 201);
    assert.equal(s.body.device.label, "Desk PC");
    assert.equal(s.body.device.browser, "chrome");
    const id = s.body.device.id as number;

    const list = await call(() => devicesRoute.GET(), req("/api/helpdesk/push/devices", sessions.routes, undefined, "GET"));
    assert.equal(list.body.devices.length, 1);

    const ren = req(`/api/helpdesk/push/devices/${id}`, sessions.routes, { label: "Front desk" }, "PATCH");
    assert.equal((await call(() => deviceRoute.PATCH(ren, { params: Promise.resolve({ id: String(id) }) }), ren)).body.device.label, "Front desk");
    const other = req(`/api/helpdesk/push/devices/${id}`, sessions.agent2, { label: "Mine now" }, "PATCH");
    assert.equal((await call(() => deviceRoute.PATCH(other, { params: Promise.resolve({ id: String(id) }) }), other)).status, 404, "not another agent's device");

    deliveries = [];
    const t = req("/api/helpdesk/push/test", sessions.routes, { device_id: id });
    const sent = await call(() => testRoute.POST(t), t);
    assert.equal(sent.status, 200);
    assert.equal(decrypt(b, deliveries[0].body!).title, "Desk notifications are on");

    const del = req("/api/helpdesk/push/subscriptions", sessions.routes, { endpoint: b.sub.endpoint }, "DELETE");
    assert.equal((await call(() => subsRoute.DELETE(del), del)).body.removed, true);
    const none = req("/api/helpdesk/push/test", sessions.routes, {});
    assert.equal((await call(() => testRoute.POST(none), none)).status, 404);
  });

  test("test sends are rate-limited", async () => {
    const b = fakeBrowser();
    await push.subscribePush(users.routes, b.sub, {});
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const t = req("/api/helpdesk/push/test", sessions.routes, {});
      last = (await call(() => testRoute.POST(t), t)).status;
    }
    assert.equal(last, 429);
    await push.unsubscribePush(users.routes, { endpoint: b.sub.endpoint });
  });

  test("preferences: GET shows the matrix as it applies; PUT saves, refuses bad input and computes a pause", async () => {
    const g = await call(() => prefsRoute.GET(), req("/api/helpdesk/me/notification-prefs", sessions.routes, undefined, "GET"));
    assert.equal(g.status, 200);
    assert.equal(g.body.effective.assigned_to_me.push.on, true);
    assert.equal(g.body.timezone, "Europe/London");
    const put = req("/api/helpdesk/me/notification-prefs", sessions.routes, { matrix: { requester_replied: { email: false } }, pause: "1h" }, "PUT");
    const saved = await call(() => prefsRoute.PUT(put), put);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.effective.requester_replied.email.on, false);
    assert.equal(saved.body.paused_now, true);
    const bad = req("/api/helpdesk/me/notification-prefs", sessions.routes, { quiet: { start: "late" } }, "PUT");
    const refused = await call(() => prefsRoute.PUT(bad), bad);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /18:00/);
  });
});
