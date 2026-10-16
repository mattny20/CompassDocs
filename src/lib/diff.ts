// Dependency-free text diff for the version-history compare view.
//
// Line-level diff via longest-common-subsequence, with common prefix/suffix
// trimming so the DP table only covers the changed middle. Paired del/add
// lines additionally get a word-level diff so the UI can highlight what
// changed inside a line. Pure TypeScript, safe to import from client
// components (the compare UI diffs in the browser).

export type DiffSegment = { text: string; changed: boolean };

export type DiffRow = {
  type: "same" | "del" | "add";
  /** 1-based line number in the old (left) / new (right) text. */
  leftNo?: number;
  rightNo?: number;
  text: string;
  /** Word-level segments (only set on paired del/add rows). */
  segments?: DiffSegment[];
};

/** Guard: beyond this many changed lines per side, skip the O(n*m) LCS and
 * mark the whole middle as replaced. Keeps worst-case work bounded. */
const MAX_LCS_LINES = 3000;

/** Guard: beyond this many word pairs (a.length * b.length) a word-level
 * comparison marks the whole span as changed instead of running the LCS. */
const MAX_WORD_PAIRS = 40_000;

function splitLines(s: string): string[] {
  // Normalize CRLF so an editor round-trip doesn't show phantom changes.
  return s.replace(/\r\n/g, "\n").split("\n");
}

/** Indexes of an LCS between a and b (classic DP, returns pairs [i, j]). */
function lcsPairs<T>(a: T[], b: T[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  // Single-row DP would lose the traceback; docs are small enough post-trim.
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      dp[i][j] = ai === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return pairs.reverse();
}

/** Tokenize a line into words + separators (separators kept so the
 * highlighted output reassembles to the exact original text). */
function words(s: string): string[] {
  return s.match(/\S+|\s+/g) ?? [];
}

/** Word-level segments for a changed line pair: which parts of `line` differ
 * from `other`. Marks tokens not present in the LCS as changed. */
function wordSegments(line: string, other: string): DiffSegment[] {
  const a = words(line);
  const b = words(other);
  if (a.length * b.length > MAX_WORD_PAIRS) return [{ text: line, changed: true }];
  const keep = new Set(lcsPairs(a, b).map(([i]) => i));
  const segs: DiffSegment[] = [];
  a.forEach((tok, i) => {
    const changed = !keep.has(i) && tok.trim() !== "";
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += tok;
    else segs.push({ text: tok, changed });
  });
  return segs;
}

/**
 * Diff two documents line-by-line. Returns rows in display order: unchanged
 * lines as "same" (with both line numbers), removals then additions for each
 * changed region. Consecutive one-for-one del/add pairs carry word-level
 * segments for intra-line highlighting.
 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // Trim common prefix/suffix — typical edits touch a small middle region.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i++) {
    rows.push({ type: "same", leftNo: i + 1, rightNo: i + 1, text: a[i] });
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const big = midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES;
  const anchors = big ? [] : lcsPairs(midA, midB);

  let ai = 0;
  let bi = 0;
  const emitRegion = (aStop: number, bStop: number) => {
    const dels: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (ai < aStop) {
      dels.push({ type: "del", leftNo: start + ai + 1, text: midA[ai] });
      ai++;
    }
    while (bi < bStop) {
      adds.push({ type: "add", rightNo: start + bi + 1, text: midB[bi] });
      bi++;
    }
    // Pair up del/add lines positionally for word-level highlights.
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      dels[k].segments = wordSegments(dels[k].text, adds[k].text);
      adds[k].segments = wordSegments(adds[k].text, dels[k].text);
    }
    rows.push(...dels, ...adds);
  };

  for (const [pa, pb] of anchors) {
    emitRegion(pa, pb);
    rows.push({ type: "same", leftNo: start + pa + 1, rightNo: start + pb + 1, text: midA[pa] });
    ai = pa + 1;
    bi = pb + 1;
  }
  emitRegion(midA.length, midB.length);

  for (let i = 0; i < a.length - endA; i++) {
    rows.push({
      type: "same",
      leftNo: endA + i + 1,
      rightNo: endB + i + 1,
      text: a[endA + i],
    });
  }
  return rows;
}

export type DiffStats = { added: number; removed: number };

export function diffStats(rows: DiffRow[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === "add") added++;
    else if (r.type === "del") removed++;
  }
  return { added, removed };
}

/** Collapse long unchanged runs for display: keep `context` lines around each
 * change and replace the rest with fold markers. */
export type DisplayRow = DiffRow | { type: "fold"; hidden: number };

export function withFolds(rows: DiffRow[], context = 3): DisplayRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type !== "same") {
      for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) {
        keep[k] = true;
      }
    }
  });
  const out: DisplayRow[] = [];
  let hidden = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (hidden > 0) {
        out.push({ type: "fold", hidden });
        hidden = 0;
      }
      out.push(r);
    } else hidden++;
  });
  if (hidden > 0) out.push({ type: "fold", hidden });
  return out;
}

// --- Block-level diff (rendered compare view) --------------------------------

export type BlockDiffRow = { type: "same" | "del" | "add"; text: string };

/** Split markdown into display blocks on blank lines, keeping fenced code
 * (``` / ~~~) and ::: directive containers whole so each block renders
 * standalone. */
export function splitBlocks(s: string): string[] {
  const lines = s.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  let directiveDepth = 0;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) blocks.push(text);
    buf = [];
  };
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      buf.push(line);
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch && directiveDepth === 0) {
      buf.push(line);
      fence = fenceMatch[1];
      continue;
    }
    if (/^:{3,}\s*\S/.test(line)) {
      directiveDepth++;
      buf.push(line);
      continue;
    }
    if (/^:{3,}\s*$/.test(line) && directiveDepth > 0) {
      directiveDepth--;
      buf.push(line);
      continue;
    }
    if (line.trim() === "" && directiveDepth === 0) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

/** Block-level LCS diff for the rendered compare view. Same trimming +
 * size-guard approach as diffLines, over blocks instead of lines. */
export function diffBlocks(oldText: string, newText: string): BlockDiffRow[] {
  const a = splitBlocks(oldText);
  const b = splitBlocks(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const rows: BlockDiffRow[] = [];
  for (let i = 0; i < start; i++) rows.push({ type: "same", text: a[i] });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) {
    for (const t of midA) rows.push({ type: "del", text: t });
    for (const t of midB) rows.push({ type: "add", text: t });
  } else {
    const pairs = lcsPairs(midA, midB);
    let i = 0;
    let j = 0;
    for (const [pi, pj] of [...pairs, [midA.length, midB.length] as [number, number]]) {
      while (i < pi) rows.push({ type: "del", text: midA[i++] });
      while (j < pj) rows.push({ type: "add", text: midB[j++] });
      if (pi < midA.length) {
        rows.push({ type: "same", text: midA[pi] });
        i = pi + 1;
        j = pj + 1;
      }
    }
  }
  for (let i = endA; i < a.length; i++) rows.push({ type: "same", text: a[i] });
  return rows;
}

// --- Change summary for re-confirmation decisions ---------------------------
//
// When a confirmed document is edited, the editor's "editorial fix or
// material change?" question and the server's write paths need the same
// cheap answer to "how big is this change, and does it look like a change in
// meaning?". changeSummary measures the edit at word level and reads a few
// markdown signals (headings, list items, numbers); suggestReconfirm turns
// that into a default; describeChange turns it into the one sentence the UI
// shows. All pure and bounded by the same guards as the diffs above; when a
// guard trips the summary is marked degraded and reads as a material change.

export type ChangeSummary = {
  /** Whitespace-separated tokens in the old and new text. */
  wordsOld: number;
  wordsNew: number;
  /** Words a reader would see as changed: per changed region, the larger of
   * words removed and words added (so a replaced word counts once). */
  wordsChanged: number;
  /** wordsChanged as a share of the longer text, one decimal place; 100 when
   * degraded. */
  pct: number;
  /** Blank-line separated paragraphs whose words changed (a reflow that keeps
   * every word in place does not count). */
  blocksChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** Markdown headings (# lines) added, removed or reworded. */
  headingsChanged: number;
  /** List items (-, *, + or 1. lines) added, removed or reworded; renumbering
   * alone does not count. */
  listItemsChanged: number;
  /** Numbers (7.5, 20%, £75, 1,000) added, removed or altered. List numbering
   * and link targets are ignored. */
  numbersChanged: number;
  /** From the optional titles passed to changeSummary; false when absent. */
  titleChanged: boolean;
  /** Text of the heading above (or inside) the first changed paragraph. */
  firstChangedHeading: string | null;
  /** A size guard tripped: the counts are a floor, pct is 100 and the change
   * must be treated as material. */
  degraded: boolean;
};

export type ChangeSummaryOptions = { oldTitle?: string | null; newTitle?: string | null };

export type ReconfirmSuggestion = {
  policy: "keep" | "reset";
  confidence: "high" | "low";
  /** Plain-language fragment for logs and the decision row, e.g. "a number changed". */
  reason: string;
};

/** Below this share of words changed (with at most KEEP_MAX_BLOCKS paragraphs
 * touched and no structural flags) an edit looks editorial. */
export const KEEP_MAX_PCT = 2;
/** At or above this share of words changed an edit looks material. */
export const RESET_MIN_PCT = 5;
/** An editorial-looking edit touches at most this many paragraphs. */
export const KEEP_MAX_BLOCKS = 2;
/** Touching this many paragraphs or more looks material whatever the share. */
export const RESET_MIN_BLOCKS = 3;

const HEADING_RE = /^ {0,3}#{1,6}\s+(\S.*?)\s*(?:#+\s*)?$/;
const LIST_ITEM_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/;
const ORDERED_MARKER_RE = /^\s{0,3}\d+[.)](?=\s)/;
const NUMBER_RE = /[£$€]?\d+(?:[.,]\d+)*%?/g;
const URL_RE = /\(https?:\/\/[^)]*\)|https?:\/\/\S+/g;
const MAX_HEADING_LABEL = 60;

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** Words for counting: tokens with at least a letter or digit, so bullet
 * markers and bare punctuation are not "words". */
function wordsOf(s: string): string[] {
  return (s.match(/\S+/g) ?? []).filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/** Shared prefix/suffix of two sequences: [start, endA, endB] bound the
 * differing middle. */
function trimCommon<T>(a: T[], b: T[]): [number, number, number] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [start, endA, endB];
}

/** Length of an LCS (two-row DP; no traceback, so memory is O(m)). */
function lcsLength<T>(a: T[], b: T[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

type SeqDelta = { removed: number; added: number; degraded: boolean };

/** How many items of a were removed and of b added, after trimming the
 * shared ends. `tooBig` is the size guard on the differing middle; when it
 * trips the whole middle counts as changed and the result is degraded. */
function seqDelta<T>(a: T[], b: T[], tooBig: (n: number, m: number) => boolean): SeqDelta {
  const [start, endA, endB] = trimCommon(a, b);
  const n = endA - start;
  const m = endB - start;
  if (tooBig(n, m)) return { removed: n, added: m, degraded: true };
  const l = lcsLength(a.slice(start, endA), b.slice(start, endB));
  return { removed: n - l, added: m - l, degraded: false };
}

const tooManyLines = (n: number, m: number) => n > MAX_LCS_LINES || m > MAX_LCS_LINES;
const tooManyWordPairs = (n: number, m: number) => n * m > MAX_WORD_PAIRS;

/** A run of changed items between two unchanged anchors, with the unchanged
 * items that precede it (so a caller can find the heading above a change). */
type Region<T> = { sameBefore: T[]; del: T[]; add: T[] };

function changedRegions<T>(a: T[], b: T[]): { regions: Region<T>[]; degraded: boolean } {
  const [start, endA, endB] = trimCommon(a, b);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const regions: Region<T>[] = [];
  if (midA.length === 0 && midB.length === 0) return { regions, degraded: false };
  if (tooManyLines(midA.length, midB.length)) {
    return { regions: [{ sameBefore: a.slice(0, start), del: midA, add: midB }], degraded: true };
  }
  let i = 0;
  let j = 0;
  let same: T[] = a.slice(0, start);
  for (const [pi, pj] of [...lcsPairs(midA, midB), [midA.length, midB.length] as [number, number]]) {
    if (i < pi || j < pj) {
      regions.push({ sameBefore: same, del: midA.slice(i, pi), add: midB.slice(j, pj) });
      same = [];
    }
    if (pi < midA.length) same.push(midA[pi]);
    i = pi + 1;
    j = pj + 1;
  }
  return { regions, degraded: false };
}

/** Words changed across one region of paragraphs. Compared as a whole first
 * (so a split, merged or moved paragraph is not counted twice); when that
 * exceeds the pair guard, paragraphs are paired up positionally instead, and
 * only a pair that still exceeds it degrades the result. */
function regionWordsChanged(del: string[], add: string[]): { changed: number; degraded: boolean } {
  const whole = seqDelta(wordsOf(del.join("\n")), wordsOf(add.join("\n")), tooManyWordPairs);
  if (!whole.degraded) return { changed: Math.max(whole.removed, whole.added), degraded: false };
  if (del.length <= 1 && add.length <= 1) return { changed: Math.max(whole.removed, whole.added), degraded: true };
  let changed = 0;
  let degraded = false;
  for (let k = 0; k < Math.max(del.length, add.length); k++) {
    const pair = seqDelta(wordsOf(del[k] ?? ""), wordsOf(add[k] ?? ""), tooManyWordPairs);
    changed += Math.max(pair.removed, pair.added);
    degraded ||= pair.degraded;
  }
  return { changed, degraded };
}

/** Lines of a block outside fenced code (a `# comment` in code is not a
 * heading). */
function proseLines(block: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of block.split("\n")) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    out.push(line);
  }
  return out;
}

function headingText(line: string): string | null {
  const m = line.match(HEADING_RE);
  return m ? m[1] : null;
}

function numbersIn(line: string): string[] {
  const prose = line.replace(ORDERED_MARKER_RE, "").replace(URL_RE, "");
  return prose.match(NUMBER_RE) ?? [];
}

type Structure = { headings: string[]; items: string[]; numbers: string[] };

function structureOf(blocks: string[]): Structure {
  const s: Structure = { headings: [], items: [], numbers: [] };
  for (const block of blocks) {
    for (const line of proseLines(block)) {
      const trimmed = line.trim();
      if (headingText(line) !== null) s.headings.push(trimmed);
      else if (LIST_ITEM_RE.test(line)) s.items.push(trimmed.replace(/^\d+[.)]/, "1."));
      s.numbers.push(...numbersIn(line));
    }
  }
  return s;
}

/** Items that do not pair up between two multisets: the larger of "only in
 * a" and "only in b", so a reworded item counts once. */
function unpaired(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  let onlyB = 0;
  for (const y of b) {
    const c = counts.get(y) ?? 0;
    if (c > 0) counts.set(y, c - 1);
    else onlyB++;
  }
  let onlyA = 0;
  for (const c of counts.values()) onlyA += c;
  return Math.max(onlyA, onlyB);
}

function headingAbove(first: Region<string> | undefined): string | null {
  if (!first) return null;
  const own = first.add[0] ?? first.del[0];
  if (own) {
    for (const line of proseLines(own)) {
      const h = headingText(line);
      if (h !== null) return h;
    }
  }
  for (let i = first.sameBefore.length - 1; i >= 0; i--) {
    const lines = proseLines(first.sameBefore[i]);
    for (let k = lines.length - 1; k >= 0; k--) {
      const h = headingText(lines[k]);
      if (h !== null) return h;
    }
  }
  return null;
}

/** The same paragraphs with the same words in the same order: only spacing
 * or line breaks differ. */
function sameWords(del: string[], add: string[]): boolean {
  if (del.length !== add.length) return false;
  return del.every((d, i) => wordsOf(d).join(" ") === wordsOf(add[i]).join(" "));
}

/**
 * Measure an edit for the re-confirmation question. Pure and bounded: line
 * and paragraph diffs share the MAX_LCS_LINES guard with diffLines, word
 * comparisons the MAX_WORD_PAIRS guard; when one trips, `degraded` is set
 * and `pct` is 100 so the edit is treated as material. Line endings are
 * normalised first, so a CRLF round-trip measures as no change. Titles are
 * not part of the text; pass them in `opts` to set `titleChanged`.
 */
export function changeSummary(oldText: string, newText: string, opts: ChangeSummaryOptions = {}): ChangeSummary {
  const a = normalizeNewlines(oldText);
  const b = normalizeNewlines(newText);
  const wordsOld = wordsOf(a).length;
  const wordsNew = wordsOf(b).length;
  const titleChanged =
    opts.oldTitle != null && opts.newTitle != null && opts.oldTitle.trim() !== opts.newTitle.trim();
  const summary: ChangeSummary = {
    wordsOld,
    wordsNew,
    wordsChanged: 0,
    pct: 0,
    blocksChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    headingsChanged: 0,
    listItemsChanged: 0,
    numbersChanged: 0,
    titleChanged,
    firstChangedHeading: null,
    degraded: false,
  };
  if (a === b) return summary;

  const lines = seqDelta(splitLines(a), splitLines(b), tooManyLines);
  summary.linesAdded = lines.added;
  summary.linesRemoved = lines.removed;

  const blocks = changedRegions(splitBlocks(a), splitBlocks(b));
  // Once a guard has tripped the numbers are a floor anyway; skip the word LCS.
  let degraded = lines.degraded || blocks.degraded;
  const delBlocks: string[] = [];
  const addBlocks: string[] = [];
  for (const r of blocks.regions) {
    delBlocks.push(...r.del);
    addBlocks.push(...r.add);
    if (sameWords(r.del, r.add)) continue;
    summary.blocksChanged += Math.max(r.del.length, r.add.length);
    if (degraded) {
      summary.wordsChanged += Math.max(wordsOf(r.del.join("\n")).length, wordsOf(r.add.join("\n")).length);
      continue;
    }
    const w = regionWordsChanged(r.del, r.add);
    summary.wordsChanged += w.changed;
    degraded ||= w.degraded;
  }

  const before = structureOf(delBlocks);
  const after = structureOf(addBlocks);
  summary.headingsChanged = unpaired(before.headings, after.headings);
  summary.listItemsChanged = unpaired(before.items, after.items);
  summary.numbersChanged = unpaired(before.numbers, after.numbers);
  summary.firstChangedHeading = headingAbove(blocks.regions[0]);

  summary.degraded = degraded;
  if (degraded) summary.pct = 100;
  else {
    const denom = Math.max(wordsOld, wordsNew, 1);
    let pct = Math.min(100, Math.round((1000 * summary.wordsChanged) / denom) / 10);
    if (summary.wordsChanged > 0 && pct < 0.1) pct = 0.1;
    summary.pct = pct;
  }
  return summary;
}

function countPhrase(n: number, noun: string): string {
  return n === 1 ? `a ${noun}` : `${n} ${noun}s`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function paragraphsPhrase(n: number): string {
  return n === 1 ? "one paragraph" : `${n} paragraphs`;
}

/** "14 words in one paragraph" / "212 words across 4 paragraphs". */
function wordsPhrase(s: ChangeSummary): string {
  const words = `${s.wordsChanged} ${s.wordsChanged === 1 ? "word" : "words"}`;
  return s.blocksChanged === 1 ? `${words} in one paragraph` : `${words} across ${paragraphsPhrase(s.blocksChanged)}`;
}

/** The signals that make an edit material on their own: "the title", "a
 * heading", "2 numbers". */
function materialParts(s: ChangeSummary): string[] {
  const parts: string[] = [];
  if (s.titleChanged) parts.push("the title");
  if (s.headingsChanged > 0) parts.push(countPhrase(s.headingsChanged, "heading"));
  if (s.numbersChanged > 0) parts.push(countPhrase(s.numbersChanged, "number"));
  return parts;
}

/**
 * The default answer to "editorial fix or material change?". Reset when the
 * title, a heading or a number changed, the share of words changed reaches
 * RESET_MIN_PCT, or RESET_MIN_BLOCKS paragraphs changed; keep with high
 * confidence for a small edit (under KEEP_MAX_PCT, at most KEEP_MAX_BLOCKS
 * paragraphs, no structural signal); keep with low confidence otherwise.
 * Only keep/high is safe to act on without asking.
 */
export function suggestReconfirm(s: ChangeSummary): ReconfirmSuggestion {
  if (s.degraded) return { policy: "reset", confidence: "high", reason: "too much changed to measure" };
  const material = materialParts(s);
  if (material.length > 0) return { policy: "reset", confidence: "high", reason: `${joinList(material)} changed` };
  if (s.pct >= RESET_MIN_PCT) {
    return { policy: "reset", confidence: "high", reason: `${s.pct}% of the words changed` };
  }
  if (s.blocksChanged >= RESET_MIN_BLOCKS) {
    return { policy: "reset", confidence: "low", reason: `${s.blocksChanged} paragraphs changed` };
  }
  if (s.wordsChanged === 0 && s.blocksChanged === 0) {
    return {
      policy: "keep",
      confidence: "high",
      reason: s.linesAdded + s.linesRemoved > 0 ? "only spacing or line breaks changed" : "no change to the text",
    };
  }
  if (s.pct < KEEP_MAX_PCT && s.blocksChanged <= KEEP_MAX_BLOCKS && s.listItemsChanged === 0) {
    const what = s.wordsChanged === 0 ? `${paragraphsPhrase(s.blocksChanged)} rearranged` : wordsPhrase(s);
    return { policy: "keep", confidence: "high", reason: `${what} (${s.pct}%)` };
  }
  const why =
    s.listItemsChanged > 0
      ? `${countPhrase(s.listItemsChanged, "list item")} changed (${s.pct}%)`
      : `${s.pct}% changed across ${paragraphsPhrase(s.blocksChanged)}`;
  return { policy: "keep", confidence: "low", reason: why };
}

/**
 * One plain sentence for the UI, e.g. 'Looks editorial: 14 words in one
 * paragraph changed (1.1% since v12).', 'Looks material: a number changed in
 * "Section 4".', 'Borderline: 3.4% changed across 2 paragraphs since v12.
 * Choose Material change if an obligation changed.' `baselineLabel` names
 * the version the text is compared with ("v12"); omit it for a plain
 * percentage.
 */
export function describeChange(s: ChangeSummary, baselineLabel?: string): string {
  const since = baselineLabel ? ` since ${baselineLabel}` : "";
  const pctNote = `(${s.pct}%${since})`;
  const heading = s.firstChangedHeading
    ? s.firstChangedHeading.length > MAX_HEADING_LABEL
      ? `${s.firstChangedHeading.slice(0, MAX_HEADING_LABEL - 1).trimEnd()}…`
      : s.firstChangedHeading
    : null;
  const where = heading ? (s.headingsChanged > 0 ? ` ("${heading}")` : ` in "${heading}"`) : "";
  const { policy, confidence } = suggestReconfirm(s);

  if (s.degraded) {
    return baselineLabel
      ? `Looks material: too much changed since ${baselineLabel} to measure.`
      : "Looks material: too much changed to measure.";
  }
  if (policy === "reset") {
    const material = materialParts(s);
    if (material.length > 0) return `Looks material: ${joinList(material)} changed${where}.`;
    if (s.wordsChanged === 0) {
      return `Looks material: ${paragraphsPhrase(s.blocksChanged)} rearranged, no words changed ${pctNote}.`;
    }
    return `Looks material: ${wordsPhrase(s)} changed ${pctNote}.`;
  }
  if (s.wordsChanged === 0 && s.blocksChanged === 0) {
    return s.linesAdded + s.linesRemoved > 0 ? "Looks editorial: only spacing or line breaks changed." : "No change to the text.";
  }
  if (confidence === "high") {
    if (s.wordsChanged === 0) {
      return `Looks editorial: ${paragraphsPhrase(s.blocksChanged)} rearranged, no words changed ${pctNote}.`;
    }
    return `Looks editorial: ${wordsPhrase(s)} changed ${pctNote}.`;
  }
  const body =
    s.listItemsChanged > 0
      ? `${countPhrase(s.listItemsChanged, "list item")} changed${where} ${pctNote}`
      : `${s.pct}% changed ${s.blocksChanged === 1 ? "in one paragraph" : `across ${paragraphsPhrase(s.blocksChanged)}`}${since}`;
  return `Borderline: ${body}. Choose Material change if an obligation changed.`;
}
