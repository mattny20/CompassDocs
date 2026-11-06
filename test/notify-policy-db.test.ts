// The notification decision against the database (1.19.0, lib/notify-policy):
// people who never saved the new page keep exactly what their pre-1.19
// settings did; saving writes both shapes; the legacy route keeps the new
// row in step; workspace locks beat personal choices; the desk's own
// choices count for desk events; the bell inbox follows the policy; and
// digest items wait in the queue until their hour (or quiet hours end).
//
// Parallel-safe: own users (stamped), own rows. The workspace policy is
// changed only under this file's advisory lock, only for events no other
// file sends (newsletter_review, weekly_digest), and restored after.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { getSetting, setSetting, pool, setEmailNotifications } from "../src/lib/db";
import {
  NOTIFY_POLICY_KEY,
  emailGate,
  enqueueDigest,
  ensureNotifySchema,
  forgetNotifyPolicyCache,
  getUserNotifyPrefs,
  saveNotifyPolicy,
  saveUserNotifyPrefs,
  sendNotificationDigests,
  shouldNotify,
  syncLegacyIntoNotifyPrefs,
} from "../src/lib/notify-policy";
import { LEGACY_KINDS, emptyPrefs, legacyAllows, notifyEvent, type LegacyPrefs, type NotifyChannel } from "../src/lib/notify-policy-shared";
import { notify } from "../src/lib/notifications";
import { fixtureQuery } from "./support/retry";

const STAMP = `np${process.pid}${Date.now().toString(36)}`;
const POLICY_LOCK = 728519; // this file's: the notification_policy setting
const userIds: number[] = [];
let lockClient: PoolClient | null = null;
let savedPolicy: string | undefined;

async function newUser(tag: string, legacy?: Partial<LegacyPrefs> & { timezone?: string }): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, notify_prefs, email_notifications, weekly_digest, timezone)
     VALUES ($1, $2, $3, 'viewer', 'active', $4, $5, $6, $7) RETURNING id`,
    [
      `${STAMP}-${tag}`,
      `Prefs ${tag}`,
      `${STAMP}-${tag}@example.test`,
      JSON.stringify(legacy?.notify_prefs ?? {}),
      legacy?.email_notifications ?? 1,
      legacy?.weekly_digest ?? 0,
      legacy?.timezone ?? "",
    ]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

/** Run with the workspace policy set to `events`, restoring it after (under the lock from before()). */
async function withPolicy(events: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
  const prior = await getSetting(NOTIFY_POLICY_KEY);
  await saveNotifyPolicy({ v: 1, events } as never);
  try {
    await fn();
  } finally {
    if (prior === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [NOTIFY_POLICY_KEY]);
    else await setSetting(NOTIFY_POLICY_KEY, prior);
    forgetNotifyPolicyCache();
  }
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  await ensureNotifySchema();
  const client = await pool().connect();
  await client.query("SELECT pg_advisory_lock($1)", [POLICY_LOCK]);
  lockClient = client;
  savedPolicy = await getSetting(NOTIFY_POLICY_KEY);
  // The regression compares against the out-of-the-box policy.
  await pool().query("DELETE FROM settings WHERE key = $1", [NOTIFY_POLICY_KEY]);
  forgetNotifyPolicyCache();
});

after(async () => {
  if (savedPolicy !== undefined) await setSetting(NOTIFY_POLICY_KEY, savedPolicy);
  else await pool().query("DELETE FROM settings WHERE key = $1", [NOTIFY_POLICY_KEY]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM notify_digest_queue WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [POLICY_LOCK]).catch(() => {});
    lockClient.release();
  }
});

// Every pre-1.19 shape that matters: the master switch, the digest switch,
// and opt-outs on each channel (including ones a sender never read).
const LEGACY_CASES: LegacyPrefs[] = [];
for (const email_notifications of [0, 1]) {
  for (const weekly_digest of [0, 1]) {
    LEGACY_CASES.push({ notify_prefs: {}, email_notifications, weekly_digest });
    LEGACY_CASES.push({
      notify_prefs: {
        mention: { inapp: false, email: false },
        comment: { webhook: false },
        doc_update: { email: false, inapp: false },
        review_due: { email: false },
        ack_requested: { email: false, webhook: false },
        ack_due: { inapp: false },
        training_due: { email: false },
        service_status: { inapp: false, webhook: false },
        hd_request: { email: false },
      },
      email_notifications,
      weekly_digest,
    });
  }
}

describe("migration keeps everyone's effective behaviour", () => {
  test("a person with no saved row answers exactly as the pre-1.19 senders did", async () => {
    const pairs: [string, NotifyChannel][] = [];
    for (const kind of [...LEGACY_KINDS, "weekly_digest"]) {
      for (const ch of ["bell", "webhook", "email"] as NotifyChannel[]) if (notifyEvent(kind)?.channels[ch] !== undefined) pairs.push([kind, ch]);
    }
    let i = 0;
    for (const legacy of LEGACY_CASES) {
      const id = await newUser(`legacy${i++}`, legacy);
      for (const [kind, ch] of pairs) {
        const got = await shouldNotify(id, kind, ch, { now: new Date("2026-11-04T12:00:00Z") });
        assert.equal(got.send, legacyAllows(legacy, kind, ch), `${JSON.stringify(legacy)} ${kind}/${ch} (${got.reason})`);
      }
      assert.equal((await getUserNotifyPrefs(id))?.stored, false);
    }
  });

  test("saving the new page writes the row and mirrors the old columns", async () => {
    const id = await newUser("save");
    const prefs = emptyPrefs();
    prefs.channels = { doc_update: { email: false }, weekly_digest: { email: true }, mention: { bell: false }, ack_due: { email: false } };
    prefs.digest = { documents: "digest_daily" };
    await saveUserNotifyPrefs(id, prefs);
    const u = (await pool().query("SELECT notify_prefs, email_notifications, weekly_digest FROM users WHERE id = $1", [id])).rows[0];
    assert.equal(u.email_notifications, 0);
    assert.equal(u.weekly_digest, 1);
    assert.deepEqual(u.notify_prefs, { mention: { inapp: false }, ack_due: { email: false } });
    const mine = await getUserNotifyPrefs(id);
    assert.equal(mine?.stored, true);
    assert.equal((await shouldNotify(id, "mention", "bell")).send, false);
    assert.equal((await shouldNotify(id, "weekly_digest", "email")).send, true);
    assert.equal((await shouldNotify(id, "review_due", "email")).mode, "digest_daily");
  });

  test("the pre-1.19 route's writes are laid over a saved row", async () => {
    const id = await newUser("sync");
    const prefs = emptyPrefs();
    prefs.channels = { doc_update: { email: false }, mention: { email: true } };
    prefs.quiet = { enabled: true, start: "21:00", end: "07:00", days: [1, 2, 3] };
    await saveUserNotifyPrefs(id, prefs);
    await setEmailNotifications(id, true);
    await syncLegacyIntoNotifyPrefs(id);
    const mine = (await getUserNotifyPrefs(id))!.prefs;
    assert.equal(mine.channels.doc_update, undefined, "master switch on clears the subscription opt-out");
    assert.equal(mine.channels.mention, undefined, "and the mention email choice the switch also covered");
    assert.equal(mine.quiet.start, "21:00", "what the old columns don't describe stays");
  });
});

describe("the workspace policy", () => {
  test("a lock beats the person's choice; unlocking returns to it", async () => {
    const id = await newUser("lock", { weekly_digest: 1 });
    assert.equal((await shouldNotify(id, "weekly_digest", "email")).send, true);
    await withPolicy({ weekly_digest: { channels: { email: { control: "locked_off" } } }, newsletter_review: { channels: { email: { control: "locked_off" } } } }, async () => {
      assert.deepEqual(await shouldNotify(id, "weekly_digest", "email"), { send: false, mode: "instant", reason: "locked_off" });
      assert.equal((await emailGate([id], "newsletter_review")).allows(id), false);
      // A save while locked drops the locked choice, so an unlock falls back to the default.
      const p = emptyPrefs();
      p.channels = { weekly_digest: { email: true } };
      const saved = await saveUserNotifyPrefs(id, p);
      assert.equal(saved.channels.weekly_digest, undefined);
    });
    assert.equal((await shouldNotify(id, "weekly_digest", "email")).send, false, "the default (off) after the locked save");
  });

  test("security is on for everyone, including someone who never set anything", async () => {
    const id = await newUser("sec", { email_notifications: 0 });
    assert.deepEqual(await shouldNotify(id, "security_sign_in", "email"), { send: true, mode: "instant", reason: "security" });
  });

  test("an unknown account is never notified", async () => {
    assert.equal((await shouldNotify(2_000_000_000, "mention", "bell")).send, false);
  });
});

describe("the desk's own choices", () => {
  test("an agent's desk opt-out counts for desk events", async (t) => {
    const ok = (await pool().query("SELECT to_regclass('hd_notify_prefs') AS t")).rows[0].t;
    if (!ok) return t.skip("helpdesk schema not booted");
    const id = await newUser("desk");
    await pool().query("INSERT INTO hd_notify_prefs (user_id, prefs) VALUES ($1, $2)", [id, JSON.stringify({ matrix: { assigned_to_me: { push: false } } })]);
    assert.equal((await shouldNotify(id, "desk_assigned_to_me", "push")).reason, "desk_off");
    assert.equal((await shouldNotify(id, "desk_assigned_to_me", "bell")).send, true);
  });
});

describe("the bell inbox", () => {
  test("notify() follows the person's choice per event", async () => {
    const off = await newUser("bell-off", { notify_prefs: { service_status: { inapp: false } } });
    const on = await newUser("bell-on");
    const r = await notify([off, on], { kind: "service_status", title: `${STAMP} status` });
    assert.deepEqual(r.inboxIds, [on]);
  });
});

describe("digests", () => {
  type Sent = { to: string[]; subject: string; text: string };
  const capture = (box: Sent[]) => async (to: string[], subject: string, text: string) => {
    box.push({ to, subject, text });
  };

  test("hourly items go out on the next tick; daily ones from 08:00 local, once a day", async () => {
    const id = await newUser("digest", { timezone: "UTC" });
    await enqueueDigest(id, "doc_update", "digest_hourly", { title: "Alex updated Leave policy", link: "/doc/1" });
    await enqueueDigest(id, "mention", "digest_hourly", { title: "Sam mentioned you", body: "In Onboarding" });
    await enqueueDigest(id, "hd_desk_replied", "digest_daily", { title: "Reply on #1047" });

    const box: Sent[] = [];
    const early = await sendNotificationDigests({ now: new Date("2026-11-04T06:10:00Z"), mailer: capture(box), userIds: [id] });
    assert.equal(early.sent, 2);
    assert.equal(box.length, 1);
    assert.match(box[0].subject, /^2 notifications/);
    assert.match(box[0].text, /Documents and comments\n- Alex updated Leave policy/);

    await sendNotificationDigests({ now: new Date("2026-11-04T09:10:00Z"), mailer: capture(box), userIds: [id] });
    assert.equal(box.length, 2);
    assert.match(box[1].text, /Helpdesk requests\n- Reply on #1047/);

    // A second daily item the same day waits for tomorrow.
    await enqueueDigest(id, "hd_desk_replied", "digest_daily", { title: "Another reply" });
    await sendNotificationDigests({ now: new Date("2026-11-04T15:10:00Z"), mailer: capture(box), userIds: [id] });
    assert.equal(box.length, 2);
    await sendNotificationDigests({ now: new Date("2026-11-05T08:10:00Z"), mailer: capture(box), userIds: [id] });
    assert.equal(box.length, 3);
  });

  test("a queued item waits out quiet hours and a pause; a refused mail is kept for the next tick", async () => {
    const id = await newUser("digest-quiet", { timezone: "UTC" });
    const p = emptyPrefs();
    p.quiet = { enabled: true, start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6] };
    await saveUserNotifyPrefs(id, p);
    const d = await shouldNotify(id, "mention", "email", { now: new Date("2026-11-04T23:30:00Z") });
    assert.deepEqual(d, { send: true, mode: "digest_hourly", reason: "quiet_hours" });
    await enqueueDigest(id, "mention", "digest_hourly", { title: "Held mention" });
    const box: Sent[] = [];
    const night = await sendNotificationDigests({ now: new Date("2026-11-04T23:40:00Z"), mailer: capture(box), userIds: [id] });
    assert.equal(night.held, 1);
    assert.equal(box.length, 0);
    const refused = await sendNotificationDigests({
      now: new Date("2026-11-05T07:10:00Z"),
      mailer: async () => {
        throw new Error("SMTP down");
      },
      userIds: [id],
    });
    assert.equal(refused.sent, 0);
    await sendNotificationDigests({ now: new Date("2026-11-05T07:20:00Z"), mailer: capture(box), userIds: [id] });
    assert.equal(box.length, 1);
    assert.match(box[0].text, /Held mention/);
  });

  test("routing through the gate: a digest mode queues instead of sending", async () => {
    const id = await newUser("route");
    const p = emptyPrefs();
    p.digest = { documents: "digest_hourly" };
    await saveUserNotifyPrefs(id, p);
    let sent = 0;
    const gate = await emailGate([id], "review_due");
    assert.equal(await gate.route(id, { title: "Review due" }, async () => void sent++), "queued");
    assert.equal(sent, 0);
    const n = (await pool().query("SELECT count(*)::int AS n FROM notify_digest_queue WHERE user_id = $1 AND event = 'review_due'", [id])).rows[0].n;
    assert.equal(n, 1);
  });
});
