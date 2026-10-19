// The PDF page geometry (margins, column widths, wrapped rows), the
// two-column plan and the chained sort — pure rules.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MARGIN_POINTS,
  columnGeometry,
  columnWidths,
  limitedWidth,
  marginPoints,
  planPages,
  rowWidth,
  wrappedLineCount,
  type ExportLine,
} from "../src/lib/directory-export-layout";
import { compareByKeys, type FieldLike, type PersonLike } from "../src/lib/directory-display";

const normal = { font: 8.5, pad: 3, head: 7.5 };
const letter = { paper: "letter" as const, orientation: "portrait" as const, ...normal, photo: 0, hasSubtitle: false };
const inch = { top: 1, right: 1, bottom: 1, left: 1 };

describe("margins", () => {
  test('"normal" is the page every export had (34 / 36 / 44 / 36 points) and what the geometry assumes when none is passed', () => {
    const today = { top: 34, right: 36, bottom: 44, left: 36 };
    assert.deepEqual(marginPoints("normal", inch), today, "the custom inches are ignored by a fixed preset");
    assert.deepEqual(MARGIN_POINTS.normal, today);
    assert.deepEqual(columnGeometry(letter), columnGeometry({ ...letter, margins: marginPoints("normal", inch) }));
  });

  test("narrow is 0.3in all round, wide 1in, and custom converts inches at 72 to the inch", () => {
    assert.deepEqual(marginPoints("narrow", inch), { top: 21.6, right: 21.6, bottom: 21.6, left: 21.6 });
    assert.deepEqual(marginPoints("wide", { top: 0.2, right: 0.2, bottom: 0.2, left: 0.2 }), { top: 72, right: 72, bottom: 72, left: 72 });
    assert.deepEqual(marginPoints("custom", { top: 0.5, right: 0.5, bottom: 0.6, left: 0.5 }), { top: 36, right: 36, bottom: 43.2, left: 36 });
    assert.deepEqual(marginPoints("custom", { top: 2, right: 0.2, bottom: 1.25, left: 0.75 }), { top: 144, right: 14.4, bottom: 90, left: 54 });
  });
});

describe("columnGeometry", () => {
  test("letter portrait at normal density holds 39 rows a column under normal margins, the count before margins were a setting", () => {
    assert.equal(columnGeometry(letter).slotsPerColumn, 39);
    assert.equal(columnGeometry(letter).sectionSlots, 2);
  });

  test("more rows on taller paper, fewer with photos, and a section costs more than a row", () => {
    const base = columnGeometry(letter);
    const legal = columnGeometry({ ...letter, paper: "legal" });
    const landscape = columnGeometry({ ...letter, orientation: "landscape" });
    const photos = columnGeometry({ ...letter, photo: 20 });
    assert.ok(base.slotsPerColumn > 35 && base.slotsPerColumn < 45, `letter holds ~40 rows, got ${base.slotsPerColumn}`);
    assert.ok(legal.slotsPerColumn > base.slotsPerColumn);
    assert.ok(landscape.slotsPerColumn < base.slotsPerColumn);
    assert.ok(photos.slotsPerColumn < base.slotsPerColumn, "a photo row is taller");
    assert.equal(base.sectionSlots, 2);
  });

  test("narrow margins hold more rows than normal, wide fewer, and the top and bottom are what count", () => {
    const base = columnGeometry(letter);
    const narrow = columnGeometry({ ...letter, margins: MARGIN_POINTS.narrow });
    const wide = columnGeometry({ ...letter, margins: MARGIN_POINTS.wide });
    const sidesOnly = columnGeometry({ ...letter, margins: { ...MARGIN_POINTS.normal, left: 100, right: 100 } });
    assert.ok(narrow.slotsPerColumn > base.slotsPerColumn, `narrow ${narrow.slotsPerColumn} > normal ${base.slotsPerColumn}`);
    assert.ok(wide.slotsPerColumn < base.slotsPerColumn, `wide ${wide.slotsPerColumn} < normal ${base.slotsPerColumn}`);
    assert.equal(sidesOnly.slotsPerColumn, base.slotsPerColumn, "side margins do not change the row count");
  });
});

describe("column widths", () => {
  test("a limit becomes a width of limit × 0.52 × font + 5 points", () => {
    assert.equal(limitedWidth(20, 8.5), 93.4);
    assert.equal(limitedWidth(8, 10), 46.6);
    assert.equal(limitedWidth(120, 7.5), 473);
  });

  test("an empty column_limits changes no width: every column stays automatic with its weight", () => {
    const cols = [
      { key: "name", weight: 12, limit: 0 },
      { key: "title", weight: 20, limit: 0 },
    ];
    assert.deepEqual(columnWidths(cols, 8.5, 540), [
      { key: "name", fixed: null, weight: 12 },
      { key: "title", fixed: null, weight: 20 },
    ]);
  });

  test("a limited column is fixed and the others keep their weights", () => {
    const out = columnWidths(
      [
        { key: "name", weight: 12, limit: 0 },
        { key: "title", weight: 20, limit: 20 },
        { key: "phone", weight: 8, limit: 0 },
      ],
      8.5,
      540
    );
    assert.deepEqual(out, [
      { key: "name", fixed: null, weight: 12 },
      { key: "title", fixed: 93.4, weight: 20 },
      { key: "phone", fixed: null, weight: 8 },
    ]);
  });

  test("fixed columns that would starve the automatic ones are scaled down together, and never overflow a row they fill alone", () => {
    const sum = (cols: { fixed: number | null }[]) => cols.reduce((s, c) => s + (c.fixed ?? 0), 0);
    const mixed = columnWidths(
      [
        { key: "a", weight: 5, limit: 120 },
        { key: "b", weight: 5, limit: 120 },
        { key: "c", weight: 5, limit: 0 },
      ],
      8.5,
      300
    );
    // 2 × 535.4 points would swallow the row; they are cut to two thirds of it.
    assert.ok(Math.abs(sum(mixed) - 200) < 0.05, `fixed total ${sum(mixed)}`);
    assert.equal(mixed[2].fixed, null);
    const alone = columnWidths(
      [
        { key: "a", weight: 5, limit: 120 },
        { key: "b", weight: 5, limit: 120 },
      ],
      8.5,
      300
    );
    assert.ok(Math.abs(sum(alone) - 300) < 0.05, `fixed total ${sum(alone)}`);
    // Within the cap nothing is scaled.
    const fits = columnWidths([{ key: "a", weight: 5, limit: 20 }, { key: "b", weight: 5, limit: 0 }], 8.5, 540);
    assert.equal(fits[0].fixed, 93.4);
  });

  test("rowWidth is the paper less the side margins, split across the page's columns, less the photo column", () => {
    const m = MARGIN_POINTS.normal;
    assert.equal(rowWidth({ paper: "letter", orientation: "portrait", margins: m, pageColumns: 1, gap: 18, photo: 0 }), 540);
    assert.equal(rowWidth({ paper: "letter", orientation: "portrait", margins: m, pageColumns: 2, gap: 18, photo: 26 }), (540 - 18) / 2 - 26);
    assert.equal(rowWidth({ paper: "letter", orientation: "landscape", margins: m, pageColumns: 1, gap: 18, photo: 0 }), 720);
    assert.equal(rowWidth({ paper: "letter", orientation: "portrait", margins: MARGIN_POINTS.wide, pageColumns: 3, gap: 14, photo: 0 }), (612 - 144 - 28) / 3);
  });
});

describe("wrappedLineCount", () => {
  test("counts the lines a value wraps onto at a character limit, breaking between words", () => {
    assert.equal(wrappedLineCount("Jane Smith", 20), 1);
    assert.equal(wrappedLineCount("Senior Paralegal", 10), 2);
    // ceil(16 / 8) says two; "Marie" does not fit after "Jane", so it is three.
    assert.equal(wrappedLineCount("Jane Marie Smith", 8), 3);
    assert.equal(wrappedLineCount("", 10), 1);
    assert.equal(wrappedLineCount("   ", 10), 1);
  });

  test("a word longer than a line breaks mid-word; a word exactly a line long fills it", () => {
    assert.equal(wrappedLineCount("Supercalifragilistic", 8), 3);
    assert.equal(wrappedLineCount("12345678", 8), 1);
    assert.equal(wrappedLineCount("12345678 9", 8), 2);
  });

  test("never fewer than ceil(length / limit)", () => {
    for (const [s, limit] of [
      ["Accounting Department", 12],
      ["Legal Operations Lead", 10],
      ["a b c d e f g h i j", 3],
    ] as const) {
      assert.ok(wrappedLineCount(s, limit) >= Math.ceil(s.length / limit), `${s} at ${limit}`);
    }
  });
});

describe("planPages", () => {
  const row = (n: number): ExportLine<number> => ({ kind: "row", row: n });
  const section = (label: string, count: number): ExportLine<number> => ({ kind: "section", label, count });

  test("deals rows into columns of the given height, two to a page", () => {
    const lines = Array.from({ length: 25 }, (_, i) => row(i));
    const pages = planPages(lines, { slotsPerColumn: 10, sectionSlots: 2 });
    assert.equal(pages.length, 2);
    assert.deepEqual(pages[0].columns.map((c) => c.lines.length), [10, 10]);
    assert.deepEqual(pages[1].columns.map((c) => c.lines.length), [5]);
    assert.deepEqual((pages[1].columns[0].lines[0] as { row: number }).row, 20, "order is preserved across columns");
  });

  test("a section header never sits alone at the foot of a column", () => {
    const lines = [section("A", 8), ...Array.from({ length: 7 }, (_, i) => row(i)), section("B", 3), row(7), row(8), row(9)];
    const pages = planPages(lines, { slotsPerColumn: 10, sectionSlots: 2 });
    // 2 (header) + 7 rows = 9 used; header B needs 2 + 1 row = 3 more → next column.
    assert.equal(pages[0].columns[0].lines.length, 8);
    assert.equal(pages[0].columns[1].lines[0].kind, "section");
    assert.equal(pages[0].columns[1].lines.length, 4);
  });

  test("a row that wraps costs the lines it takes", () => {
    const lines: ExportLine<number>[] = [row(0), { kind: "row", row: 1, lines: 3 }, row(2), { kind: "row", row: 3, lines: 4 }, row(4)];
    const pages = planPages(lines, { slotsPerColumn: 5, sectionSlots: 2 });
    // 1 + 3 + 1 = 5 fill the first column; the four-line row opens the next.
    assert.deepEqual(pages[0].columns.map((c) => c.lines.length), [3, 2]);
    assert.deepEqual((pages[0].columns[1].lines[0] as { row: number }).row, 3);
  });

  test("a row with no line count, or a count of 0 or 1, costs one slot as before", () => {
    const lines: ExportLine<number>[] = [row(0), { kind: "row", row: 1, lines: 0 }, { kind: "row", row: 2, lines: 1 }, ...Array.from({ length: 7 }, (_, i) => row(3 + i))];
    const pages = planPages(lines, { slotsPerColumn: 10, sectionSlots: 2 });
    assert.deepEqual(pages[0].columns.map((c) => c.lines.length), [10]);
  });

  test("three to a page when asked", () => {
    const lines = Array.from({ length: 25 }, (_, i) => row(i));
    const pages = planPages(lines, { slotsPerColumn: 10, sectionSlots: 2 }, 3);
    assert.equal(pages.length, 1);
    assert.deepEqual(pages[0].columns.map((c) => c.lines.length), [10, 10, 5]);
  });

  test("an empty table is one page with one empty column", () => {
    assert.deepEqual(planPages([], { slotsPerColumn: 10, sectionSlots: 2 }), [{ columns: [{ lines: [] }] }]);
  });
});

describe("compareByKeys", () => {
  const fields: FieldLike[] = [
    { key: "office", label: "Office", kind: "text", options: [{ value: "PHX1" }, { value: "TUC" }], value_format: "raw", multi: 0, builtin: 1, display: "field", show_in_card: 1, show_with: "", highlight: 0, inverse_label: "", group_by: 1 } as unknown as FieldLike,
    { key: "ext", label: "Extension", kind: "text", options: [], value_format: "raw", multi: 0, builtin: 0, display: "field", show_in_card: 1, show_with: "", highlight: 0, inverse_label: "", group_by: 0 } as unknown as FieldLike,
  ];
  const person = (name: string, office: string, ext: string): PersonLike =>
    ({ id: name.length, name, title: "", department: "", email: "", phone: "", mobile: "", office, custom: { ext }, links: {}, linked_by: {}, pin_order: null, hidden: 0 }) as unknown as PersonLike;
  const people = [person("Zed", "TUC", "100"), person("Amy", "PHX1", "300"), person("Bob", "PHX1", "200"), person("Cal", "PHX1", "200"), person("Dee", "", "050")];

  test("falls through the keys in order, options first, empties last, name breaking the final tie", () => {
    const sorted = [...people].sort(compareByKeys(fields, [{ key: "office", dir: 1 }, { key: "ext", dir: -1 }]));
    assert.deepEqual(sorted.map((p) => p.name), ["Amy", "Bob", "Cal", "Zed", "Dee"], "PHX1 before TUC (option order); within PHX1 ext descending; Bob before Cal by name; no office last");
  });

  test("a blank or repeated second key is ignored", () => {
    const one = [...people].sort(compareByKeys(fields, [{ key: "ext", dir: 1 }]));
    const dup = [...people].sort(compareByKeys(fields, [{ key: "ext", dir: 1 }, { key: "ext", dir: -1 }, { key: "", dir: 1 }]));
    assert.deepEqual(dup.map((p) => p.name), one.map((p) => p.name));
    assert.deepEqual(one.map((p) => p.name), ["Dee", "Zed", "Bob", "Cal", "Amy"]);
  });
});
