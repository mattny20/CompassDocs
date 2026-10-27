// The last email or username used to sign in on this browser (1.16.0),
// offered back on the next visit: prefilled into an empty field, never
// submitted, with "Not you? Use another account" to forget it. Kept in
// localStorage only (never a cookie, never sent), for 180 days. Every
// access is guarded: storage can be blocked or full. Client-safe.

const KEY = "compass-sign-in-identifier";
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
// A clock a little ahead when it was written is tolerated; a future-dated entry would never expire.
const SKEW_MS = 24 * 60 * 60 * 1000;

function valid(id: unknown): id is string {
  // eslint-disable-next-line no-control-regex
  return typeof id === "string" && id.length > 0 && id.length <= 254 && !/[\u0000-\u001f\u007f]/.test(id);
}

export function readRememberedIdentifier(now = Date.now()): string | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { id?: unknown; at?: unknown };
    const at = v?.at;
    if (!valid(v?.id) || typeof at !== "number" || !Number.isFinite(at) || now - at > MAX_AGE_MS || at - now > SKEW_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return v.id;
  } catch {
    return null;
  }
}

export function rememberIdentifier(id: string, now = Date.now()): void {
  if (!valid(id)) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ id, at: now }));
  } catch {
    // storage blocked or full: nothing to remember
  }
}

export function forgetIdentifier(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // nothing to forget
  }
}
