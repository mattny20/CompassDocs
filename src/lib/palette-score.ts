// Fuzzy matching for the command palette. Pure and dependency-free so it can
// be unit-tested and run on every keystroke without allocating much.
//
// Tiers, best first: exact → prefix → word-boundary → substring → subsequence.
// A match always returns the ranges it consumed so the row can highlight them.

export interface FuzzyMatch {
  score: number;
  ranges: [number, number][];
}

/** Anything below this is not worth showing. */
export const SCORE_FLOOR = 40;

function wordStarts(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (i === 0 || /[\s\-_/.]/.test(s[i - 1])) out.push(i);
  }
  return out;
}

/**
 * Score `query` against `target`. Returns null when there is no match at all.
 * Shorter targets win ties, so "Links" beats "Quick links launchpad" for "li".
 */
export function fuzzy(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 50, ranges: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!t) return null;

  const lengthBonus = Math.max(0, 20 - target.length / 4);

  if (t === q) return { score: 1000 + lengthBonus, ranges: [[0, target.length]] };

  if (t.startsWith(q)) return { score: 800 + lengthBonus, ranges: [[0, q.length]] };

  for (const start of wordStarts(t)) {
    if (start > 0 && t.startsWith(q, start)) {
      return { score: 650 + lengthBonus - start / 8, ranges: [[start, start + q.length]] };
    }
  }

  const at = t.indexOf(q);
  if (at >= 0) return { score: 500 + lengthBonus - at / 8, ranges: [[at, at + q.length]] };

  // Subsequence: every query char in order, rewarding adjacency and word starts.
  const starts = new Set(wordStarts(t));
  const ranges: [number, number][] = [];
  let ti = 0;
  let hits = 0;
  let streak = 0;
  let bonus = 0;
  for (const ch of q) {
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found < 0) return null;
    if (starts.has(found)) bonus += 12;
    if (ranges.length && ranges[ranges.length - 1][1] === found) {
      ranges[ranges.length - 1][1] = found + 1;
      streak++;
      bonus += Math.min(streak * 3, 15);
    } else {
      ranges.push([found, found + 1]);
      streak = 0;
    }
    hits++;
    ti++;
  }
  const density = hits / Math.max(1, t.length);
  return { score: 200 + bonus + density * 40 + lengthBonus, ranges };
}

export interface WeightedField {
  text: string;
  weight: number;
  /** Only the primary field's ranges are used for highlighting. */
  primary?: boolean;
}

/**
 * Best score across several fields (label, keywords, subtitle…). Ranges come
 * from the primary field only — highlighting a keyword the user can't see
 * would be confusing.
 */
export function bestScore(query: string, fields: WeightedField[]): FuzzyMatch | null {
  let best: FuzzyMatch | null = null;
  let primaryRanges: [number, number][] = [];
  for (const f of fields) {
    const m = fuzzy(query, f.text);
    if (!m) continue;
    const scaled = m.score * f.weight;
    if (f.primary) primaryRanges = m.ranges;
    if (!best || scaled > best.score) best = { score: scaled, ranges: m.ranges };
  }
  if (!best) return null;
  return { score: best.score, ranges: primaryRanges.length ? primaryRanges : best.ranges };
}
