import "server-only";

// In-memory login throttling. Counters are per-process (a single container in
// every supported deployment) and reset on restart — the goal is to make online
// password guessing impractically slow, not to be a distributed ban list.
//
// Policy:
//  - 5 failures for the same username+IP within the window → that pair is
//    locked for 15 minutes.
//  - 30 failures from one IP across any usernames → the IP is locked for
//    15 minutes (catches sprays across many accounts).
//  - Any successful login clears the username+IP pair.

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
