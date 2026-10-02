// The single-key shortcuts preference (WCAG 2.1.4): bare keys that fire
// anywhere outside a text field can be switched off under Account →
// Preferences. The account value is the source of truth; localStorage
// mirrors it so a change applies in every open tab at once, and the
// palette listens for the event so the current tab needs no reload.
// Ctrl/⌘+K is never affected.

const KEY = "compass-single-key";
export const SINGLE_KEY_EVENT = "cdc:single-key";

export function storeSingleKey(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

/** The stored value, or `fallback` (the account value) when nothing is stored. */
export function readSingleKey(fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
