// The notification decision (1.19.0, lib/notify-policy-shared): the
// catalog covers every sender, the workspace's locks beat a person's
// choice, new people get the catalog's defaults, quiet hours and a pause
// hold what they should and nothing else, security is always on, and the
// delivery mode routes email into digests. Pure: no database (the
// migration and the digest queue are in notify-policy-db.test.ts).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  NOTIFY_EVENTS,
  NOTIFY_SECTIONS,
  HD_REQUESTER_EVENTS,
  compactPolicy,
  decide,
  deskEvent,
  emptyPolicy,
  eventForKind,
  emptyPrefs,
  notifyEvent,
  pauseForPreset,
  policyProblem,
  resolvePolicy,
  resolveUserPrefs,
  userPrefsProblem,
  type DecideInput,
  type NotifyChannel,
  type NotifyPolicy,
  type UserNotifyPrefs,
} from "../src/lib/notify-policy-shared";
import { HD_NOTIFY_EVENTS } from "../src/lib/helpdesk/notify-prefs-shared";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// A Wednesday, 12:00 UTC.
const NOON = new Date("2026-11-04T12:00:00Z");
const NIGHT = new Date("2026-11-04T23:30:00Z");

function input(over: Partial<DecideInput> = {}): DecideInput {
  return { policy: emptyPolicy(), prefs: emptyPrefs(), timeZone: "UTC", now: NOON, ...over };
}
const prefsWith = (p: Partial<UserNotifyPrefs>): UserNotifyPrefs => ({ ...emptyPrefs(), ...p });
const policyWith = (events: NotifyPolicy["events"]): NotifyPolicy => ({ v: 1, events });

describe("the catalog", () => {
  test("ids are unique and every event has a known section and at least one channel", () => {
    const ids = NOTIFY_EVENTS.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const e of NOTIFY_EVENTS) {
      assert.ok((NOTIFY_SECTIONS as readonly string[]).includes(e.section), e.id);
      assert.ok(Object.keys(e.channels).length > 0, e.id);
      assert.ok(e.label && e.hint, e.id);
    }
  });

  test("every bell kind NotificationEvent allows is in the catalog", () => {
    const src = read("src/lib/notifications.ts");
    const union = src.slice(src.indexOf("kind:"), src.indexOf("title: string;"));
    const kinds = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(kinds.length >= 12, "found the kind union");
    for (const k of kinds) assert.ok(notifyEvent(eventForKind(k)), `bell kind ${k} missing from the catalog`);
  });

  test("the helpdesk's requester events (agent C) and desk events (agent F) are all in the catalog", () => {
    const src = read("src/lib/helpdesk/notify.ts");
    const block = src.match(/REQUESTER_NOTIFY_EVENTS = \[([\s\S]*?)\]/);
    assert.ok(block, "REQUESTER_NOTIFY_EVENTS exported by lib/helpdesk/notify");
    for (const m of block[1].matchAll(/"([a-z_]+)"/g)) assert.ok(notifyEvent(m[1]), `requester event ${m[1]} missing`);
    for (const e of HD_REQUESTER_EVENTS) assert.ok(notifyEvent(e), e);
    for (const e of HD_NOTIFY_EVENTS) assert.ok(notifyEvent(deskEvent(e)), `desk event ${e} missing`);
    assert.equal(deskEvent("approval_needed"), "hd_approval_needed");
    assert.ok(notifyEvent("desk_review_requested") && notifyEvent("desk_review_returned"), "agent J's review events");
  });

  test("every event a sender names at a policy check is in the catalog", () => {
    const calls = /\b(?:emailGate|routeEmail|emailAllowedAddresses|enqueueDigest|shouldNotify|shouldNotifyMany|shouldNotifyChannels)\(/g;
    // The call's own argument list, by paren depth (arguments hold arrow functions).
    const args = (src: string, from: number) => {
      let depth = 1;
      let i = from;
      while (i < src.length && depth > 0 && i - from < 2000) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      return src.slice(from, i - 1).replace(/\(\) =>[\s\S]*$/, "");
    };
    const channels = new Set(["bell", "email", "push", "webhook", "digest_hourly", "digest_daily", "instant"]);
    const seen = new Set<string>();
    for (const file of walk(join(ROOT, "src"))) {
      if (file.includes("notify-policy")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(calls)) {
        for (const lit of args(src, m.index! + m[0].length).matchAll(/"([a-z][a-z0-9_]*)"/g)) {
          if (channels.has(lit[1])) continue;
          seen.add(lit[1]);
          assert.ok(notifyEvent(lit[1]), `${file.slice(ROOT.length + 1)} asks about "${lit[1]}", which the catalog lacks`);
        }
      }
    }
    for (const e of ["ack_requested", "training_assigned", "training_due", "review_due", "mention", "doc_update", "weekly_digest", "announcement", "newsletter", "newsletter_review", "training_team_digest"]) {
      assert.ok(seen.has(e), `no sender consults the policy for ${e}`);
    }
  });

  test("every personal email template belongs to an event (workspace reports and channels excepted)", () => {
    const src = read("src/lib/email-templates.ts");
    const keys = [...src.matchAll(/^\s{4}key: "([a-z_]+)"/gm)].map((m) => m[1]);
    const workspaceOnly = new Set(["workflow_event", "ack_program_report", "training_report"]);
    const covered = new Set(NOTIFY_EVENTS.flatMap((e) => e.templates ?? []));
    for (const k of keys) {
      if (workspaceOnly.has(k) || k.startsWith("hd_part") || !/^[a-z_]+$/.test(k)) continue;
      assert.ok(covered.has(k), `template ${k} has no event in the catalog`);
    }
  });
});

describe("defaults for someone new", () => {
  test("every channel follows the catalog's default", () => {
    for (const e of NOTIFY_EVENTS) {
      for (const [ch, def] of Object.entries(e.channels) as [NotifyChannel, boolean][]) {
        const d = decide(e.id, ch, input());
        assert.equal(d.send, e.security ? true : def, `${e.id}/${ch}`);
        assert.equal(d.mode, "instant", `${e.id}/${ch}`);
      }
    }
  });

  test("the weekly digest is off until chosen; a channel an event lacks is never sent", () => {
    assert.equal(decide("weekly_digest", "email", input()).send, false);
    assert.deepEqual(decide("comment", "email", input()), { send: false, mode: "instant", reason: "no_channel" });
  });
});

describe("the workspace's locks", () => {
  test("Locked off beats a person who chose on, Locked on beats a person who chose off", () => {
    const prefs = prefsWith({ channels: { mention: { email: true, bell: false } } });
    const policy = policyWith({ mention: { channels: { email: { control: "locked_off" }, bell: { control: "locked_on" } } } });
    assert.deepEqual(decide("mention", "email", input({ policy, prefs })), { send: false, mode: "instant", reason: "locked_off" });
    assert.deepEqual(decide("mention", "bell", input({ policy, prefs })), { send: true, mode: "instant", reason: "locked_on" });
  });

  test("Person chooses: the choice wins, and without one the workspace default does", () => {
    const policy = policyWith({ doc_update: { channels: { email: { default: false } } } });
    assert.equal(decide("doc_update", "email", input({ policy })).send, false);
    assert.equal(decide("doc_update", "email", input({ policy })).reason, "default_off");
    const prefs = prefsWith({ channels: { doc_update: { email: true } } });
    assert.equal(decide("doc_update", "email", input({ policy, prefs })).send, true);
  });

  test("a desk event: an explicit off on the desk's own page wins over the default", () => {
    const desk = { matrix: { assigned_to_me: { push: false } }, hold: () => null };
    assert.equal(decide("desk_assigned_to_me", "push", input({ desk })).send, false);
    assert.equal(decide("desk_assigned_to_me", "push", input({ desk })).reason, "desk_off");
    assert.equal(decide("desk_assigned_to_me", "bell", input({ desk })).send, true);
    const locked = policyWith({ desk_assigned_to_me: { channels: { push: { control: "locked_on" } } } });
    assert.equal(decide("desk_assigned_to_me", "push", input({ desk, policy: locked })).send, true);
  });

  test("validation refuses unknown events, channels an event lacks and any change to security", () => {
    assert.equal(policyProblem({ events: {} }), null);
    assert.match(policyProblem({ events: { nope: {} } }) ?? "", /Unknown event/);
    assert.match(policyProblem({ events: { comment: { channels: { email: { default: true } } } } }) ?? "", /isn't sent by email/);
    assert.match(policyProblem({ events: { security_sign_in: { channels: { email: { control: "locked_off" } } } } }) ?? "", /always sent/);
    assert.match(policyProblem({ events: { ack_requested: { mode: "digest_daily" } } }) ?? "", /at once/);
    assert.match(policyProblem({ events: { mention: { channels: { email: { control: "maybe" } } } } }) ?? "", /Person chooses/);
    // A forged security entry in storage is ignored.
    assert.deepEqual(resolvePolicy({ events: { security_password: { channels: { email: { control: "locked_off" } } } } }).events, {});
  });

  test("the stored policy keeps only what differs from the catalog", () => {
    const p = compactPolicy(
      policyWith({
        mention: { channels: { email: { default: true, control: "choose" }, bell: { control: "locked_on" } }, mode: "instant", mode_control: "choose" },
        doc_update: { mode: "digest_daily" },
      })
    );
    assert.deepEqual(p.events, { mention: { channels: { bell: { control: "locked_on" } } }, doc_update: { mode: "digest_daily" } });
  });
});

describe("security", () => {
  test("always on, whatever the person, the pause or the quiet hours", () => {
    const prefs = prefsWith({
      channels: { security_sign_in: { email: false } },
      pause: { until: null },
      quiet: { enabled: true, start: "00:00", end: "00:00", days: [0, 1, 2, 3, 4, 5, 6] },
    });
    for (const id of ["security_sign_in", "security_password"]) {
      assert.deepEqual(decide(id, "email", input({ prefs })), { send: true, mode: "instant", reason: "security" });
    }
    assert.match(userPrefsProblem({ channels: { security_sign_in: { email: false } } }) ?? "", /always sent/);
    assert.deepEqual(resolveUserPrefs({ channels: { security_sign_in: { email: false } } }).channels, {});
  });
});

describe("quiet hours and pause", () => {
  const quiet = { enabled: true, start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6] };

  test("quiet hours hold push and move instant email into the hourly digest; the bell is never held", () => {
    const prefs = prefsWith({ quiet });
    assert.deepEqual(decide("hd_approval_needed", "push", input({ prefs, now: NIGHT })), { send: false, mode: "instant", reason: "quiet_hours" });
    assert.deepEqual(decide("mention", "email", input({ prefs, now: NIGHT })), { send: true, mode: "digest_hourly", reason: "quiet_hours" });
    assert.equal(decide("mention", "bell", input({ prefs, now: NIGHT })).send, true);
    // Outside the window nothing changes.
    assert.deepEqual(decide("mention", "email", input({ prefs, now: NOON })), { send: true, mode: "instant", reason: "default_on" });
    // In the person's own zone: 23:30 UTC is 18:30 in New York, before quiet hours there.
    assert.equal(decide("mention", "email", input({ prefs, now: NIGHT, timeZone: "America/New_York" })).mode, "instant");
  });

  test("urgent notices come through quiet hours; evidence and newsletters are never held", () => {
    const prefs = prefsWith({ quiet });
    assert.equal(decide("hd_approval_needed", "push", input({ prefs, now: NIGHT, urgent: true })).send, true);
    assert.deepEqual(decide("ack_requested", "email", input({ prefs, now: NIGHT })), { send: true, mode: "instant", reason: "default_on" });
    assert.equal(decide("newsletter", "email", input({ prefs, now: NIGHT })).mode, "instant");
  });

  test("a pause holds email, push and the chat webhook, never the bell or security, and ends on time", () => {
    const until = new Date(NOON.getTime() + 3_600_000).toISOString();
    const prefs = prefsWith({ pause: { until } });
    for (const ch of ["email", "webhook"] as const) assert.equal(decide("mention", ch, input({ prefs })).reason, "paused");
    assert.equal(decide("hd_approval_needed", "push", input({ prefs, urgent: true })).reason, "paused");
    assert.equal(decide("mention", "bell", input({ prefs })).send, true);
    assert.equal(decide("security_password", "email", input({ prefs })).send, true);
    assert.equal(decide("mention", "email", input({ prefs, now: new Date(NOON.getTime() + 2 * 3_600_000) })).send, true);
  });

  test("pause presets", () => {
    assert.equal(pauseForPreset("off", NOON, "UTC"), null);
    assert.deepEqual(pauseForPreset("indefinite", NOON, "UTC"), { until: null });
    assert.equal(pauseForPreset("1h", NOON, "UTC")?.until, "2026-11-04T13:00:00.000Z");
    assert.equal(pauseForPreset("tomorrow", NOON, "UTC")?.until, "2026-11-05T08:00:00.000Z");
    assert.equal(pauseForPreset("week", NOON, "UTC")?.until, "2026-11-11T12:00:00.000Z");
  });

  test("the desk's own pause and quiet hours hold desk events too", () => {
    const paused = { matrix: {}, hold: () => "paused" as const };
    const quietDesk = { matrix: {}, hold: () => "quiet" as const };
    assert.equal(decide("desk_assigned_to_me", "push", input({ desk: paused })).reason, "paused");
    assert.equal(decide("desk_assigned_to_me", "push", input({ desk: quietDesk })).reason, "quiet_hours");
    assert.equal(decide("desk_assigned_to_me", "bell", input({ desk: paused })).send, true);
  });
});

describe("digest routing", () => {
  test("the workspace's mode applies, a person's section frequency overrides it, a locked mode doesn't move", () => {
    const policy = policyWith({ doc_update: { mode: "digest_daily" } });
    assert.equal(decide("doc_update", "email", input({ policy })).mode, "digest_daily");
    const prefs = prefsWith({ digest: { documents: "digest_hourly" } });
    assert.equal(decide("doc_update", "email", input({ policy, prefs })).mode, "digest_hourly");
    const locked = policyWith({ doc_update: { mode: "digest_daily", mode_control: "locked" } });
    assert.equal(decide("doc_update", "email", input({ policy: locked, prefs })).mode, "digest_daily");
  });

  test("only email digests; events that can't wait stay instant", () => {
    const prefs = prefsWith({ digest: { documents: "digest_daily", read_confirmations: "digest_daily" } });
    assert.equal(decide("doc_update", "bell", input({ prefs })).mode, "instant");
    assert.equal(decide("doc_update", "webhook", input({ prefs })).mode, "instant");
    assert.equal(decide("ack_requested", "email", input({ prefs })).mode, "instant");
    assert.equal(decide("desk_sla_breach", "email", input({ prefs: prefsWith({ digest: { desk: "digest_daily" } }) })).mode, "instant");
  });
});

describe("automated tickets", () => {
  test("requester events are never sent for a ticket with no human requester; agents still hear", () => {
    for (const id of [...HD_REQUESTER_EVENTS, "hd_approval_decided"]) {
      assert.deepEqual(decide(id, "email", input({ automated: true })), { send: false, mode: "instant", reason: "automated" });
      assert.equal(decide(id, "bell", input({ automated: true })).send, false);
    }
    assert.equal(decide("desk_new_in_my_teams", "bell", input({ automated: true })).send, true);
  });
});

describe("unknown events", () => {
  test("fall back to the pre-1.19 columns", () => {
    const legacy = { notify_prefs: { hd_request: { inapp: false } }, email_notifications: 1, weekly_digest: 0 };
    assert.deepEqual(decide("hd_request", "bell", input({ legacy })), { send: false, mode: "instant", reason: "unknown_event" });
    assert.equal(decide("hd_request", "webhook", input({ legacy })).send, true);
  });
});
