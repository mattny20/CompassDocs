// The export's section order (1.13.0): a preset's `section_order`, the
// ordering rule (listed values first, the rest in the field's own order,
// nothing listed = the field's order), the sections preview the editor
// lists, and the PDF and CSV that follow it.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/directory-sections.test.ts
// (needs no DATABASE_URL: nothing here reads the settings store).

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { groupPeople, orderGroups, sectionSummaries } from "../src/lib/directory-display";
import { PRESET_DEFAULTS, SECTION_ORDER_LIMIT, sanitizePreset, type ExportPreset } from "../src/lib/directory-export-config";
import type { DirectoryField, DirectoryPerson } from "../src/lib/directory";

// @react-pdf/hyphenate's exports map carries only an `import` condition, so
// the renderer's CommonJS chain under tsx cannot resolve its language files
// (Next loads the renderer as ESM and never hits this). Point those requires
// at the files. Installed before the renderer is imported, below.
const HYPHENATE = path.join(__dirname, "..", "node_modules", "@react-pdf", "hyphenate", "lib");
type Resolver = { _resolveFilename: (this: unknown, request: string, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolveFilename = resolver._resolveFilename;
resolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  const m = /^@react-pdf\/hyphenate\/([\w-]+)$/.exec(request);
  return m ? path.join(HYPHENATE, `${m[1]}.js`) : resolveFilename.call(this, request, ...rest);
};

// --- Fixtures ------------------------------------------------------------------

const field = (f: Partial<DirectoryField> & { key: string; label: string }): DirectoryField =>
  ({
    id: 0,
    kind: "text",
    options: [],
    value_format: "raw",
    multi: 0,
    builtin: 0,
    display: "field",
    show_in_card: 1,
    show_with: "",
    highlight: 0,
    inverse_label: "",
    group_by: 0,
    sort: 0,
    graph_path: "",
    google_path: "",
    link_direction: "out",
    mappings: {},
    date_role: "",
    visibility: "everyone",
    ...f,
  }) as unknown as DirectoryField;

const office = field({
  key: "office",
  label: "Office",
  builtin: 1,
  group_by: 1,
  options: [
    { value: "PHX1", label: "Phoenix" },
    { value: "TUC", label: "Tucson" },
    { value: "OLD", label: "Closed office", hidden: true },
  ],
  value_format: "label",
});
const department = field({ key: "department", label: "Department", builtin: 1, group_by: 1 });
const fields: DirectoryField[] = [
  field({ key: "title", label: "Title", builtin: 1 }),
  department,
  office,
  field({ key: "extension", label: "Extension" }),
];

const person = (id: number, name: string, extra: Partial<DirectoryPerson> = {}): DirectoryPerson =>
  ({
    id,
    source: "manual",
    external_id: null,
    name,
    title: "",
    department: "",
    email: "",
    phone: "",
    mobile: "",
    office: "",
    photo: "",
    hidden: 0,
    pin_order: null,
    custom: {},
    synced: {},
    manual: {},
    links: {},
    linked_by: {},
    has_record: false,
    assistant_name: null,
    updated_at: "",
    ...extra,
  }) as DirectoryPerson;

// Phoenix: Smith, Beethoven. Tucson: Zimmer, Adams. No office: Lee, Ortiz.
// Departments are raw values, so they order alphabetically: Legal, Ops.
const people: DirectoryPerson[] = [
  person(1, "Smith, Jane", { title: "Partner", office: "PHX1", department: "Legal" }),
  person(2, "Adam Zimmer", { title: "Associate", office: "TUC", department: "Legal" }),
  person(3, "Pat Lee", { title: "Legal Assistant", department: "Ops" }),
  person(4, "Sam Ortiz", { title: "Paralegal" }),
  person(5, "Ludwig van Beethoven", { title: "Composer", office: "Phoenix", department: "Ops" }),
  person(6, "Dr. Bob Adams Jr.", { title: "Of Counsel", office: "tuc", pin_order: 1 }),
];

// --- The preset key ------------------------------------------------------------

describe("sanitizePreset: section_order", () => {
  test("a preset stored before 1.13.0 sanitizes to an empty order; the default is empty", () => {
    const legacy = sanitizePreset({ id: "phone-directory", name: "Phone directory", columns: ["name", "phone"], group_by: "office" }, fields);
    assert.deepEqual(legacy.section_order, []);
    assert.equal(legacy.group_by, "office");
    assert.deepEqual(PRESET_DEFAULTS.section_order, []);
  });

  test("values are trimmed, blanks and junk dropped, cut to 120 characters, kept once (case-insensitively), at most 200", () => {
    const p = sanitizePreset(
      { name: "x", group_by: "office", section_order: ["TUC", " PHX1 ", "", "   ", "tuc", 7, null, { v: 1 }, "x".repeat(130), "PHX1"] },
      fields
    );
    assert.deepEqual(p.section_order, ["TUC", "PHX1", "7", "x".repeat(120)]);
    assert.deepEqual(sanitizePreset({ name: "x", group_by: "office", section_order: "TUC,PHX1" }, fields).section_order, [], "a string is not a list");
    assert.deepEqual(sanitizePreset({ name: "x", group_by: "office", section_order: { 0: "TUC" } }, fields).section_order, []);
    const many = sanitizePreset({ name: "x", group_by: "office", section_order: Array.from({ length: 250 }, (_, i) => `v${i}`) }, fields);
    assert.equal(many.section_order.length, SECTION_ORDER_LIMIT);
    assert.equal(many.section_order[0], "v0");
    assert.equal(many.section_order[199], "v199");
  });

  test("an order is dropped when there is no Sections by field: blank, unknown, or one the registry does not group by", () => {
    assert.deepEqual(sanitizePreset({ name: "x", group_by: "", section_order: ["TUC"] }, fields).section_order, []);
    assert.deepEqual(sanitizePreset({ name: "x", section_order: ["TUC"] }, fields).section_order, []);
    assert.deepEqual(sanitizePreset({ name: "x", group_by: "nope", section_order: ["TUC"] }, fields).section_order, []);
    const notGrouped = sanitizePreset({ name: "x", group_by: "title", section_order: ["Partner"] }, fields);
    assert.equal(notGrouped.group_by, "", "title is not a group_by field here");
    assert.deepEqual(notGrouped.section_order, []);
    // A value no section has today is kept: it is harmless, and tomorrow's sync may bring it back.
    assert.deepEqual(sanitizePreset({ name: "x", group_by: "office", section_order: ["DEN"] }, fields).section_order, ["DEN"]);
  });

  test("sanitizing is stable: a sanitized preset sanitizes to itself", () => {
    const once = sanitizePreset({ name: "Stable", group_by: "office", section_order: ["TUC", "PHX1"], columns: ["name", "office"] }, fields);
    assert.deepEqual(once.section_order, ["TUC", "PHX1"]);
    assert.deepEqual(sanitizePreset(once, fields), once);
  });
});

// --- The ordering rule ---------------------------------------------------------

describe("orderGroups", () => {
  const groups = () => groupPeople(people, office);

  test("the field's own order: options in their order, 'No office' last; an empty order hands it back unchanged", () => {
    const own = groups();
    assert.deepEqual(own.map((g) => [g.key, g.label, g.members.length]), [["PHX1", "Phoenix", 2], ["TUC", "Tucson", 2], ["", "No office", 2]]);
    assert.equal(orderGroups(own, []), own, "the same array, not a copy");
    assert.deepEqual(orderGroups(own, []), own);
  });

  test("listed values come first in the list's order; the rest follow in the field's order", () => {
    assert.deepEqual(orderGroups(groups(), ["TUC"]).map((g) => g.label), ["Tucson", "Phoenix", "No office"]);
    assert.deepEqual(orderGroups(groups(), ["TUC", "PHX1"]).map((g) => g.label), ["Tucson", "Phoenix", "No office"]);
    assert.deepEqual(orderGroups(groups(), ["PHX1", "TUC"]).map((g) => g.label), ["Phoenix", "Tucson", "No office"]);
    const raw = groupPeople(people, department);
    assert.deepEqual(raw.map((g) => g.label), ["Legal", "Ops", "No department"]);
    assert.deepEqual(orderGroups(raw, ["Ops"]).map((g) => g.label), ["Ops", "Legal", "No department"]);
  });

  test("a listed value matches a group's key case-insensitively, is read once, and one no group has is skipped; the empty key is never listed", () => {
    assert.deepEqual(orderGroups(groups(), ["tuc", "DEN", " Tuc ", "phx1"]).map((g) => g.label), ["Tucson", "Phoenix", "No office"]);
    assert.deepEqual(orderGroups(groups(), ["", "TUC"]).map((g) => g.label), ["Tucson", "Phoenix", "No office"], "'' names nothing, so No office stays last");
    assert.deepEqual(orderGroups(groups(), ["DEN"]).map((g) => g.label), ["Phoenix", "Tucson", "No office"]);
  });
});

// --- The preview ---------------------------------------------------------------

describe("sectionSummaries", () => {
  test("one row per section in the field's own order, labelled as the export prints it, with counts; people with no value are left out", () => {
    assert.deepEqual(sectionSummaries(people, office, fields), [
      { value: "PHX1", label: "Phoenix", count: 2 },
      { value: "TUC", label: "Tucson", count: 2 },
    ]);
    assert.deepEqual(sectionSummaries(people, department, fields), [
      { value: "Legal", label: "Legal", count: 2 },
      { value: "Ops", label: "Ops", count: 2 },
    ]);
    assert.deepEqual(sectionSummaries([], office, fields), []);
    assert.deepEqual(sectionSummaries([people[3]], office, fields), [], "a person with no value makes no section");
  });

  test("a hidden option makes no section; the filter narrows the people as the export's does", () => {
    const closed = person(7, "Old Timer", { office: "OLD", department: "Legal" });
    assert.deepEqual(
      sectionSummaries([...people, closed], office, fields).map((s) => s.value),
      ["PHX1", "TUC"]
    );
    assert.deepEqual(sectionSummaries(people, office, fields, { key: "department", value: "legal" }), [
      { value: "PHX1", label: "Phoenix", count: 1 },
      { value: "TUC", label: "Tucson", count: 1 },
    ]);
    assert.deepEqual(sectionSummaries(people, department, fields, { key: "office", value: "Phoenix" }), [
      { value: "Legal", label: "Legal", count: 1 },
      { value: "Ops", label: "Ops", count: 1 },
    ]);
    assert.deepEqual(sectionSummaries(people, office, fields, null), sectionSummaries(people, office, fields));
  });
});

// --- The files -----------------------------------------------------------------

describe("the export follows the section order", () => {
  let exporter: typeof import("../src/lib/directory-export");
  before(async () => {
    exporter = await import("../src/lib/directory-export");
  });

  const preset = (patch: Partial<ExportPreset> = {}) =>
    sanitizePreset(
      { id: "sections", name: "Sections", columns: ["name", "title"], group_by: "office", office_info: false, logo: false, ...patch },
      fields
    );
  const labels = (p: ExportPreset) => exporter.prepareExport({ preset: p, people, fields, company: "Acme" }).sections.map((s) => s.label);

  test("a preset with no order prints the sections exactly as before; an order moves the listed sections to the front", () => {
    const before1130 = { ...preset() } as Partial<ExportPreset> & { section_order?: string[] };
    delete before1130.section_order;
    assert.deepEqual(labels(preset()), ["Phoenix", "Tucson", "No office"]);
    assert.deepEqual(labels(before1130 as ExportPreset), labels(preset()), "a stored preset without the key renders the same");
    assert.deepEqual(labels(preset({ section_order: ["TUC"] })), ["Tucson", "Phoenix", "No office"]);
    assert.deepEqual(labels(preset({ section_order: ["tuc", "PHX1"] })), ["Tucson", "Phoenix", "No office"]);
    // Pinned people keep their own section in front of every other.
    assert.deepEqual(labels(preset({ section_order: ["TUC"], pinned_first: true })), ["Key contacts", "Tucson", "Phoenix", "No office"]);
    // One flat list carries no order.
    assert.deepEqual(labels(preset({ group_by: "", section_order: ["TUC"] })), [null]);
  });

  test("the CSV's section rows follow the order", () => {
    const rows = (p: ExportPreset) =>
      exporter
        .renderDirectoryCsv({ preset: p, people, fields, company: "Acme" })
        .replace(/^\uFEFF/, "")
        .trim()
        .split("\r\n");
    const own = rows(preset());
    assert.equal(own[0], "Group,Name,Title");
    assert.deepEqual(
      own.slice(1).map((l) => l.split(",")[0]),
      ["Phoenix", "Phoenix", "Tucson", "Tucson", "No office", "No office"]
    );
    const moved = rows(preset({ section_order: ["TUC"] }));
    assert.deepEqual(
      moved.slice(1).map((l) => l.split(",")[0]),
      ["Tucson", "Tucson", "Phoenix", "Phoenix", "No office", "No office"]
    );
    assert.deepEqual([...own].sort(), [...moved].sort(), "the same rows, only their order differs");
  });

  /** A PDF's bytes with pdfkit's clock taken out, so two renders can be compared. */
  const stable = (pdf: Buffer): string =>
    pdf
      .toString("latin1")
      .replace(/\(D:\d{14}Z\)/g, "(D:)")
      .replace(/<xmp:CreateDate>[^<]*<\/xmp:CreateDate>/g, "")
      .replace(/\/ID \[[^\]]*\]/g, "");

  test("the PDF renders with a custom order, in every layout, and differs from the field-order render", async () => {
    const render = (patch: Partial<ExportPreset> = {}) =>
      exporter.renderDirectoryPdf({ preset: preset(patch), people, fields, company: "Acme", logo: null, printedOn: "Oct 20, 2026" });
    const own = await render();
    const moved = await render({ section_order: ["TUC"] });
    assert.equal(moved.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(moved.length > 1000, `pdf is ${moved.length} bytes`);
    assert.equal(stable(moved), stable(await render({ section_order: ["TUC"] })), "deterministic once the clock is taken out");
    assert.notEqual(stable(moved), stable(own), "the order changes the page");
    assert.equal(stable(own), stable(await render({ section_order: [] })), "an empty order is the field's order");
    assert.equal(stable(own), stable(await render({ section_order: ["PHX1", "TUC"] })), "the field's order spelled out is the field's order");
    for (const layout of [{ layout: "cards" as const }, { page_columns: 2 as const }, { page_columns: 3 as const }]) {
      const withOrder = await render({ ...layout, section_order: ["TUC"] });
      assert.equal(withOrder.subarray(0, 5).toString("latin1"), "%PDF-");
      assert.notEqual(stable(withOrder), stable(await render(layout)), `the order changes the ${JSON.stringify(layout)} page`);
    }
  });

  test("a preset stored before 1.13.0 (no section_order key at all) renders the PDF and the CSV byte for byte as the field's order does", async () => {
    const keyless = (patch: Partial<ExportPreset> = {}): ExportPreset => {
      const p = { ...preset(patch) } as Partial<ExportPreset> & { section_order?: string[] };
      delete p.section_order;
      return p as ExportPreset;
    };
    const pdf = (p: ExportPreset) => exporter.renderDirectoryPdf({ preset: p, people, fields, company: "Acme", logo: null, printedOn: "Oct 20, 2026" });
    const csv = (p: ExportPreset) => exporter.renderDirectoryCsv({ preset: p, people, fields, company: "Acme" });
    assert.equal(stable(await pdf(keyless())), stable(await pdf(preset())), "the table");
    assert.equal(csv(keyless()), csv(preset()), "the CSV");
    for (const layout of [{ layout: "cards" as const }, { page_columns: 2 as const }, { page_columns: 3 as const }]) {
      assert.equal(stable(await pdf(keyless(layout))), stable(await pdf(preset(layout))), `the ${JSON.stringify(layout)} page`);
    }
  });
});
