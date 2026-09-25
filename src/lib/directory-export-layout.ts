// Page geometry for the two-column PDF layout.
//
// react-pdf flows one column of content down a page and has no notion of
// "then continue in the right half". So the two-column layout is planned
// here, before rendering: the table becomes a list of lines (section headers
// and rows), the paper and density say how many lines a column holds, and
// the lines are dealt into columns and pages. Rows are single-line in this
// layout (long values are cut with an ellipsis), which is what makes the
// count predictable — a row is exactly one line tall.
//
// Pure module, unit-tested; the renderer only turns the plan into pages.

export type ExportLine<R> = { kind: "section"; label: string; count: number } | { kind: "row"; row: R };

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
}): Geometry {
  const [w, h] = PAPER_POINTS[input.paper];
  const pageHeight = input.orientation === "landscape" ? w : h;
  const paddingTop = 34;
  const paddingBottom = 44;
  const lineHeight = input.font * 1.2;
  // The document header: title line, optional subtitle, and its margin.
  const docHeader = (input.font + 6) * 1.2 + (input.hasSubtitle ? lineHeight + 1 : 0) + 8;
  // Each column carries its own column-heading row.
  const thead = input.head * 1.2 + input.pad + 1.2 + 1;
  const rowHeight = Math.max(lineHeight, input.photo || 0) + input.pad * 2 + 0.5;
  const sectionHeight = lineHeight + input.pad * 2 + 6;
  const safety = 10;
  const usable = pageHeight - paddingTop - paddingBottom - docHeader - thead - safety;
  return {
    slotsPerColumn: Math.max(1, Math.floor(usable / rowHeight)),
    sectionSlots: Math.max(1, Math.ceil(sectionHeight / rowHeight)),
  };
}

/**
 * Deal lines into columns of `slotsPerColumn`, two columns to a page. A
 * section header that would not leave room for at least one row beneath it
 * moves to the next column with its rows.
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
    const cost = line.kind === "section" ? geometry.sectionSlots : 1;
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
