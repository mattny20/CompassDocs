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

function splitLines(s: string): string[] {
  // Normalize CRLF so an editor round-trip doesn't show phantom changes.
  return s.replace(/\r\n/g, "\n").split("\n");
}

/** Indexes of an LCS between a and b (classic DP, returns pairs [i, j]). */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
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
  if (a.length * b.length > 40_000) return [{ text: line, changed: true }];
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
