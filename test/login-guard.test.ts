// The sign-in throttle's reservation (lib/login-guard beginLoginAttempt and
// refundLoginAttempt, 1.16.0): an attempt is checked and counted in one
// synchronous step, before its outcome is known, so a burst sent at once
// can't all pass the check; an attempt that did not fail gives its count
// back, and a lock that counting it engaged is lifted.
//
// No database: the throttle is in memory. Every test uses its own address.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/login-guard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginLoginAttempt,
  refundLoginAttempt,
  loginRetryAfter,
  recordLoginFailure,
  recordPairFailure,
  pairRetryAfter,
} from "../src/lib/login-guard";

test("ten attempts begun at once for one name: five are let through, and the fifth engages the lock", () => {
  const ip = "198.18.0.1";
  const attempts = Array.from({ length: 10 }, () => beginLoginAttempt("burst", ip));
  assert.equal(attempts.filter((a) => a.wait === 0).length, 5);
  assert.deepEqual(
    attempts.map((a) => a.lockEngaged),
    [false, false, false, false, true, false, false, false, false, false],
    "engaged once, by the fifth"
  );
  for (const a of attempts.slice(5)) assert.ok(a.wait > 0);
  assert.ok(loginRetryAfter("burst", ip) > 0);
  assert.ok(loginRetryAfter("BURST", ip) > 0, "the key folds case");
});

test("forty names begun at once from one address: thirty are let through", () => {
  const ip = "198.18.0.2";
  const attempts = Array.from({ length: 40 }, (_, i) => beginLoginAttempt(`spray-${i}`, ip));
  assert.equal(attempts.filter((a) => a.wait === 0).length, 30);
  assert.equal(attempts.filter((a) => a.lockEngaged).length, 1);
  assert.ok(loginRetryAfter("anyone-else", ip) > 0);
});

test("an attempt that did not fail gives its count back, and lifts the lock it engaged", () => {
  const ip = "198.18.0.3";
  for (let i = 0; i < 4; i++) assert.equal(beginLoginAttempt("ann", ip).wait, 0);
  const fifth = beginLoginAttempt("ann", ip);
  assert.equal(fifth.lockEngaged, true);
  assert.ok(loginRetryAfter("ann", ip) > 0, "locked while it is in flight");
  refundLoginAttempt(fifth, false); // the right password, the code still to come
  assert.equal(loginRetryAfter("ann", ip), 0);
  refundLoginAttempt(fifth, false);
  const again = beginLoginAttempt("ann", ip);
  assert.equal(again.wait, 0);
  assert.equal(again.lockEngaged, true, "four failures stand, so the next attempt is the fifth (a second refund changed nothing)");
});

test("a sign-in clears the pair and gives the address its count back", () => {
  const ip = "198.18.0.4";
  for (let i = 0; i < 25; i++) beginLoginAttempt(`miss-${i}`, ip);
  for (let i = 0; i < 4; i++) beginLoginAttempt("bea", ip);
  const ok = beginLoginAttempt("bea", ip);
  assert.equal(ok.lockEngaged, true, "the fifth for the name and the thirtieth from the address");
  refundLoginAttempt(ok, true);
  assert.equal(loginRetryAfter("bea", ip), 0, "both locks lifted");
  for (let i = 0; i < 4; i++) assert.equal(recordPairFailure("bea", ip), false, "the pair starts again from nothing");
  const next = beginLoginAttempt("someone", ip);
  assert.equal(next.wait, 0);
  assert.equal(next.lockEngaged, true, "the address is back at 29, so this is its thirtieth");
});

test("a refund does not lift a lock another attempt engaged", () => {
  const ip = "198.18.0.6";
  for (let i = 0; i < 3; i++) beginLoginAttempt("dee", ip);
  const fourth = beginLoginAttempt("dee", ip);
  const fifth = beginLoginAttempt("dee", ip);
  assert.equal(fifth.lockEngaged, true);
  refundLoginAttempt(fourth, false);
  assert.ok(loginRetryAfter("dee", ip) > 0, "the fifth's lock holds");
});

test("a refund after the window rolled over leaves the new window alone", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const ip = "198.18.0.7";
  const old = beginLoginAttempt("eve", ip);
  t.mock.timers.tick(16 * 60 * 1000);
  for (let i = 0; i < 4; i++) beginLoginAttempt("eve", ip);
  refundLoginAttempt(old, false);
  assert.equal(beginLoginAttempt("eve", ip).lockEngaged, true, "four in the new window, so this is the fifth");
});

test("the older helpers still count and read the same maps", () => {
  const ip = "198.18.0.8";
  for (let i = 0; i < 4; i++) assert.equal(recordPairFailure("fay", ip), false);
  assert.equal(recordPairFailure("fay", ip), true);
  assert.ok(pairRetryAfter("fay", ip) > 0);
  assert.ok(beginLoginAttempt("fay", ip).wait > 0, "a pair lock from the typed signature holds for sign-in");
  const ip2 = "198.18.0.9";
  for (let i = 0; i < 29; i++) recordLoginFailure(`gus-${i}`, ip2);
  assert.equal(beginLoginAttempt("gus", ip2).lockEngaged, true, "the thirtieth on the address");
});
