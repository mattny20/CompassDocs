// First-/last-name sorting, assistant details in the export, the preset keys
// added in 1.11.1 (column limits, assistant fields, margins) and a smoke test
// of the PDF and CSV renderers.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/directory-name-sort.test.ts
// (needs no DATABASE_URL: nothing here reads the settings store).

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import {
  NAME_SORT_KEYS,
  assistantDetailKeys,
  assistantText,
  availableColumns,
  cellValue,
  columnLabel,
  compareByKeys,
  initialsOf,
  nameParts,
  nameSortKey,
  sortableKeys,
} from "../src/lib/directory-display";
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

const fields: DirectoryField[] = [
  field({ key: "title", label: "Title", builtin: 1 }),
  field({ key: "department", label: "Department", builtin: 1, group_by: 1 }),
  field({ key: "office", label: "Office", builtin: 1, group_by: 1, options: [{ value: "PHX1", label: "Phoenix" }, { value: "TUC", label: "Tucson" }], value_format: "label" }),
  field({ key: "assistant", label: "Assistant", kind: "people", builtin: 1, inverse_label: "Assists" }),
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

const lee = person(3, "Pat Lee", { title: "Legal Assistant", phone: "602-555-0100", custom: { extension: "x204" } });
const ortiz = person(4, "Sam Ortiz", { title: "Paralegal", custom: { extension: "x210" } });
const people: DirectoryPerson[] = [
  person(1, "Smith, Jane", { title: "Managing Partner of Litigation", phone: "602-555-0001", office: "PHX1", links: { assistant: [{ id: 3, name: "Pat Lee" }] } }),
  person(2, "Adam Zimmer", { title: "Associate", phone: "602-555-0002", office: "TUC", links: { assistant: [{ id: 3, name: "Pat Lee" }, { id: 4, name: "Sam Ortiz" }] } }),
  lee,
  ortiz,
  person(5, "Ludwig van Beethoven", { title: "Composer", office: "PHX1", links: { assistant: [{ id: 99, name: "Ghost Writer" }] } }),
  person(6, "Dr. Bob Adams Jr.", { title: "Of Counsel", office: "TUC" }),
];
const byId = new Map(people.map((p) => [p.id, p]));

// --- Names ---------------------------------------------------------------------

describe("nameParts", () => {
  test("Western and comma-first names split into first and last", () => {
    assert.deepEqual(nameParts("Smith, Jane A."), { first: "Jane", last: "Smith" });
    assert.deepEqual(nameParts("Jane Smith"), { first: "Jane", last: "Smith" });
    assert.deepEqual(nameParts("Jane Marie Smith"), { first: "Jane", last: "Smith" });
    assert.deepEqual(nameParts("Mary-Kate Olsen-Day"), { first: "Mary-Kate", last: "Olsen-Day" });
  });

  test("honorifics, suffixes and trailing credentials are dropped, as initialsOf drops them", () => {
    assert.deepEqual(nameParts("Dr. Jane A. Smith Jr."), { first: "Jane", last: "Smith" });
    assert.deepEqual(nameParts("Mr. Bob Adams III"), { first: "Bob", last: "Adams" });
    assert.deepEqual(nameParts("Jane Smith, PhD"), { first: "Jane", last: "Smith" });
    assert.deepEqual(nameParts("Jane Smith PhD"), { first: "Jane", last: "Smith" });
    assert.deepEqual(nameParts("Jane Smith MD PhD"), { first: "Jane", last: "Smith" });
    assert.deepEqual(nameParts("Smith, Jr."), { first: "Smith", last: "Smith" });
  });

  test("a credential comes off the end only: a given name that spells one is kept", () => {
    assert.deepEqual(nameParts("JD Vance"), { first: "JD", last: "Vance" });
    assert.deepEqual(nameParts("Vance, JD"), { first: "JD", last: "Vance" });
    assert.deepEqual(nameParts("Md Rahman"), { first: "Md", last: "Rahman" });
    assert.deepEqual(nameParts("JD Vance JD"), { first: "JD", last: "Vance" });
    // A lone credential is a name, not nothing.
    assert.deepEqual(nameParts("MD"), { first: "MD", last: "MD" });
    assert.equal(initialsOf("JD Vance"), "JV");
  });

  test("a particle surname keeps its particles, but a two-word name never loses its first word", () => {
    assert.deepEqual(nameParts("Ludwig van Beethoven"), { first: "Ludwig", last: "van Beethoven" });
    assert.deepEqual(nameParts("Oscar De La Hoya"), { first: "Oscar", last: "De La Hoya" });
    assert.deepEqual(nameParts("Ana Maria da Silva"), { first: "Ana", last: "da Silva" });
    assert.deepEqual(nameParts("Van Morrison"), { first: "Van", last: "Morrison" });
  });

  test("a single word is both; an empty name is neither", () => {
    assert.deepEqual(nameParts("Cher"), { first: "Cher", last: "Cher" });
    assert.deepEqual(nameParts("  "), { first: "", last: "" });
    assert.deepEqual(nameParts(""), { first: "", last: "" });
  });

  test("initialsOf is unchanged by sharing the word split", () => {
    assert.equal(initialsOf("Smith, Jane"), "JS");
    assert.equal(initialsOf("Jane Marie Smith"), "JM");
    assert.equal(initialsOf("Dr. Jane Smith"), "JS");
    assert.equal(initialsOf("Smith, Jr."), "S");
    assert.equal(initialsOf(""), "");
  });
});

describe("name sort keys", () => {
  test("cellValue answers the part for the virtual keys, so compareOnKey needs no special case", () => {
    const p = person(9, "Smith, Jane A.");
    assert.equal(cellValue(p, "name:first", fields), "Jane");
    assert.equal(cellValue(p, "name:last", fields), "Smith");
    assert.equal(cellValue(p, "name", fields), "Smith, Jane A.");
  });

  test("the keys have labels, sit right after Name among the sortable keys, and are never columns", () => {
    assert.deepEqual(NAME_SORT_KEYS.map((k) => k.key), ["name:first", "name:last"]);
    assert.equal(columnLabel("name:first", fields), "First name");
    assert.equal(columnLabel("name:last", fields), "Last name");
    const sortable = sortableKeys(fields);
    assert.deepEqual(sortable.slice(0, 4).map((k) => k.key), ["name", "name:first", "name:last", "title"]);
    assert.deepEqual(sortable.slice(3), availableColumns(fields).slice(1));
    assert.ok(!availableColumns(fields).some((c) => c.key.startsWith("name:")));
  });

  test("nameSortKey maps the page's mode to the key", () => {
    assert.equal(nameSortKey("full"), "name");
    assert.equal(nameSortKey("first"), "name:first");
    assert.equal(nameSortKey("last"), "name:last");
  });

  test("sorting by last name orders by the surname, the full name breaking ties", () => {
    const byLast = [...people].sort(compareByKeys(fields, [{ key: "name:last", dir: 1 }]));
    assert.deepEqual(
      byLast.map((p) => p.name),
      ["Dr. Bob Adams Jr.", "Pat Lee", "Sam Ortiz", "Smith, Jane", "Ludwig van Beethoven", "Adam Zimmer"]
    );
    const twoSmiths = [person(1, "Smith, Jane"), person(2, "Adam Smith"), person(3, "Zed Able")];
    const asc = [...twoSmiths].sort(compareByKeys(fields, [{ key: "name:last", dir: 1 }]));
    assert.deepEqual(asc.map((p) => p.name), ["Zed Able", "Adam Smith", "Smith, Jane"], "Able first; the Smiths tie on surname and fall back to the full name");
    const desc = [...twoSmiths].sort(compareByKeys(fields, [{ key: "name:last", dir: -1 }]));
    assert.deepEqual(desc.map((p) => p.name), ["Smith, Jane", "Adam Smith", "Zed Able"]);
  });

  test("sorting by first name orders by the given name", () => {
    const byFirst = [...people].sort(compareByKeys(fields, [{ key: "name:first", dir: 1 }]));
    assert.deepEqual(
      byFirst.map((p) => p.name),
      ["Adam Zimmer", "Dr. Bob Adams Jr.", "Smith, Jane", "Ludwig van Beethoven", "Pat Lee", "Sam Ortiz"]
    );
  });

  test("a name key works as the second key after a field with options", () => {
    const sorted = [...people].sort(compareByKeys(fields, [{ key: "office", dir: 1 }, { key: "name:last", dir: 1 }]));
    assert.deepEqual(
      sorted.map((p) => p.name),
      ["Smith, Jane", "Ludwig van Beethoven", "Dr. Bob Adams Jr.", "Adam Zimmer", "Pat Lee", "Sam Ortiz"],
      "Phoenix then Tucson in option order, by surname within each; no office last"
    );
  });
});

// --- Assistants ----------------------------------------------------------------

describe("assistantText", () => {
  test("each assistant's name followed by the chosen details, blanks skipped, several assistants joined with a semicolon", () => {
    assert.equal(assistantText(people[0], fields, byId, ["phone", "extension"]), "Pat Lee · 602-555-0100 · x204");
    assert.equal(assistantText(people[1], fields, byId, ["phone", "extension"]), "Pat Lee · 602-555-0100 · x204; Sam Ortiz · x210");
    assert.equal(assistantText(people[1], fields, byId, ["extension", "title"]), "Pat Lee · x204 · Legal Assistant; Sam Ortiz · x210 · Paralegal");
  });

  test("an assistant outside the list shows the name alone; no assistant is an empty cell; no fields is the names", () => {
    assert.equal(assistantText(people[4], fields, byId, ["phone"]), "Ghost Writer");
    assert.equal(assistantText(people[5], fields, byId, ["phone"]), "");
    assert.equal(assistantText(people[1], fields, byId, []), "Pat Lee; Sam Ortiz");
  });

  test("assistantDetailKeys offers every column but the name and the link columns", () => {
    const keys = assistantDetailKeys(fields).map((c) => c.key);
    assert.deepEqual(keys, ["title", "department", "email", "phone", "mobile", "office", "extension"]);
  });
});

// --- Presets -------------------------------------------------------------------

describe("sanitizePreset", () => {
  test("a preset stored before 1.11.1 sanitizes to the defaults for the new keys", () => {
    const legacy = sanitizePreset({ id: "phone-directory", name: "Phone directory", columns: ["name", "phone"], sort: "name" }, fields);
    assert.deepEqual(legacy.column_limits, {});
    assert.deepEqual(legacy.assistant_fields, []);
    assert.equal(legacy.margins, "normal");
    assert.deepEqual(legacy.margin_custom, { top: 0.5, right: 0.5, bottom: 0.6, left: 0.5 });
    assert.deepEqual(legacy.margin_custom, PRESET_DEFAULTS.margin_custom);
    assert.equal(legacy.sort, "name");
  });

  test("column limits keep the preset's own columns only, as whole numbers from 8 to 120; 0 and junk mean automatic", () => {
    const p = sanitizePreset(
      {
        name: "x",
        columns: ["name", "title", "phone", "email", "office", "extension"],
        column_limits: { title: 20.4, bogus: 30, phone: 200, email: 3, office: 0, name: "15", extension: "wide", assists: -4 },
      },
      fields
    );
    assert.deepEqual(p.column_limits, { title: 20, phone: 120, email: 8, name: 15 });
    // A limit for a column the preset does not show is dropped: removing a
    // column and adding it back later starts it automatic, and a "what I
    // see" export carries no limit for a column it does not print.
    assert.deepEqual(sanitizePreset({ name: "x", columns: ["name", "phone"], column_limits: { title: 20, phone: 30 } }, fields).column_limits, { phone: 30 });
    assert.deepEqual(sanitizePreset({ name: "x", columns: [], column_limits: { name: 20, title: 20 } }, fields).column_limits, { name: 20 }, "an empty column list is the name column");
    assert.deepEqual(sanitizePreset({ name: "x", column_limits: { department: 20, office: 20 } }, fields).column_limits, { department: 20 }, "the default columns scope a preset that names none");
    assert.deepEqual(sanitizePreset({ name: "x", column_limits: ["title"] }, fields).column_limits, {});
    assert.deepEqual(sanitizePreset({ name: "x", column_limits: "title=20" }, fields).column_limits, {});
  });

  test("assistant fields are filtered to detail keys and deduplicated", () => {
    const p = sanitizePreset({ name: "x", assistant_fields: ["phone", "name", "assists", "assistant", "extension", "phone", "nope", "title"] }, fields);
    assert.deepEqual(p.assistant_fields, ["phone", "extension", "title"]);
    assert.deepEqual(sanitizePreset({ name: "x", assistant_fields: "phone" }, fields).assistant_fields, []);
  });

  test("margins are one of the four, and custom inches are clamped to 0.2–2.0 at one decimal with a missing side keeping its default", () => {
    assert.equal(sanitizePreset({ name: "x", margins: "wide" }, fields).margins, "wide");
    assert.equal(sanitizePreset({ name: "x", margins: "narrow" }, fields).margins, "narrow");
    assert.equal(sanitizePreset({ name: "x", margins: "huge" }, fields).margins, "normal");
    const custom = sanitizePreset({ name: "x", margins: "custom", margin_custom: { top: 3, right: 0.05, bottom: "0.75", left: "x" } }, fields);
    assert.equal(custom.margins, "custom");
    assert.deepEqual(custom.margin_custom, { top: 2, right: 0.2, bottom: 0.8, left: 0.5 });
    const blank = sanitizePreset({ name: "x", margins: "custom", margin_custom: { top: "", bottom: null } }, fields);
    assert.deepEqual(blank.margin_custom, { top: 0.5, right: 0.5, bottom: 0.6, left: 0.5 });
    assert.deepEqual(sanitizePreset({ name: "x", margin_custom: "1,1,1,1" }, fields).margin_custom, PRESET_DEFAULTS.margin_custom);
  });

  test("the name keys are accepted as sort and then-by, never as columns", () => {
    const p = sanitizePreset({ name: "x", sort: "name:last", sort2: "name:first", columns: ["name:first", "name", "name:last", "phone"] }, fields);
    assert.equal(p.sort, "name:last");
    assert.equal(p.sort2, "name:first");
    assert.deepEqual(p.columns, ["name", "phone"]);
    assert.equal(sanitizePreset({ name: "x", sort: "name:middle" }, fields).sort, "name");
    assert.equal(sanitizePreset({ name: "x", sort: "name:last", sort2: "name:last" }, fields).sort2, "", "a repeated key is dropped");
  });

  test("sanitizing is stable: a sanitized preset sanitizes to itself", () => {
    const once = sanitizePreset(
      { name: "Stable", columns: ["name", "assistant"], column_limits: { name: 14 }, assistant_fields: ["phone"], margins: "custom", margin_custom: { top: 1, right: 0.3, bottom: 1.1, left: 0.3 }, sort: "name:first" },
      fields
    );
    assert.deepEqual(sanitizePreset(once, fields), once);
  });
});

// --- The renderer --------------------------------------------------------------

describe("PDF and CSV", () => {
  let exporter: typeof import("../src/lib/directory-export");
  before(async () => {
    exporter = await import("../src/lib/directory-export");
  });

  const preset = () =>
    sanitizePreset(
      {
        id: "smoke",
        name: "Smoke",
        columns: ["name", "title", "assistant", "phone"],
        column_limits: { title: 12 },
        assistant_fields: ["phone", "extension"],
        margins: "custom",
        margin_custom: { top: 1, right: 0.75, bottom: 1, left: 0.75 },
        sort: "name:last",
        office_info: false,
        logo: false,
      },
      fields
    );

  test("prepareExport carries the limits and renders the assistant column with its details", () => {
    const prepared = exporter.prepareExport({ preset: preset(), people, fields, company: "Acme" });
    assert.deepEqual(
      prepared.columns.map((c) => [c.key, c.limit]),
      [["name", 0], ["title", 12], ["assistant", 0], ["phone", 0]]
    );
    assert.equal(prepared.cell(people[0], "assistant"), "Pat Lee · 602-555-0100 · x204");
    assert.equal(prepared.cell(people[0], "title"), "Managing Partner of Litigation");
    assert.deepEqual(prepared.sections[0].rows.map((p) => p.name), ["Dr. Bob Adams Jr.", "Pat Lee", "Sam Ortiz", "Smith, Jane", "Ludwig van Beethoven", "Adam Zimmer"]);
    // No assistant fields: the cell is the names, as it always was.
    const plain = exporter.prepareExport({ preset: { ...preset(), assistant_fields: [] }, people, fields, company: "Acme" });
    assert.equal(plain.cell(people[1], "assistant"), "Pat Lee, Sam Ortiz");
    assert.equal(plain.cell(people[0], "assistant"), cellValue(people[0], "assistant", fields));
  });

  test("assistant details come from the lookup, so an export of the people on screen still shows an assistant who is off it", () => {
    const smith = people[0];
    // Only Smith is exported (a "what I see" export of one row); without a
    // lookup her assistant is not in the list and shows the name alone.
    const alone = exporter.prepareExport({ preset: preset(), people: [smith], fields, company: "Acme" });
    assert.equal(alone.cell(smith, "assistant"), "Pat Lee");
    const looked = exporter.prepareExport({ preset: preset(), people: [smith], lookup: [smith, lee], fields, company: "Acme" });
    assert.equal(looked.cell(smith, "assistant"), "Pat Lee · 602-555-0100 · x204");
    assert.deepEqual(looked.sections[0].rows.map((p) => p.id), [smith.id], "the lookup adds no rows");
    assert.equal(looked.total, 1);
    // The CSV reads the same lookup; the route passes everyone the viewer may see.
    const csv = exporter.renderDirectoryCsv({ preset: preset(), people: [smith], lookup: people, fields, company: "Acme" });
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1], '"Smith, Jane",Managing Partner of Litigation,Pat Lee · 602-555-0100 · x204,602-555-0001');
  });

  test("the CSV shows the assistant fields and follows the last-name sort", () => {
    const csv = exporter.renderDirectoryCsv({ preset: preset(), people, fields, company: "Acme" });
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(lines[0], "Name,Title,Assistant,Phone");
    assert.equal(lines[1], "Dr. Bob Adams Jr.,Of Counsel,,");
    assert.equal(lines[4], '"Smith, Jane",Managing Partner of Litigation,Pat Lee · 602-555-0100 · x204,602-555-0001');
    assert.equal(lines[6], "Adam Zimmer,Associate,Pat Lee · 602-555-0100 · x204; Sam Ortiz · x210,602-555-0002");
    assert.equal(lines[5], "Ludwig van Beethoven,Composer,Ghost Writer,");
  });

  /**
   * A PDF's bytes with pdfkit's clock taken out: the Info and XMP creation
   * dates and the file id derived from them, all fixed-width so nothing
   * else moves. What is left is the layout, the same every run.
   */
  const stable = (pdf: Buffer): string =>
    pdf
      .toString("latin1")
      .replace(/\(D:\d{14}Z\)/g, "(D:)")
      .replace(/<xmp:CreateDate>[^<]*<\/xmp:CreateDate>/g, "")
      .replace(/\/ID \[[^\]]*\]/g, "");

  test("the PDF renders with a limited column and custom margins, one column and three to a page, and each of the two changes the page", async () => {
    const render = (patch: Partial<ExportPreset> = {}) =>
      exporter.renderDirectoryPdf({ preset: { ...preset(), ...patch }, people, fields, company: "Acme", logo: null, printedOn: "Oct 19, 2026" });
    const one = await render();
    assert.ok(Buffer.isBuffer(one));
    assert.equal(one.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(one.length > 1000, `pdf is ${one.length} bytes`);
    // Apart from its clock a render is deterministic: the same preset gives
    // the same bytes, and a preset that differs only in its limits, or only
    // in its margins, gives different ones, so the renderer reads both.
    assert.equal(stable(one), stable(await render()), "two renders of one preset agree once the clock is taken out");
    assert.notEqual(stable(one), stable(await render({ column_limits: {} })), "the column limit changes the page");
    assert.notEqual(stable(one), stable(await render({ margins: "normal" })), "the custom margins change the page");
    const threeUp = { page_columns: 3 as const, margins: "narrow" as const, column_limits: { title: 8, name: 10 } };
    const three = await render(threeUp);
    assert.equal(three.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.notEqual(stable(three), stable(await render({ ...threeUp, column_limits: {} })), "the limits change the three-column plan");
    assert.notEqual(stable(three), stable(await render({ ...threeUp, margins: "wide" })), "the margins change the three-column plan");
  });
});
