import "server-only";

// In-memory login throttling. Counters are per-process (a single container in
// every supported deployment) and reset on restart — the goal is to make online
// password guessing impractically slow, not to be a distributed ban list.
//
// Policy:
//  - 5 failures for the same username+IP within the window → that pair is
//    locked for 15 minutes. The sign-in route passes the identifier as
//    typed, an email included (1.16.0), never the account it resolves to,
//    so a lock says nothing about which account an email belongs to.
//  - 30 failures from one IP across any usernames → the IP is locked for
//    15 minutes (catches sprays across many accounts).
//  - Any successful login clears the username+IP pair.
//  - The sign-in route counts an attempt as it starts (beginLoginAttempt),
//    in the same synchronous step as the check, and gives it back when it
//    did not fail (refundLoginAttempt): a burst sent at once can't all pass
//    the check before the first failure is counted.
//  - The typed signature (lib/attestation, 1.12.0) and the password change
//    (/api/auth/change-password) count against the username+IP pair only
//    (recordPairFailure / pairRetryAfter below), with no await between the
//    check and the count: a signed-in session has a fixed username, so the
//    pair already bounds the oracle to 5 guesses per address, and a
//    workforce signing a policy behind one NAT must not trip the spray
//    counter and lock sign-in for the whole office. A pair lock engaged
//    there holds for the sign-in form too when the username is typed (an
//    email is its own key); beginLoginAttempt and loginRetryAfter read the
//    same map.

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const PAIR_LIMIT = 5;
const IP_LIMIT = 30;
const MAX_ENTRIES = 50_000; // hard cap so a spray can't balloon memory

type Entry = { fails: number; first: number; lockedUntil: number };
const pairs = new Map<string, Entry>();
const ips = new Map<string, Entry>();

function bump(map: Map<string, Entry>, key: string, limit: number, now: number): boolean {
  let e = map.get(key);
  if (!e || now - e.first > WINDOW_MS) {
    e = { fails: 0, first: now, lockedUntil: 0 };
    if (map.size >= MAX_ENTRIES) sweep(now);
    map.set(key, e);
  }
  e.fails++;
  if (e.fails >= limit && e.lockedUntil <= now) {
    e.lockedUntil = now + LOCK_MS;
    return true; // lock just engaged
  }
  return false;
}

function lockedFor(map: Map<string, Entry>, key: string, now: number): number {
  const e = map.get(key);
  if (!e || e.lockedUntil <= now) return 0;
  return Math.ceil((e.lockedUntil - now) / 1000);
}

function sweep(now: number): void {
  for (const map of [pairs, ips]) {
    for (const [k, e] of map) {
      if (now - e.first > WINDOW_MS && e.lockedUntil <= now) map.delete(k);
    }
  }
}

function pairKey(username: string, ip: string): string {
  return `${username.toLowerCase().trim()}|${ip}`;
}

/** One counted attempt in one map: the entry it went into, and whether it engaged that entry's lock. */
type Slot = { key: string; entry: Entry; engaged: boolean };

/**
 * A sign-in attempt counted before its outcome is known. `wait` > 0: refused
 * and not counted. `lockEngaged`: counting it engaged the pair or IP lock, to
 * be audited once if the attempt fails.
 */
export type LoginAttempt = { wait: number; lockEngaged: boolean; pair?: Slot; ip?: Slot };

function reserve(map: Map<string, Entry>, key: string, limit: number, now: number): Slot {
  const engaged = bump(map, key, limit, now);
  return { key, entry: map.get(key)!, engaged };
}

function release(map: Map<string, Entry>, slot: Slot): void {
  if (map.get(slot.key) !== slot.entry) return; // cleared, swept or a new window since
  slot.entry.fails = Math.max(0, slot.entry.fails - 1);
  if (slot.engaged) slot.entry.lockedUntil = 0;
}

/**
 * Check and count a sign-in attempt in one step: the caller must not await
 * between the two, or a burst sent at once all passes the check. A failed
 * attempt keeps its count; one that did not fail goes to refundLoginAttempt.
 */
export function beginLoginAttempt(username: string, ip: string): LoginAttempt {
  const now = Date.now();
  const key = pairKey(username, ip);
  const wait = Math.max(lockedFor(pairs, key, now), lockedFor(ips, ip, now));
  if (wait > 0) return { wait, lockEngaged: false };
  const pair = reserve(pairs, key, PAIR_LIMIT, now);
  const addr = reserve(ips, ip, IP_LIMIT, now);
  return { wait: 0, lockEngaged: pair.engaged || addr.engaged, pair, ip: addr };
}

/**
 * Give back an attempt that did not fail: signed in (which also clears the
 * pair, as recordLoginSuccess does), or the right password with the code
 * still to come. A lock that counting it engaged is lifted. Once only.
 */
export function refundLoginAttempt(attempt: LoginAttempt, signedIn: boolean): void {
  const { pair, ip } = attempt;
  attempt.pair = attempt.ip = undefined;
  if (pair) {
    if (signedIn) pairs.delete(pair.key);
    else release(pairs, pair);
  }
  if (ip) release(ips, ip);
}

/** Seconds the caller must wait before another attempt, or 0 if allowed. */
export function loginRetryAfter(username: string, ip: string): number {
  const now = Date.now();
  return Math.max(lockedFor(pairs, pairKey(username, ip), now), lockedFor(ips, ip, now));
}

/** Record a failed attempt. Returns true if this failure engaged a new lock
 * (callers audit that moment once). */
export function recordLoginFailure(username: string, ip: string): boolean {
  const now = Date.now();
  const pairLocked = bump(pairs, pairKey(username, ip), PAIR_LIMIT, now);
  const ipLocked = bump(ips, ip, IP_LIMIT, now);
  return pairLocked || ipLocked;
}

export function recordLoginSuccess(username: string, ip: string): void {
  pairs.delete(pairKey(username, ip));
}

/** Seconds the username+IP pair is locked for, or 0 if allowed; the IP spray lock is not consulted. */
export function pairRetryAfter(username: string, ip: string): number {
  return lockedFor(pairs, pairKey(username, ip), Date.now());
}

/** Record a failed attempt against the username+IP pair only. Returns true if this failure engaged the pair's lock. */
export function recordPairFailure(username: string, ip: string): boolean {
  return bump(pairs, pairKey(username, ip), PAIR_LIMIT, Date.now());
}
