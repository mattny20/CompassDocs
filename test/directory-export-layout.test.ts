// The two-column PDF plan and the chained sort — pure rules.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { columnGeometry, planPages, type ExportLine } from "../src/lib/directory-export-layout";
import { compareByKeys, type FieldLike, type PersonLike } from "../src/lib/directory-display";

const normal = { font: 8.5, pad: 3, head: 7.5 };

describe("columnGeometry", () => {
  test("more rows on taller paper, fewer with photos, and a section costs more than a row", () => {
    const letter = columnGeometry({ paper: "letter", orientation: "portrait", ...normal, photo: 0, hasSubtitle: false });
    const legal = columnGeometry({ paper: "legal", orientation: "portrait", ...normal, photo: 0, hasSubtitle: false });
    const landscape = columnGeometry({ paper: "letter", orientation: "landscape", ...normal, photo: 0, hasSubtitle: false });
    const photos = columnGeometry({ paper: "letter", orientation: "portrait", ...normal, photo: 20, hasSubtitle: false });
    assert.ok(letter.slotsPerColumn > 35 && letter.slotsPerColumn < 45, `letter holds ~40 rows, got ${letter.slotsPerColumn}`);
    assert.ok(legal.slotsPerColumn > letter.slotsPerColumn);
    assert.ok(landscape.slotsPerColumn < letter.slotsPerColumn);
    assert.ok(photos.slotsPerColumn < letter.slotsPerColumn, "a photo row is taller");
    assert.equal(letter.sectionSlots, 2);
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
