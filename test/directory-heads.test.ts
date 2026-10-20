// Directory section heads (1.13.0): an option's `heads` (the people who head
// its section), the option parsing with and without them, the strict
// save-time check, the preset's `section_heads`, the pure ordering the
// Groups view and the export share, and the PDF and CSV that lead each
// section with its heads.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/directory-heads.test.ts
// (the pure cases need no DATABASE_URL; the last describe, which drives the
// field route, the zip and the vCard, skips itself without one.)

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import JSZip from "jszip";
import {
  OPTION_HEADS_LIMIT,
  groupHeads,
  groupPeople,
  headsLabel,
  leadWithHeads,
  registryHasHeads,
  sectionSummaries,
  sectionsHeadedBy,
} from "../src/lib/directory-display";
import { optionHeadsProblem, sanitizeOptions } from "../src/lib/directory";
import { PRESET_DEFAULTS, sanitizePreset, type ExportPreset } from "../src/lib/directory-export-config";
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

// Jane (Executive) heads Engineering and Design; Cy heads Design and sits in it.
const department = field({
  key: "department",
  label: "Department",
  builtin: 1,
  group_by: 1,
  options: [
    { value: "ENG", label: "Engineering", heads: [1] },
    { value: "DES", label: "Design", heads: [1, 3] },
    { value: "EXEC", label: "Executive" },
  ],
  value_format: "label",
});
const office = field({
  key: "office",
  label: "Office",
  builtin: 1,
  group_by: 1,
  options: [{ value: "PHX1", label: "Phoenix" }, { value: "TUC", label: "Tucson" }],
  value_format: "label",
});
const fields: DirectoryField[] = [field({ key: "title", label: "Title", builtin: 1 }), department, office];
/** The same registry before anyone named a head. */
const headless: DirectoryField[] = fields.map((f) =>
  f.key === "department" ? { ...f, options: f.options.map(({ heads: _h, ...o }) => o) } : f
);

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

const people: DirectoryPerson[] = [
  person(1, "Jane Smith", { title: "COO", department: "EXEC", office: "PHX1" }),
  person(2, "Bob Ames", { title: "Engineer", department: "ENG", office: "PHX1" }),
  person(3, "Cy Vance", { title: "Design lead", department: "DES", office: "TUC" }),
  person(4, "Dee Park", { title: "Engineer", department: "ENG", office: "TUC" }),
  person(5, "Eve Lu", { title: "Designer", department: "DES", office: "PHX1" }),
  person(6, "Noel Ortiz", { title: "Temp" }),
];
const byId = new Map(people.map((p) => [p.id, p]));
const names = (rows: DirectoryPerson[]) => rows.map((p) => p.name);

// --- The option shape ----------------------------------------------------------

describe("sanitizeOptions: heads", () => {
  test("an option without heads parses as it always did, and a bare string still parses", () => {
    assert.deepEqual(sanitizeOptions([{ value: "ENG", label: "Engineering" }]), [{ value: "ENG", label: "Engineering" }]);
    assert.deepEqual(sanitizeOptions(["ENG", " DES ", "", "eng"]), [{ value: "ENG" }, { value: "DES" }]);
    assert.deepEqual(sanitizeOptions([{ value: "ENG", heads: [] }]), [{ value: "ENG" }], "no heads, no key");
  });

  test("heads are whole positive ids, each once, in order, at most five; junk is dropped on read", () => {
    assert.deepEqual(sanitizeOptions([{ value: "ENG", heads: [3, "1", 3, 0, -2, 1.5, "x", null, 2] }]), [{ value: "ENG", heads: [3, 1, 2] }]);
    const many = sanitizeOptions([{ value: "ENG", heads: [1, 2, 3, 4, 5, 6, 7] }]);
    assert.deepEqual(many[0].heads, [1, 2, 3, 4, 5]);
    assert.equal(OPTION_HEADS_LIMIT, 5);
    assert.deepEqual(sanitizeOptions([{ value: "ENG", heads: "1,2" }]), [{ value: "ENG" }], "a string is not a list");
  });

  test("the save-time check refuses by name what the read would drop: a non-integer id, more than five", () => {
    assert.equal(optionHeadsProblem([{ value: "ENG", heads: [1, 2] }, { value: "DES" }, "EXEC"]), undefined);
    assert.equal(optionHeadsProblem([{ value: "ENG", heads: [] }]), undefined);
    assert.equal(optionHeadsProblem(undefined), undefined);
    assert.match(optionHeadsProblem([{ value: "ENG", heads: [1, "two"] }])!, /Heads of ENG: "two" is not a person's id\./);
    assert.match(optionHeadsProblem([{ value: "ENG", heads: [1.5] }])!, /not a person's id/);
    assert.match(optionHeadsProblem([{ value: "ENG", heads: [0] }])!, /not a person's id/);
    assert.match(optionHeadsProblem([{ value: "ENG", heads: [1, 2, 3, 4, 5, 6] }])!, /Heads of ENG: up to 5 heads per option\./);
    assert.equal(optionHeadsProblem([{ value: "ENG", heads: [1, 1, 2, 2, 3, 3] }]), undefined, "repeats count once");
    assert.match(optionHeadsProblem([{ value: "ENG", heads: { 0: 1 } }])!, /send a list/);
    assert.match(optionHeadsProblem([{ heads: ["x"] }])!, /Heads of an option:/);
  });
});

// --- The preset key ------------------------------------------------------------

describe("sanitizePreset: section_heads", () => {
  test("on unless switched off; a preset stored before 1.13.0 reads as on", () => {
    assert.equal(PRESET_DEFAULTS.section_heads, true);
    assert.equal(sanitizePreset({ name: "x", group_by: "department" }, fields).section_heads, true);
    assert.equal(sanitizePreset({ name: "x", group_by: "department", section_heads: false }, fields).section_heads, false);
    assert.equal(sanitizePreset({ name: "x", group_by: "department", section_heads: 0 }, fields).section_heads, false);
    assert.equal(sanitizePreset({ name: "x", group_by: "department", section_heads: "1" }, fields).section_heads, true);
    const once = sanitizePreset({ name: "Stable", group_by: "department", section_heads: false }, fields);
    assert.deepEqual(sanitizePreset(once, fields), once);
  });
});

// --- The pure rules -------------------------------------------------------------

describe("groupHeads, leadWithHeads, headsLabel", () => {
  test("a group's heads are its option's, in order, among the people given; the gone and the unmatched are skipped", () => {
    assert.deepEqual(names(groupHeads(department, "ENG", byId)), ["Jane Smith"]);
    assert.deepEqual(names(groupHeads(department, "des", byId)), ["Jane Smith", "Cy Vance"], "the key matches the option's value case-insensitively");
    assert.deepEqual(groupHeads(department, "EXEC", byId), []);
    assert.deepEqual(groupHeads(department, "", byId), [], "the No-value group has no option");
    assert.deepEqual(groupHeads(department, "Nope", byId), []);
    const onlyCy = new Map([[3, people[2]]]);
    assert.deepEqual(names(groupHeads(department, "DES", onlyCy)), ["Cy Vance"], "a head who is not among the people is not there");
    assert.deepEqual(groupHeads(office, "PHX1", byId), []);
  });

  test("the rows lead with the heads; a head who is also a member prints once, at the top; no heads hands the members back", () => {
    const groups = groupPeople(people, department);
    const eng = groups.find((g) => g.key === "ENG")!;
    const des = groups.find((g) => g.key === "DES")!;
    assert.deepEqual(names(leadWithHeads(eng.members, groupHeads(department, "ENG", byId))), ["Jane Smith", "Bob Ames", "Dee Park"]);
    assert.deepEqual(names(leadWithHeads(des.members, groupHeads(department, "DES", byId))), ["Jane Smith", "Cy Vance", "Eve Lu"]);
    assert.equal(leadWithHeads(eng.members, []), eng.members, "the same array");
  });

  test("the heading's meta text", () => {
    assert.equal(headsLabel([]), "");
    assert.equal(headsLabel(["Jane Smith"]), "Head: Jane Smith");
    assert.equal(headsLabel(["Jane Smith", "Cy Vance"]), "Heads: Jane Smith, Cy Vance");
  });

  test("what a person heads, as the headings print, and whether the registry has any head at all", () => {
    assert.deepEqual(sectionsHeadedBy(people[0], fields), ["Engineering", "Design"]);
    assert.deepEqual(sectionsHeadedBy(people[2], fields), ["Design"]);
    assert.deepEqual(sectionsHeadedBy(people[1], fields), []);
    assert.equal(registryHasHeads(fields), true);
    assert.equal(registryHasHeads(headless), false);
    // A head on a field that cannot section the directory does not count.
    const notGrouped = fields.map((f) => (f.key === "department" ? { ...f, group_by: 0 } : f));
    assert.equal(registryHasHeads(notGrouped), false);
    assert.deepEqual(sectionsHeadedBy(people[0], notGrouped), []);
  });
});

describe("sectionSummaries: heads", () => {
  test("a section with heads names them; one without carries no key, so the preview is what it was", () => {
    assert.deepEqual(sectionSummaries(people, department, fields), [
      { value: "ENG", label: "Engineering", count: 2, heads: [{ id: 1, name: "Jane Smith" }] },
      { value: "DES", label: "Design", count: 2, heads: [{ id: 1, name: "Jane Smith" }, { id: 3, name: "Cy Vance" }] },
      { value: "EXEC", label: "Executive", count: 1 },
    ]);
    assert.deepEqual(sectionSummaries(people, office, fields), [
      { value: "PHX1", label: "Phoenix", count: 3 },
      { value: "TUC", label: "Tucson", count: 2 },
    ]);
    // The filter narrows the people the heads are drawn from too.
    assert.deepEqual(sectionSummaries(people, department, fields, { key: "office", value: "Tucson" }), [
      { value: "ENG", label: "Engineering", count: 1 },
      { value: "DES", label: "Design", count: 1, heads: [{ id: 3, name: "Cy Vance" }] },
    ]);
  });
});

// --- The files -----------------------------------------------------------------

describe("the export leads each section with its heads", () => {
  let exporter: typeof import("../src/lib/directory-export");
  before(async () => {
    exporter = await import("../src/lib/directory-export");
  });

  const preset = (patch: Partial<ExportPreset> = {}, registry = fields) =>
    sanitizePreset(
      { id: "heads", name: "Heads", columns: ["name", "title"], group_by: "department", office_info: false, logo: false, ...patch },
      registry
    );
  const prepare = (p: ExportPreset, registry = fields, who = people) => exporter.prepareExport({ preset: p, people: who, fields: registry, company: "Acme" });

  test("a head who sits in another section prints first in the section they head, marked, and as an ordinary row in their own", () => {
    const prepared = prepare(preset());
    const [eng, des, exec, none] = prepared.sections;
    assert.equal(eng.label, "Engineering");
    assert.deepEqual(names(eng.rows), ["Jane Smith", "Bob Ames", "Dee Park"]);
    assert.deepEqual(names(eng.heads), ["Jane Smith"]);
    assert.equal(prepared.cell(eng.rows[0], "name", true), "Jane Smith · Head");
    assert.equal(prepared.cell(eng.rows[1], "name", false), "Bob Ames");
    assert.equal(prepared.cell(eng.rows[0], "name"), "Jane Smith", "the mark is the row's, not the person's");
    assert.equal(exporter.sectionMeta(eng, prepared.nameFormat), " · Head: Jane Smith");
    // Design: two heads, one of whom sits in Design and prints once, at the top; the count is members plus heads.
    assert.deepEqual(names(des.rows), ["Jane Smith", "Cy Vance", "Eve Lu"]);
    assert.deepEqual(names(des.heads), ["Jane Smith", "Cy Vance"]);
    assert.equal(exporter.sectionMeta(des, prepared.nameFormat), " · Heads: Jane Smith, Cy Vance");
    assert.equal(des.rows.length, 3);
    assert.deepEqual(names(exec.rows), ["Jane Smith"]);
    assert.deepEqual(exec.heads, []);
    assert.equal(exporter.sectionMeta(exec, prepared.nameFormat), "");
    assert.equal(none.label, "No department");
    assert.deepEqual(names(none.rows), ["Noel Ortiz"]);
    assert.equal(prepared.headsColumn, true);
  });

  test("the name format and the markers reach the head row and the heading; the mark comes after the formatted name", () => {
    const prepared = prepare(preset({ name_format: "last_first" }));
    const eng = prepared.sections[0];
    assert.equal(prepared.cell(eng.rows[0], "name", true), "Smith, Jane · Head");
    assert.equal(exporter.sectionMeta(eng, prepared.nameFormat), " · Head: Smith, Jane");
    const marked = exporter.prepareExport({
      preset: preset({ markers: ["coo"] }),
      people,
      fields,
      company: "Acme",
      markers: [{ id: "coo", label: "Officer", symbol: "*", key: "title", value: "COO" }],
    });
    assert.equal(marked.cell(marked.sections[0].rows[0], "name", true), "* Jane Smith · Head");
  });

  test("Section heads first off: heads print only where their own value puts them, and the heading carries no suffix", () => {
    const prepared = prepare(preset({ section_heads: false }));
    const [eng, des, exec] = prepared.sections;
    assert.deepEqual(names(eng.rows), ["Bob Ames", "Dee Park"]);
    assert.deepEqual(eng.heads, []);
    assert.equal(exporter.sectionMeta(eng, prepared.nameFormat), "");
    assert.deepEqual(names(des.rows), ["Cy Vance", "Eve Lu"]);
    assert.deepEqual(names(exec.rows), ["Jane Smith"]);
    assert.equal(prepared.headsColumn, true, "the CSV column is about the person, not the placement");
  });

  test("heads are drawn from the people the export prints: a filter or an id list that leaves a head out leaves them out; a pinned head still leads", () => {
    const filtered = prepare(preset({ filter: { key: "department", value: "Engineering" } }));
    assert.deepEqual(filtered.sections.map((s) => [s.label, names(s.rows), s.heads.length]), [["Engineering", ["Bob Ames", "Dee Park"], 0]]);
    const some = prepare(preset(), fields, people.filter((p) => p.id !== 1));
    assert.deepEqual(names(some.sections[0].rows), ["Bob Ames", "Dee Park"]);
    assert.deepEqual(names(some.sections[1].rows), ["Cy Vance", "Eve Lu"]);
    assert.deepEqual(names(some.sections[1].heads), ["Cy Vance"]);
    const pinnedJane = people.map((p) => (p.id === 1 ? { ...p, pin_order: 0 } : p));
    const pinned = prepare(preset({ pinned_first: true }), fields, pinnedJane);
    assert.deepEqual(pinned.sections.map((s) => s.label), ["Key contacts", "Engineering", "Design", "No department"]);
    assert.deepEqual(names(pinned.sections[0].rows), ["Jane Smith"]);
    assert.deepEqual(names(pinned.sections[1].rows), ["Jane Smith", "Bob Ames", "Dee Park"]);
    assert.deepEqual(names(pinned.sections[1].heads), ["Jane Smith"]);
  });

  test("backward compatibility: a registry without heads, or a preset without the key, prepares exactly as before", () => {
    const expected = (p: ReturnType<typeof prepare>) => p.sections.map((s) => [s.label, s.rows.map((r) => r.id), s.heads.length]);
    const before = prepare(preset({}, headless), headless);
    assert.deepEqual(expected(before), [
      ["Engineering", [2, 4], 0],
      ["Design", [3, 5], 0],
      ["Executive", [1], 0],
      ["No department", [6], 0],
    ]);
    assert.equal(before.headsColumn, false);
    assert.equal(before.sections.every((s) => exporter.sectionMeta(s, before.nameFormat) === ""), true);
    const legacy = { ...preset({}, headless) } as Partial<ExportPreset> & { section_heads?: boolean };
    delete legacy.section_heads;
    assert.deepEqual(expected(prepare(legacy as ExportPreset, headless)), expected(before), "a stored preset without the key renders the same");
    // Sections by a field without heads, in a registry that has some elsewhere: the sections are unchanged, only the column is added.
    const byOffice = prepare(preset({ group_by: "office" }));
    assert.deepEqual(expected(byOffice), [
      ["Phoenix", [2, 5, 1], 0],
      ["Tucson", [3, 4], 0],
      ["No office", [6], 0],
    ]);
    assert.equal(byOffice.headsColumn, true);
  });

  const csvLines = (p: ExportPreset, registry = fields) =>
    exporter
      .renderDirectoryCsv({ preset: p, people, fields: registry, company: "Acme" })
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n");

  test("the CSV: one row per person where their own value puts them (a cross-section head once, as a member, the column naming what they head; a head of their own section first), and a trailing 'Section head of' column on every row", () => {
    const lines = csvLines(preset());
    assert.equal(lines[0], "Group,Name,Title,Section head of");
    assert.deepEqual(lines.slice(1), [
      "Engineering,Bob Ames,Engineer,",
      "Engineering,Dee Park,Engineer,",
      "Design,Cy Vance,Design lead,Design",
      "Design,Eve Lu,Designer,",
      "Executive,Jane Smith,COO,Engineering; Design",
      "No department,Noel Ortiz,Temp,",
    ]);
    // The vCard's rule, so the toggle changes nothing in a spreadsheet: the column says it.
    assert.deepEqual(csvLines(preset({ section_heads: false })), lines);
    // After the Markers column; present without sectioning; absent for a registry without heads.
    const marked = exporter
      .renderDirectoryCsv({
        preset: preset({ markers: ["coo"], group_by: "" }),
        people,
        fields,
        company: "Acme",
        markers: [{ id: "coo", label: "Officer", symbol: "*", key: "title", value: "COO" }],
      })
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n");
    assert.equal(marked[0], "Name,Title,Markers,Section head of");
    assert.equal(marked.find((l) => l.includes("Jane")), "* Jane Smith,COO,Officer,Engineering; Design");
    assert.equal(csvLines(preset({ section_heads: false }))[0], "Group,Name,Title,Section head of");
    assert.equal(csvLines(preset({}, headless), headless)[0], "Group,Name,Title");
    assert.equal(csvLines(preset({ group_by: "" }, headless), headless)[0], "Name,Title");
  });

  /** A PDF's bytes with pdfkit's clock taken out, so two renders can be compared. */
  const stable = (pdf: Buffer): string =>
    pdf
      .toString("latin1")
      .replace(/\(D:\d{14}Z\)/g, "(D:)")
      .replace(/<xmp:CreateDate>[^<]*<\/xmp:CreateDate>/g, "")
      .replace(/\/ID \[[^\]]*\]/g, "");

  test("the PDF renders with heads in every layout and differs from the render without them; the toggle off is the headless page", async () => {
    const render = (patch: Partial<ExportPreset> = {}, registry = fields) =>
      exporter.renderDirectoryPdf({ preset: preset(patch, registry), people, fields: registry, company: "Acme", logo: null, printedOn: "Oct 20, 2026" });
    const withHeads = await render();
    assert.equal(withHeads.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(withHeads.length > 1000, `pdf is ${withHeads.length} bytes`);
    assert.equal(stable(withHeads), stable(await render()), "deterministic once the clock is taken out");
    const without = await render({}, headless);
    assert.notEqual(stable(withHeads), stable(without), "the heads change the page");
    assert.equal(stable(await render({ section_heads: false })), stable(without), "switched off, the page is the one a registry without heads makes");
    for (const layout of [{ layout: "cards" as const }, { page_columns: 2 as const }, { page_columns: 3 as const }]) {
      const page = await render(layout);
      assert.equal(page.subarray(0, 5).toString("latin1"), "%PDF-");
      assert.notEqual(stable(page), stable(await render(layout, headless)), `the heads change the ${JSON.stringify(layout)} page`);
      assert.equal(stable(await render({ ...layout, section_heads: false })), stable(await render(layout, headless)));
    }
  });

  test("a preset stored before 1.13.0 (no section_heads key at all) renders the PDF and the CSV byte for byte as the default does: with heads against a registry that has them, the old page against one that has none", async () => {
    const keyless = (patch: Partial<ExportPreset> = {}, registry = fields): ExportPreset => {
      const p = { ...preset(patch, registry) } as Partial<ExportPreset> & { section_heads?: boolean };
      delete p.section_heads;
      return p as ExportPreset;
    };
    const pdf = (p: ExportPreset, registry = fields) =>
      exporter.renderDirectoryPdf({ preset: p, people, fields: registry, company: "Acme", logo: null, printedOn: "Oct 20, 2026" });
    assert.equal(stable(await pdf(keyless())), stable(await pdf(preset())), "the table, heads on");
    assert.deepEqual(csvLines(keyless()), csvLines(preset()), "the CSV, heads on");
    assert.equal(stable(await pdf(keyless({}, headless), headless)), stable(await pdf(preset({}, headless), headless)), "the table, no heads anywhere");
    assert.deepEqual(csvLines(keyless({}, headless), headless), csvLines(preset({}, headless), headless), "the CSV, no heads anywhere");
    for (const layout of [{ layout: "cards" as const }, { page_columns: 2 as const }]) {
      assert.equal(stable(await pdf(keyless(layout))), stable(await pdf(preset(layout))), `the ${JSON.stringify(layout)} page`);
    }
  });

  test("a file of a split export (the zip's one-file-per-section) prints the section's members and draws its heads from everyone the export covers", () => {
    // Engineering's own file: Jane (Executive) leads it, marked, as she
    // leads the Engineering section of the single-file export; her own
    // section is not in the file, and the count is the file's rows.
    const engineering = new Set([2, 4]);
    const file = exporter.prepareExport({ preset: preset(), people, only: (p) => engineering.has(p.id), fields, company: "Acme" });
    assert.deepEqual(
      file.sections.map((s) => [s.label, names(s.rows), names(s.heads)]),
      [["Engineering", ["Jane Smith", "Bob Ames", "Dee Park"], ["Jane Smith"]]]
    );
    assert.equal(file.total, 2);
    assert.equal(exporter.sectionMeta(file.sections[0], file.nameFormat), " · Head: Jane Smith");
    // Its CSV keeps the head row: Jane prints nowhere else in this file.
    const lines = exporter
      .renderDirectoryCsv({ preset: preset(), people, only: (p) => engineering.has(p.id), fields, company: "Acme" })
      .replace(/^﻿/, "")
      .trim()
      .split("\r\n");
    assert.deepEqual(lines.slice(1), [
      "Engineering,Jane Smith,COO,Engineering; Design",
      "Engineering,Bob Ames,Engineer,",
      "Engineering,Dee Park,Engineer,",
    ]);
    // The preset's filter still bounds whom a head is drawn from (the single-file rule).
    const filtered = exporter.prepareExport({
      preset: preset({ filter: { key: "office", value: "Tucson" } }),
      people,
      only: (p) => engineering.has(p.id),
      fields,
      company: "Acme",
    });
    assert.deepEqual(filtered.sections.map((s) => [s.label, names(s.rows), names(s.heads)]), [["Engineering", ["Dee Park"], []]]);
    // Without `only`, nothing changes.
    assert.deepEqual(
      exporter.prepareExport({ preset: preset(), people, fields, company: "Acme" }).sections.map((s) => s.label),
      ["Engineering", "Design", "Executive", "No department"]
    );
  });
});

// --- Against the database ------------------------------------------------------
// The field route's 400 by sentence (PATCH), the zip's per-section files and
// the vCard need the database: the route reads the session, the office
// config and the workspace settings live in the settings store. The route
// handler is called directly, the way test/ack-reask.test.ts does it:
// next/headers resolves to a stub that serves the request under test (its
// session cookie). The admin is inserted with the ladder role, which the
// compass_users_ladder_sync trigger mirrors into the Administrator role.

describe("the field route, the zip and the vCard", { skip: process.env.DATABASE_URL ? false : "needs DATABASE_URL" }, () => {
  let currentRequest: Request | null = null;
  const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.directory-heads.virtual.js");
  {
    const jar = () => {
      const out = new Map<string, string>();
      for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
      }
      return out;
    };
    const headers = new Module(HEADERS_STUB);
    headers.filename = HEADERS_STUB;
    headers.loaded = true;
    headers.exports = {
      headers: async () => new Headers(currentRequest?.headers ?? {}),
      cookies: async () => {
        const c = jar();
        return {
          get: (name: string) => (c.has(name) ? { name, value: c.get(name) } : undefined),
          getAll: () => [...c].map(([name, value]) => ({ name, value })),
          has: (name: string) => c.has(name),
        };
      },
      draftMode: async () => ({ isEnabled: false }),
    };
    require.cache[HEADERS_STUB] = headers;
    const chained = resolver._resolveFilename;
    resolver._resolveFilename = function (request: string, ...rest: unknown[]) {
      return request === "next/headers" ? HEADERS_STUB : chained.call(this, request, ...rest);
    };
  }

  const STAMP = `dirheads-${Date.now()}`;
  let db: typeof import("../src/lib/db");
  let dir: typeof import("../src/lib/directory");
  let run: typeof import("../src/lib/directory-export-run");
  let vcf: typeof import("../src/lib/directory-export-vcf");
  let route: typeof import("../src/app/api/admin/directory/fields/[id]/route");
  let adminId = 0;
  let session = "";
  let fieldId = 0;
  const personIds: number[] = [];

  before(async () => {
    db = await import("../src/lib/db");
    dir = await import("../src/lib/directory");
    run = await import("../src/lib/directory-export-run");
    vcf = await import("../src/lib/directory-export-vcf");
    route = await import("../src/app/api/admin/directory/fields/[id]/route");
    await db.getSetting("__schema_bootstrap__");
    const { newToken } = await import("../src/lib/password");
    const users = await db
      .pool()
      .query<{ id: number }>(`INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Heads Admin', $2, 'admin', 'active') RETURNING id`, [
        `${STAMP}-admin`,
        `${STAMP}-admin@example.test`,
      ]);
    adminId = users.rows[0].id;
    session = newToken();
    await db.createSession(session, adminId, new Date(Date.now() + 3_600_000).toISOString());
    for (let i = 1; i <= 6; i++) {
      personIds.push((await dir.createPerson({ name: `${STAMP} Head ${i}`, email: `${STAMP}-h${i}@heads-test.example` })).id);
    }
    const made = await dir.createField({
      label: `${STAMP} Department`,
      key: `dh_${Date.now()}`,
      group_by: true,
      options: [{ value: "ENG", label: "Engineering" }],
      value_format: "label",
    });
    fieldId = made.id;
  });

  after(async () => {
    if (fieldId) await dir.deleteField(fieldId).catch(() => {});
    await db.pool().query("DELETE FROM directory_people WHERE id = ANY($1::int[])", [personIds]);
    await db.pool().query("DELETE FROM sessions WHERE user_id = $1", [adminId]);
    await db.pool().query("DELETE FROM users WHERE id = $1", [adminId]);
  });

  async function patch(body: unknown): Promise<{ status: number; body: any }> {
    const req = new Request(`http://localhost/api/admin/directory/fields/${fieldId}`, {
      method: "PATCH",
      headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    currentRequest = req;
    try {
      const res = await route.PATCH(req, { params: Promise.resolve({ id: String(fieldId) }) });
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
      currentRequest = null;
    }
  }

  test("PATCH refuses six heads, a stranger and junk by name with 400, writes nothing, and saves five in order", async () => {
    const six = await patch({ options: [{ value: "ENG", label: "Engineering", heads: personIds }] });
    assert.equal(six.status, 400);
    assert.deepEqual(six.body, { error: "Heads of ENG: up to 5 heads per option." });
    const stranger = await patch({ options: [{ value: "ENG", label: "Engineering", heads: [personIds[0], 2_000_000_000] }] });
    assert.equal(stranger.status, 400);
    assert.deepEqual(stranger.body, { error: "A head must be a person in the directory." });
    const junk = await patch({ options: [{ value: "ENG", label: "Engineering", heads: ["x"] }] });
    assert.equal(junk.status, 400);
    assert.deepEqual(junk.body, { error: `Heads of ENG: "x" is not a person's id.` });
    const untouched = (await dir.listFields()).find((f) => f.id === fieldId)!;
    assert.deepEqual(untouched.options.map((o) => o.heads ?? []), [[]], "a refused save changes nothing");

    const five = personIds.slice(0, 5);
    const saved = await patch({ options: [{ value: "ENG", label: "Engineering", heads: five }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.field.options[0].heads, five);
    assert.deepEqual((await dir.listFields()).find((f) => f.id === fieldId)!.options[0].heads, five);
  });

  const zipPreset = (patch: Partial<ExportPreset> = {}) =>
    sanitizePreset(
      { id: "zip", name: "Zip", columns: ["name", "title"], group_by: "department", split_by: "department", office_info: false, logo: false, ...patch },
      fields
    );

  test("the zip's per-section files carry the head rows the single-file export has: Jane leads Engineering's file and Design's", async () => {
    const file = await run.renderExportFile({ preset: zipPreset(), format: "csv", people, fields });
    assert.equal(file.mime, "application/zip");
    assert.equal(file.parts, 4, "Engineering, Design, Executive, No department");
    const zip = await JSZip.loadAsync(file.body);
    const part = async (suffix: string) => {
      const name = Object.keys(zip.files).find((n) => n.endsWith(suffix));
      assert.ok(name, `a file ending ${suffix} among ${Object.keys(zip.files).join(", ")}`);
      return (await zip.files[name!].async("string")).replace(/^﻿/, "").trim().split("\r\n");
    };
    assert.deepEqual(await part("-engineering.csv"), [
      "Group,Name,Title,Section head of",
      "Engineering,Jane Smith,COO,Engineering; Design",
      "Engineering,Bob Ames,Engineer,",
      "Engineering,Dee Park,Engineer,",
    ]);
    assert.deepEqual(await part("-design.csv"), [
      "Group,Name,Title,Section head of",
      "Design,Jane Smith,COO,Engineering; Design",
      "Design,Cy Vance,Design lead,Design",
      "Design,Eve Lu,Designer,",
    ]);
    assert.deepEqual(await part("-executive.csv"), ["Group,Name,Title,Section head of", "Executive,Jane Smith,COO,Engineering; Design"]);
    // Section heads first off: each file is its members alone.
    const off = await JSZip.loadAsync((await run.renderExportFile({ preset: zipPreset({ section_heads: false }), format: "csv", people, fields })).body);
    const eng = Object.keys(off.files).find((n) => n.endsWith("-engineering.csv"))!;
    assert.deepEqual((await off.files[eng].async("string")).replace(/^﻿/, "").trim().split("\r\n").slice(1), [
      "Engineering,Bob Ames,Engineer,",
      "Engineering,Dee Park,Engineer,",
    ]);
    // The PDF zip renders every part.
    const pdfs = await run.renderExportFile({ preset: zipPreset(), format: "pdf", people, fields });
    assert.equal(pdfs.parts, 4);
    const pdfZip = await JSZip.loadAsync(pdfs.body);
    for (const name of Object.keys(pdfZip.files)) {
      assert.equal((await pdfZip.files[name].async("nodebuffer")).subarray(0, 5).toString("latin1"), "%PDF-", name);
    }
  });

  test("the vCard: one card per person where their own value puts them, so the file is the one it was before sections had heads; a head of their own section keeps exactly one card", async () => {
    const one = (p: ExportPreset, registry = fields) => vcf.renderDirectoryVcf({ preset: p, people, fields: registry, company: "Acme", origin: "" });
    const withHeads = await one(sanitizePreset({ id: "vcf", name: "Cards", columns: ["name", "title"], group_by: "department", office_info: false, logo: false }, fields));
    const without = await one(sanitizePreset({ id: "vcf", name: "Cards", columns: ["name", "title"], group_by: "department", office_info: false, logo: false }, headless), headless);
    assert.equal(withHeads, without);
    assert.equal((withHeads.match(/BEGIN:VCARD/g) ?? []).length, 6, "one card per person");
    assert.equal((withHeads.match(/FN:Cy Vance\r?\n/g) ?? []).length, 1, "Cy heads the section he sits in: one card");
    assert.equal((withHeads.match(/FN:Jane Smith\r?\n/g) ?? []).length, 1, "Jane heads two sections and sits in a third: one card");
  });
});
