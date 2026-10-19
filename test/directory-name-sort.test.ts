// First-/last-name sorting, assistant details in the export, the preset keys
// added in 1.11.1 (column limits, assistant fields, margins), the export
// markers and name formats of 1.11.2, and a smoke test of the PDF and CSV
// renderers.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/directory-name-sort.test.ts
// (needs no DATABASE_URL: nothing here reads the settings store).

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import {
  NAME_FORMATS,
  NAME_SORT_KEYS,
  assistantDetailKeys,
  assistantText,
  availableColumns,
  cellValue,
  columnLabel,
  compareByKeys,
  formatName,
  initialsOf,
  matchesValue,
  nameParts,
  nameSortKey,
  sortableKeys,
} from "../src/lib/directory-display";
import {
  MARKER_SYMBOLS,
  markerFields,
  markerKeyLine,
  markerPrefix,
  markerProblem,
  markersFor,
  markersForViewer,
  markersProblem,
  printableSymbol,
  sanitizeMarkers,
  type ExportMarker,
} from "../src/lib/directory-marker-rules";
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

// The workspace's markers: Lee earns the notary's (extension x204); Smith and
// Beethoven the Phoenix office's (PHX1, matched by the option's label).
const NOTARY: ExportMarker = { id: "notary", label: "Public notary", symbol: "*", key: "extension", value: "x204" };
const PHOENIX: ExportMarker = { id: "phoenix", label: "Phoenix office", symbol: "†", key: "office", value: "phoenix" };
const ANY_EXT: ExportMarker = { id: "ext", label: "Has an extension", symbol: "¹", key: "extension", value: "" };
const MARKS: ExportMarker[] = [NOTARY, PHOENIX, ANY_EXT];

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

describe("formatName", () => {
  test("the six formats are built on nameParts, so every spelling of a name formats the same", () => {
    for (const n of ["Smith, Jane A.", "Jane A. Smith", "Dr. Jane A. Smith Jr.", "Jane Smith, PhD"]) {
      assert.equal(formatName(n, "first_last"), "Jane Smith", n);
      assert.equal(formatName(n, "last_first"), "Smith, Jane", n);
      assert.equal(formatName(n, "first_last_initial"), "Jane S.", n);
      assert.equal(formatName(n, "last_first_initial"), "Smith, J.", n);
      assert.equal(formatName(n, "first_initial_last"), "J. Smith", n);
    }
    assert.equal(formatName("Smith, Jane A.", "as_written"), "Smith, Jane A.");
    assert.equal(formatName("  Smith, Jane A. ", "as_written"), "Smith, Jane A.", "as written is the name untouched, trimmed");
    assert.deepEqual(
      NAME_FORMATS.map((f) => f.key),
      ["as_written", "first_last", "last_first", "first_last_initial", "last_first_initial", "first_initial_last"]
    );
    assert.ok(NAME_FORMATS.every((f) => f.label.length > 0));
  });

  test("a particle surname rides whole, its initial is the surname proper's, an initial carries a full stop, and a single word prints as it is in every format", () => {
    assert.equal(formatName("Ludwig van Beethoven", "last_first"), "van Beethoven, Ludwig");
    assert.equal(formatName("Ludwig van Beethoven", "first_initial_last"), "L. van Beethoven");
    assert.equal(formatName("Ludwig van Beethoven", "first_last_initial"), "Ludwig B.", "the particle's letter names no one");
    assert.equal(formatName("Oscar De La Hoya", "first_initial_last"), "O. De La Hoya");
    assert.equal(formatName("Oscar De La Hoya", "first_last_initial"), "Oscar H.");
    assert.equal(formatName("de la Cruz, Maria", "first_last_initial"), "Maria C.");
    assert.equal(formatName("de la Cruz, Maria", "last_first_initial"), "de la Cruz, M.", "the surname itself still rides whole");
    assert.equal(formatName("Van Morrison", "first_last_initial"), "Van M.", "a two-word name never loses its first word");
    assert.equal(formatName("Mary-Kate Olsen-Day", "first_last_initial"), "Mary-Kate O.");
    assert.equal(formatName("JD Vance", "last_first_initial"), "Vance, J.");
    for (const format of NAME_FORMATS.map((f) => f.key)) {
      assert.equal(formatName("Cher", format), "Cher", format);
      assert.equal(formatName("Smith, Jr.", format), "Smith, Jr.", `a surname and a suffix is one word: ${format}`);
      assert.equal(formatName("MD", format), "MD", format);
      assert.equal(formatName("", format), "", format);
      assert.equal(formatName("   ", format), "", format);
    }
  });
});

// --- Markers -------------------------------------------------------------------

describe("markers", () => {
  test("markersFor and markerPrefix: matched as the export filter matches, in the markers' order; a blank value is any value", () => {
    assert.deepEqual(markersFor(lee, MARKS, fields).map((m) => m.id), ["notary", "ext"]);
    assert.equal(markerPrefix(lee, MARKS, fields), "*¹");
    assert.equal(markerPrefix(people[0], MARKS, fields), "†", "Smith: PHX1 is Phoenix by its label");
    assert.equal(markerPrefix(ortiz, MARKS, fields), "¹");
    assert.equal(markerPrefix(people[5], MARKS, fields), "", "Adams: Tucson, no extension");
    assert.deepEqual(markersFor(people[5], MARKS, fields), []);
    // The option's code and its label both match, case-insensitively; a prefix does not.
    assert.equal(markerPrefix(people[0], [{ ...PHOENIX, value: "phx1" }], fields), "†");
    assert.equal(markerPrefix(people[0], [{ ...PHOENIX, value: "PHOENIX" }], fields), "†");
    assert.equal(markerPrefix(people[0], [{ ...PHOENIX, value: "PHX" }], fields), "");
    // The same rule the filter keeps.
    assert.equal(matchesValue(people[0], "office", "Phoenix", fields), true);
    assert.equal(matchesValue(people[0], "office", "Tucson", fields), false);
    assert.equal(matchesValue(people[0], "assistant", "pat lee", fields), true, "a people field matches a linked name");
  });

  test("a multi-valued field matches on any of its values", () => {
    const certs = field({ key: "certs", label: "Certifications", multi: 1, options: [{ value: "NOTARY", label: "Notary public" }, { value: "CPR" }], value_format: "label" });
    const all = [...fields, certs];
    const p = person(7, "Multi Person", { custom: { certs: "CPR, notary" } });
    assert.equal(markerPrefix(p, [{ id: "n", label: "Notary", symbol: "*", key: "certs", value: "Notary public" }], all), "*");
    assert.equal(markerPrefix(p, [{ id: "c", label: "CPR", symbol: "+", key: "certs", value: "cpr" }], all), "+");
    assert.equal(markerPrefix(p, [{ id: "f", label: "First aid", symbol: "‡", key: "certs", value: "first aid" }], all), "");
    assert.equal(markerPrefix(p, [{ id: "a", label: "Any", symbol: "°", key: "certs", value: "" }], all), "°");
    assert.equal(markerPrefix(people[5], [{ id: "a", label: "Any", symbol: "°", key: "certs", value: "" }], all), "");
  });

  test("markerKeyLine is the footer's key, symbol then label, dotted apart", () => {
    assert.equal(markerKeyLine(MARKS), "* Public notary  ·  † Phoenix office  ·  ¹ Has an extension");
    assert.equal(markerKeyLine([NOTARY]), "* Public notary");
    assert.equal(markerKeyLine([]), "");
  });

  test("markerFields offers every column but the name and the link columns", () => {
    assert.deepEqual(markerFields(fields).map((f) => f.key), ["title", "department", "email", "phone", "mobile", "office", "extension"]);
    assert.equal(markerFields(fields).find((f) => f.key === "office")?.label, "Office");
  });

  test("the WinAnsi rule: ASCII, the Latin-1 symbols and accented letters print; anything else does not", () => {
    for (const s of MARKER_SYMBOLS) assert.ok(printableSymbol(s), s);
    for (const s of ["ª", "º", "‰", "©", "®", "™", "¿", "¡", "«", "»", "é", "Ñ", "ß", "ÿ", "A1", "#!", "~", "^", "°F"]) assert.ok(printableSymbol(s), s);
    for (const s of ["★", "✓", "→", "☆", "Ω", "😀", "*★", "†→"]) assert.ok(!printableSymbol(s), s);
    assert.ok(printableSymbol(""), "nothing to print is nothing unprintable (the length rule refuses it)");
  });

  test("sanitizeMarkers: at most 24; a label of 1..40; a symbol of 1..3 printable characters; an eligible field; unique slug ids", () => {
    const out = sanitizeMarkers(
      [
        { id: "notary", label: "Public notary", symbol: "*", key: "extension", value: "x204" },
        { label: "Partner", symbol: "†", key: "title", value: "Partner" },
        { label: "Partner", symbol: "‡", key: "title", value: "Of Counsel" },
        { label: "", symbol: "*", key: "title", value: "" },
        { label: "Star", symbol: "★", key: "title", value: "" },
        { label: "Long", symbol: "****", key: "title", value: "" },
        { label: "Blank", symbol: "   ", key: "title", value: "" },
        { label: "Name", symbol: "*", key: "name", value: "" },
        { label: "Link", symbol: "*", key: "assistant", value: "" },
        { label: "Inverse", symbol: "*", key: "assists", value: "" },
        { label: "Bogus", symbol: "*", key: "nope", value: "" },
        { label: "x".repeat(50), symbol: "°", key: "office", value: "y".repeat(130) },
        { id: "Keep This", label: "Accents", symbol: " é§ ", key: "department", value: " Legal " },
        "junk",
        null,
      ],
      fields
    );
    assert.deepEqual(
      out.map((m) => m.id),
      ["notary", "partner", "partner-2", "x".repeat(40), "keep-this"],
      "a stored id is kept (slugged), a new one comes from the label, a repeat is suffixed"
    );
    assert.deepEqual(out[1], { id: "partner", label: "Partner", symbol: "†", key: "title", value: "Partner" });
    assert.equal(out[3].label, "x".repeat(40));
    assert.equal(out[3].value, "y".repeat(120));
    assert.deepEqual(out[4], { id: "keep-this", label: "Accents", symbol: "é§", key: "department", value: "Legal" });
    assert.deepEqual(sanitizeMarkers("nope", fields), []);
    assert.deepEqual(sanitizeMarkers({ markers: [] }, fields), []);
    assert.equal(sanitizeMarkers(Array.from({ length: 30 }, (_, i) => ({ label: `M${i}`, symbol: "*", key: "title" })), fields).length, 24);
    // Stable: a sanitized set sanitizes to itself.
    assert.deepEqual(sanitizeMarkers(out, fields), out);
  });

  test("ids are assigned in two passes: a stored id is reserved before any new marker's label can take it, wherever it sits", () => {
    // The new "Notary" comes first in the list, but "notary" belongs to the
    // stored marker presets refer to: the new one is the one suffixed.
    const ahead = sanitizeMarkers(
      [
        { label: "Notary", symbol: "*", key: "title", value: "" },
        { id: "notary", label: "Public notary", symbol: "†", key: "extension", value: "x204" },
      ],
      fields
    );
    assert.deepEqual(ahead.map((m) => m.id), ["notary-2", "notary"]);
    assert.deepEqual(ahead[1], { id: "notary", label: "Public notary", symbol: "†", key: "extension", value: "x204" });
    // A stored id given twice keeps its first holder; the repeats (and a
    // new marker whose label slugs to it) are named as new markers are.
    const twice = sanitizeMarkers(
      [
        { id: "dup", label: "Dup A", symbol: "*", key: "title", value: "" },
        { id: "dup", label: "Dup B", symbol: "†", key: "title", value: "" },
        { id: "DUP", label: "Dup C", symbol: "‡", key: "title", value: "" },
        { label: "dup", symbol: "§", key: "title", value: "" },
      ],
      fields
    );
    assert.deepEqual(twice.map((m) => m.id), ["dup", "dup-b", "dup-c", "dup-2"]);
    assert.deepEqual(sanitizeMarkers(twice, fields), twice, "and the result is stable");
  });

  test("markerProblem names the first thing wrong the way the route refuses it; markersProblem the first of a list", () => {
    const keys = new Set(["title", "office", "extension"]);
    assert.equal(markerProblem({ label: "", symbol: "*", key: "title" }, 0, keys)?.message, "Marker 1: give it a name.");
    assert.equal(markerProblem({ label: "  ", symbol: "*", key: "title" }, 2, keys)?.field, "label");
    assert.equal(markerProblem({ label: "Public notary", symbol: "★", key: "title" }, 0, keys)?.message, 'Marker "Public notary": the symbol "★" cannot be printed.');
    assert.equal(markerProblem({ label: "Public notary", symbol: "", key: "title" }, 0, keys)?.message, 'Marker "Public notary": pick a symbol.');
    assert.equal(markerProblem({ label: "Public notary", symbol: "****", key: "title" }, 0, keys)?.message, 'Marker "Public notary": the symbol is longer than 3 characters.');
    assert.equal(markerProblem({ label: "Public notary", symbol: "*", key: "name" }, 0, keys)?.message, 'Marker "Public notary": pick a field.');
    assert.equal(markerProblem({ label: "Public notary", symbol: "*", key: "" }, 0, keys)?.field, "key");
    assert.equal(markerProblem({ label: "Public notary", symbol: "*", key: "title", value: "v".repeat(121) }, 0, keys)?.message, 'Marker "Public notary": the value is longer than 120 characters.');
    assert.equal(markerProblem({ label: "x".repeat(41), symbol: "*", key: "title" }, 0, keys)?.field, "label");
    assert.equal(markerProblem({ label: "Public notary", symbol: "*", key: "title", value: "" }, 0, keys), undefined);
    assert.equal(markerProblem({ label: "Public notary", symbol: "¹²³", key: "extension", value: "x204" }, 0, keys), undefined);
    assert.equal(markersProblem([{ label: "Public notary", symbol: "*", key: "title" }], fields), undefined);
    assert.equal(markersProblem([{ label: "Public notary", symbol: "*", key: "title" }, { label: "Star", symbol: "★", key: "title" }], fields), 'Marker "Star": the symbol "★" cannot be printed.');
    assert.equal(markersProblem(Array.from({ length: 25 }, () => ({ label: "a", symbol: "*", key: "title" })), fields), "Up to 24 markers.");
    assert.equal(markersProblem("x", fields), "Send the markers as a list.");
    assert.equal(markersProblem([], fields), undefined);
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

  test("markers and name_format: a preset stored before 1.11.2 gets none and as_written; ids are checked against the store when it is given", () => {
    const legacy = sanitizePreset({ id: "phone-directory", name: "Phone directory", columns: ["name", "phone"], sort: "name" }, fields);
    assert.deepEqual(legacy.markers, []);
    assert.equal(legacy.name_format, "as_written");
    assert.deepEqual(PRESET_DEFAULTS.markers, []);
    assert.equal(PRESET_DEFAULTS.name_format, "as_written");
    const loose = sanitizePreset({ name: "x", markers: ["notary", "notary", " ", "bogus"], name_format: "last_first_initial" }, fields);
    assert.deepEqual(loose.markers, ["notary", "bogus"], "without the store, any non-blank id is kept once");
    assert.equal(loose.name_format, "last_first_initial");
    const checked = sanitizePreset({ name: "x", markers: ["notary", "bogus"], name_format: "nope" }, fields, "p", new Set(["notary", "partner"]));
    assert.deepEqual(checked.markers, ["notary"]);
    assert.equal(checked.name_format, "as_written");
    assert.deepEqual(sanitizePreset({ name: "x", markers: "notary" }, fields).markers, []);
    assert.deepEqual(sanitizePreset({ name: "x", markers: [1, 2] }, fields).markers, ["1", "2"]);
    for (const key of NAME_FORMATS.map((f) => f.key)) assert.equal(sanitizePreset({ name: "x", name_format: key }, fields).name_format, key);
  });

  test("sanitizing is stable: a sanitized preset sanitizes to itself", () => {
    const once = sanitizePreset(
      { name: "Stable", columns: ["name", "assistant"], column_limits: { name: 14 }, assistant_fields: ["phone"], margins: "custom", margin_custom: { top: 1, right: 0.3, bottom: 1.1, left: 0.3 }, sort: "name:first", markers: ["notary"], name_format: "last_first" },
      fields
    );
    assert.deepEqual(sanitizePreset(once, fields), once);
    assert.deepEqual(sanitizePreset(once, fields, "p", new Set(["notary"])), once);
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

  // --- Markers and name formats (1.11.2) ---

  test("a preset with no markers and no name format renders as it did, whatever markers the workspace has", () => {
    const plain = exporter.prepareExport({ preset: preset(), people, fields, company: "Acme", markers: MARKS });
    assert.deepEqual(plain.markers, []);
    assert.equal(plain.nameFormat, "as_written");
    assert.equal(plain.cell(people[0], "name"), "Smith, Jane");
    assert.equal(plain.cell(lee, "name"), "Pat Lee");
    assert.equal(plain.cell(people[0], "assistant"), "Pat Lee · 602-555-0100 · x204");
    const bare = exporter.prepareExport({ preset: { ...preset(), assistant_fields: [] }, people, fields, company: "Acme", markers: MARKS });
    assert.equal(bare.cell(people[1], "assistant"), "Pat Lee, Sam Ortiz", "the plain assistant column keeps its comma");
    const withStore = exporter.renderDirectoryCsv({ preset: preset(), people, fields, company: "Acme", markers: MARKS });
    const withoutStore = exporter.renderDirectoryCsv({ preset: preset(), people, fields, company: "Acme" });
    assert.equal(withStore, withoutStore);
    assert.ok(!withStore.includes("Markers"), "no Markers column");
  });

  test("markers: the name cell carries the person's symbols, each assistant their own, and the CSV a Markers column", () => {
    const marked = { ...preset(), markers: ["notary", "phoenix"] };
    const prepared = exporter.prepareExport({ preset: marked, people, fields, company: "Acme", markers: MARKS });
    assert.deepEqual(prepared.markers.map((m) => m.id), ["notary", "phoenix"]);
    assert.equal(prepared.cell(people[0], "name"), "† Smith, Jane");
    assert.equal(prepared.cell(lee, "name"), "* Pat Lee");
    assert.equal(prepared.cell(people[5], "name"), "Dr. Bob Adams Jr.", "no mark, no space");
    assert.equal(prepared.cell(people[0], "assistant"), "* Pat Lee · 602-555-0100 · x204", "the assistant's own prefix, from the assistant's own row");
    assert.equal(prepared.cell(people[1], "assistant"), "* Pat Lee · 602-555-0100 · x204; Sam Ortiz · x210");
    assert.equal(prepared.cell(people[4], "assistant"), "Ghost Writer", "an assistant off the lookup has no row to mark from");
    const both = person(8, "Both Marks", { office: "PHX1", custom: { extension: "x204" } });
    assert.equal(prepared.cell(both, "name"), "*† Both Marks", "symbols joined, one space, in the markers' order");
    // The preset's order of ids does not matter; the workspace's order does.
    const reversed = exporter.prepareExport({ preset: { ...marked, markers: ["phoenix", "notary"] }, people, fields, company: "Acme", markers: MARKS });
    assert.deepEqual(reversed.markers.map((m) => m.id), ["notary", "phoenix"]);
    assert.equal(reversed.cell(both, "name"), "*† Both Marks");
    // An id the workspace no longer has prints nothing.
    const ghost = exporter.prepareExport({ preset: { ...marked, markers: ["ghost"] }, people, fields, company: "Acme", markers: MARKS });
    assert.deepEqual(ghost.markers, []);
    assert.equal(ghost.cell(lee, "name"), "Pat Lee");
    // The CSV: the prefix in the name column, the labels in a trailing Markers column, no key.
    const csv = exporter.renderDirectoryCsv({ preset: marked, people, fields, company: "Acme", markers: MARKS });
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(lines.length, 7);
    assert.equal(lines[0], "Name,Title,Assistant,Phone,Markers");
    assert.equal(lines[1], "Dr. Bob Adams Jr.,Of Counsel,,,");
    assert.equal(lines[2], "* Pat Lee,Legal Assistant,,602-555-0100,Public notary");
    assert.equal(lines[4], '"† Smith, Jane",Managing Partner of Litigation,* Pat Lee · 602-555-0100 · x204,602-555-0001,Phoenix office');
    assert.equal(lines[5], "† Ludwig van Beethoven,Composer,Ghost Writer,,Phoenix office");
    assert.equal(lines[6], "Adam Zimmer,Associate,* Pat Lee · 602-555-0100 · x204; Sam Ortiz · x210,602-555-0002,");
    assert.equal(csv.includes("Public notary  ·"), false, "a spreadsheet has no footer for the key");
    const twoLabels = exporter.renderDirectoryCsv({ preset: marked, people: [both], fields, company: "Acme", markers: MARKS });
    assert.ok(twoLabels.includes("*† Both Marks,,,,Public notary; Phoenix office"), twoLabels);
    // A "+" in front of a name is neutralised as a formula would be, as any leading + is.
    const plus = exporter.renderDirectoryCsv({ preset: { ...marked, markers: ["plus"] }, people: [lee], fields, company: "Acme", markers: [{ id: "plus", label: "Plus", symbol: "+", key: "extension", value: "" }] });
    assert.ok(plus.includes("'+ Pat Lee,"), plus);
  });

  test("a marker on a column the viewer may not see goes with the column: absent from the file's markers, its key line and its CSV column", () => {
    // What the export route does for a viewer: the store cut to the
    // viewer's columns before the preset's ids are read against it.
    const MOBILE: ExportMarker = { id: "mob", label: "Mobile on file", symbol: "§", key: "mobile", value: "" };
    const all = [...MARKS, MOBILE];
    const viewer = markersForViewer(all, new Set(["mobile"]));
    assert.deepEqual(viewer.map((m) => m.id), ["notary", "phoenix", "ext"]);
    assert.equal(markersForViewer(all, new Set()), all, "an admin hides nothing and keeps the list as it is");
    const chosen = { ...preset(), markers: ["notary", "mob"] };
    const prepared = exporter.prepareExport({ preset: chosen, people, fields, company: "Acme", markers: viewer });
    assert.deepEqual(prepared.markers.map((m) => m.id), ["notary"]);
    assert.equal(markerKeyLine(prepared.markers), "* Public notary");
    const csv = exporter.renderDirectoryCsv({ preset: chosen, people: [lee], fields, company: "Acme", markers: viewer });
    assert.ok(csv.includes("* Pat Lee"), csv);
    assert.ok(!csv.includes("Mobile on file"), csv);
    // The admin's own export still prints it.
    const admin = exporter.prepareExport({ preset: chosen, people, fields, company: "Acme", markers: all });
    assert.deepEqual(admin.markers.map((m) => m.id), ["notary", "mob"]);
  });

  test("name formats: the name cell and assistant names are rewritten, with the symbols in front; the sort reads the stored names", () => {
    const formatted = { ...preset(), name_format: "last_first_initial" as const, markers: ["notary", "phoenix"] };
    const prepared = exporter.prepareExport({ preset: formatted, people, fields, company: "Acme", markers: MARKS });
    assert.equal(prepared.nameFormat, "last_first_initial");
    assert.equal(prepared.cell(people[0], "name"), "† Smith, J.");
    assert.equal(prepared.cell(people[4], "name"), "† van Beethoven, L.");
    assert.equal(prepared.cell(people[5], "name"), "Adams, B.");
    assert.equal(prepared.cell(people[1], "assistant"), "* Lee, P. · 602-555-0100 · x204; Ortiz, S. · x210");
    assert.equal(prepared.cell(people[4], "assistant"), "Writer, G.", "formatted even off the lookup; no row, no mark");
    assert.deepEqual(
      prepared.sections[0].rows.map((p) => p.name),
      ["Dr. Bob Adams Jr.", "Pat Lee", "Sam Ortiz", "Smith, Jane", "Ludwig van Beethoven", "Adam Zimmer"],
      "the last-name sort is unchanged"
    );
    // A format alone, with no markers and no assistant details: the names are
    // written the new way; assistants are joined with a semicolon, since
    // "Lee, Pat, Ortiz, Sam" would not read.
    const only = exporter.prepareExport({ preset: { ...preset(), name_format: "first_last", assistant_fields: [] }, people, fields, company: "Acme" });
    assert.deepEqual(only.markers, []);
    assert.equal(only.cell(people[0], "name"), "Jane Smith");
    assert.equal(only.cell(people[5], "name"), "Bob Adams");
    assert.equal(only.cell(people[1], "assistant"), "Pat Lee; Sam Ortiz");
    const csv = exporter.renderDirectoryCsv({ preset: formatted, people, fields, company: "Acme", markers: MARKS });
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(lines[1], '"Adams, B.",Of Counsel,,,');
    assert.equal(lines[4], '"† Smith, J.",Managing Partner of Litigation,"* Lee, P. · 602-555-0100 · x204",602-555-0001,Phoenix office');
    const cards = exporter.prepareExport({ preset: { ...formatted, layout: "cards" as const }, people, fields, company: "Acme", markers: MARKS });
    assert.equal(cards.cell(people[0], "name"), "† Smith, J.", "the cards read the same name cell");
  });

  test("the PDF prints the key line: it renders in every layout, differs from the render without markers, and a markerless preset ignores the store", async () => {
    const render = (patch: Partial<ExportPreset> = {}, markers?: ExportMarker[]) =>
      exporter.renderDirectoryPdf({ preset: { ...preset(), ...patch }, people, fields, company: "Acme", logo: null, printedOn: "Oct 19, 2026", markers });
    const chosen = { markers: ["notary", "phoenix"] };
    const marked = await render(chosen, MARKS);
    assert.equal(marked.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(marked.length > 1000, `pdf is ${marked.length} bytes`);
    assert.equal(stable(marked), stable(await render(chosen, MARKS)), "deterministic once the clock is taken out");
    assert.notEqual(stable(marked), stable(await render({}, MARKS)), "the markers change the page");
    assert.notEqual(stable(marked), stable(await render({ markers: ["notary"] }, MARKS)), "which markers print changes the key");
    assert.equal(stable(await render({}, MARKS)), stable(await render()), "a preset that lists none renders the same whatever the workspace has");
    assert.notEqual(stable(await render({ name_format: "last_first" })), stable(await render()), "the name format changes the page");
    for (const layout of [{ layout: "cards" as const }, { page_columns: 2 as const, margins: "narrow" as const }, { page_columns: 3 as const }]) {
      const withKey = await render({ ...layout, ...chosen }, MARKS);
      assert.equal(withKey.subarray(0, 5).toString("latin1"), "%PDF-");
      assert.notEqual(stable(withKey), stable(await render(layout, MARKS)), `the key line changes the ${JSON.stringify(layout)} page`);
    }
  });
});
