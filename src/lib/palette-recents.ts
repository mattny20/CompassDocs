// "Frecency" for palette results: things you pick often, and recently, float
// up. Stored per user so a shared browser can't bleed one person's history
// into the next session. Client-only — every call no-ops without localStorage.

const KEY_PREFIX = "compass_palette_recent_v1:";
const MAX_ENTRIES = 60;
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

interface Entry {
  id: string;
  hits: number;
  last: number;
}

function storageKey(userId: number): string {
  return `${KEY_PREFIX}${userId}`;
}

function read(userId: number): Entry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Entry[]) : [];
  } catch {
    return [];
  }
}

function write(userId: number, entries: Entry[]): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Private mode or a full quota — recents are a nicety, never a failure.
  }
}

export function recordPick(userId: number, id: string, now = Date.now()): void {
  if (typeof window === "undefined") return;
  const entries = read(userId);
  const found = entries.find((e) => e.id === id);
  if (found) {
    found.hits += 1;
    found.last = now;
  } else {
    entries.push({ id, hits: 1, last: now });
  }
  entries.sort((a, b) => b.last - a.last);
  write(userId, entries);
}

/**
 * A small additive bonus, decaying with age — enough to break ties between
 * similar matches without letting history outrank a better text match.
 */
export function frecencyScores(userId: number, now = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of read(userId)) {
    const age = Math.max(0, now - e.last);
    const decay = Math.pow(0.5, age / HALF_LIFE_MS);
    out.set(e.id, Math.min(80, e.hits * 12 * decay));
  }
  return out;
}
