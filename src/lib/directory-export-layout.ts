// Page geometry for the PDF export: margins, column widths, and the
// two-column plan.
//
// react-pdf flows one column of content down a page and has no notion of
// "then continue in the right half". So the two-column layout is planned
// here, before rendering: the table becomes a list of lines (section headers
// and rows), the paper, margins and density say how many lines a column
// holds, and the lines are dealt into columns and pages. A row is one line
// tall (long values are cut with an ellipsis) unless a column has a character
// limit, in which case the row's cost is the number of lines the limited
// value wraps onto, counted here the same way for every run, which is what
// keeps the plan predictable.
//
// Pure module, unit-tested; the renderer only turns the plan into pages.

export type ExportLine<R> =
  | { kind: "section"; label: string; count: number }
  | {
      kind: "row";
      row: R;
      /** Lines the row takes when a limited column wraps; absent or 1 is a single-line row. */
      lines?: number;
    };

export interface ColumnPlan<R> {
  lines: ExportLine<R>[];
}

export interface PagePlan<R> {
  columns: ColumnPlan<R>[];
}

/** Points per paper, portrait: [width, height]. */
export const PAPER_POINTS: Record<"letter" | "a4" | "legal", [number, number]> = {
  letter: [612, 792],
  a4: [595.28, 841.89],
  legal: [612, 1008],
};

// --- Margins -------------------------------------------------------------------

export interface MarginBox {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const MARGIN_PRESETS = ["normal", "narrow", "wide", "custom"] as const;

export type MarginPreset = (typeof MARGIN_PRESETS)[number];

export const POINTS_PER_INCH = 72;

/** Inches a custom margin may take, per side. */
export const MARGIN_INCHES = { min: 0.2, max: 2 } as const;

/**
 * The fixed presets, in points. "normal" is the page every export had before
 * margins were a setting (34 / 36 / 44 / 36), so a preset stored without one
 * renders exactly as it did; "narrow" is 0.3in all round, "wide" 1in.
 */
export const MARGIN_POINTS: Record<Exclude<MarginPreset, "custom">, MarginBox> = {
  normal: { top: 34, right: 36, bottom: 44, left: 36 },
  narrow: { top: 21.6, right: 21.6, bottom: 21.6, left: 21.6 },
  wide: { top: 72, right: 72, bottom: 72, left: 72 },
};

/** A preset's margins in points; a custom one converts inches at 72 to the inch. */
export function marginPoints(margins: MarginPreset, custom: MarginBox): MarginBox {
  if (margins !== "custom") return { ...MARGIN_POINTS[margins] };
  const pt = (inches: number) => Math.round(inches * POINTS_PER_INCH * 100) / 100;
  return { top: pt(custom.top), right: pt(custom.right), bottom: pt(custom.bottom), left: pt(custom.left) };
}

// --- Column limits -------------------------------------------------------------

/** Characters per line a column limit may take. */
export const COLUMN_LIMIT = { min: 8, max: 120 } as const;

/** Average Helvetica glyph width as a fraction of the font size. */
const GLYPH_EM = 0.52;

/** Points a column limited to `limit` characters takes at `font` points: the glyphs plus the cell's padding. */
export function limitedWidth(limit: number, font: number): number {
  return Math.round((limit * GLYPH_EM * font + 5) * 100) / 100;
}

/**
 * Lines a value takes when wrapped after `limit` characters: the larger of
 * ceil(length / limit) and a greedy word wrap at the limit (a word longer
 * than a line breaking mid-word). The ceiling is the floor every plan keeps;
 * the word wrap adds the line a word that does not fit the remainder costs,
 * which is how the renderer breaks lines. A plan that counts one line too
 * many leaves white space; one that counts too few overflows the page.
 */
export function wrappedLineCount(text: string, limit: number): number {
  const s = String(text ?? "").trim();
  if (!s || !(limit >= 1)) return 1;
  let lines = 1;
  let used = 0;
  for (const word of s.split(/\s+/)) {
    let w = word.length;
    if (used > 0 && used + 1 + w <= limit) {
      used += 1 + w;
      continue;
    }
    if (used > 0) {
      lines++;
      used = 0;
    }
    while (w > limit) {
      lines++;
      w -= limit;
    }
    used = w;
  }
  return Math.max(lines, Math.ceil(s.length / limit));
}

export interface WidthInput {
  key: string;
  /** Relative width among the automatic columns. */
  weight: number;
  /** Characters per line; 0 is automatic. */
  limit: number;
}

export interface ColumnWidth {
  key: string;
  /** Points, when the column is limited; null when it shares the rest by weight. */
  fixed: number | null;
  weight: number;
}

/**
 * Widths for a row `rowWidth` points across: a limited column takes
 * limitedWidth(limit, font); the others share what is left by weight, as
 * they always have. When the fixed columns alone would leave the automatic
 * columns less than a third of the row, or overflow the row when every
 * column is limited, they are scaled down together so the table still fits
 * the page.
 */
export function columnWidths(columns: WidthInput[], font: number, rowWidth: number): ColumnWidth[] {
  const fixed = columns.map((c) => (c.limit > 0 ? limitedWidth(c.limit, font) : null));
  const fixedTotal = fixed.reduce<number>((s, w) => s + (w ?? 0), 0);
  const automatic = fixed.filter((w) => w === null).length;
  const cap = automatic > 0 ? rowWidth * (2 / 3) : rowWidth;
  const scale = rowWidth > 0 && fixedTotal > cap ? cap / fixedTotal : 1;
  return columns.map((c, i) => {
    const w = fixed[i];
    return { key: c.key, fixed: w === null ? null : Math.round(w * scale * 100) / 100, weight: c.weight };
  });
}

/**
 * The width one table of the page can use: the paper minus the side margins,
 * split `pageColumns` ways with `gap` points between, minus the photo column.
 */
export function rowWidth(input: {
  paper: "letter" | "a4" | "legal";
  orientation: "portrait" | "landscape";
  margins: MarginBox;
  pageColumns: number;
  gap: number;
  photo: number;
}): number {
  const [w, h] = PAPER_POINTS[input.paper];
  const pageWidth = input.orientation === "landscape" ? h : w;
  const inner = pageWidth - input.margins.left - input.margins.right;
  const cols = Math.max(1, input.pageColumns);
  return (inner - input.gap * (cols - 1)) / cols - input.photo;
}

// --- The two-column plan -------------------------------------------------------

export interface Geometry {
  /** Lines a column holds, after the column's own header row. */
  slotsPerColumn: number;
  /** How many row-slots a section header takes (it is taller than a row and
   *  needs a row after it, so it never sits alone at the foot of a column). */
  sectionSlots: number;
}

/**
 * How many rows fit in one column of a page. Conservative on purpose: a
 * plan that leaves a little white space at the foot of a column is fine; one
 * that overflows pushes the whole page onto another sheet.
 */
export function columnGeometry(input: {
  paper: "letter" | "a4" | "legal";
  orientation: "portrait" | "landscape";
  font: number;
  pad: number;
  head: number;
  photo: number;
  hasSubtitle: boolean;
  /** Page margins in points; the "normal" preset when absent. */
  margins?: MarginBox;
}): Geometry {
  const [w, h] = PAPER_POINTS[input.paper];
  const pageHeight = input.orientation === "landscape" ? w : h;
  const margins = input.margins ?? MARGIN_POINTS.normal;
  const lineHeight = input.font * 1.2;
  // The document header: title line, optional subtitle, and its margin.
  const docHeader = (input.font + 6) * 1.2 + (input.hasSubtitle ? lineHeight + 1 : 0) + 8;
  // Each column carries its own column-heading row.
  const thead = input.head * 1.2 + input.pad + 1.2 + 1;
  const rowHeight = Math.max(lineHeight, input.photo || 0) + input.pad * 2 + 0.5;
  const sectionHeight = lineHeight + input.pad * 2 + 6;
  const safety = 10;
  const usable = pageHeight - margins.top - margins.bottom - docHeader - thead - safety;
  return {
    slotsPerColumn: Math.max(1, Math.floor(usable / rowHeight)),
    sectionSlots: Math.max(1, Math.ceil(sectionHeight / rowHeight)),
  };
}

/**
 * Deal lines into columns of `slotsPerColumn`, two columns to a page. A
 * section header that would not leave room for at least one row beneath it
 * moves to the next column with its rows. A row that wraps costs the lines it
 * takes.
 */
export function planPages<R>(lines: ExportLine<R>[], geometry: Geometry, columnsPerPage = 2): PagePlan<R>[] {
  const columns: ColumnPlan<R>[] = [];
  let current: ExportLine<R>[] = [];
  let used = 0;
  const flush = () => {
    if (current.length) columns.push({ lines: current });
    current = [];
    used = 0;
  };
  for (const line of lines) {
    const cost = line.kind === "section" ? geometry.sectionSlots : Math.max(1, Math.ceil(line.lines ?? 1));
    const needs = line.kind === "section" ? cost + 1 : cost;
    if (used > 0 && used + needs > geometry.slotsPerColumn) flush();
    current.push(line);
    used += cost;
  }
  flush();
  const pages: PagePlan<R>[] = [];
  for (let i = 0; i < columns.length; i += columnsPerPage) {
    pages.push({ columns: columns.slice(i, i + columnsPerPage) });
  }
  return pages.length ? pages : [{ columns: [{ lines: [] }] }];
}
