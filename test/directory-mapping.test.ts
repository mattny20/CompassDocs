// Unit tests for the directory mapping engine and display helpers — pure
// functions, no database. These are the rules an admin's configuration is
// interpreted by, so they are pinned here with the intent spelled out.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyMapping,
  valuesAtPath,
  parseMapping,
  mappingProperties,
  mappingGroupIds,
  initialsFromName,
  describeMapping,
  type Mapping,
} from "../src/lib/directory-mapping";
import {
  resolveValue,
  displayValue,
  groupPeople,
  comparePeople,
  initialsOf,
  cellValue,
  type FieldLike,
  type PersonLike,
} from "../src/lib/directory-display";

const record = {
  displayName: "Smith, Jane",
  givenName: "Jane",
  surname: "Smith",
  jobTitle: "Associate Attorney",
  department: "Legal",
  officeLocation: "PHX1",
  city: "Phoenix",
  mail: "jsmith@firm.example",
  businessPhones: ["+1 602 555 0100 x218"],
  onPremisesExtensionAttributes: { extensionAttribute3: "LIT; EST", extensionAttribute7: "" },
  organizations: [{ title: "Old", primary: false }, { title: "Paralegal", primary: true }],
  relations: [
    { value: "boss@firm.example", type: "manager" },
    { value: "dana@firm.example", type: "assistant" },
    { value: "sam@firm.example", type: "Assistant" },
  ],
  manager: { mail: "boss@firm.example", displayName: "Boss Person" },
  _groups: ["g-lit", "g-notary"],
};

describe("valuesAtPath", () => {
  test("dotted paths, array indexes, and [primary]", () => {
    assert.deepEqual(valuesAtPath(record, "officeLocation"), ["PHX1"]);
    assert.deepEqual(valuesAtPath(record, "onPremisesExtensionAttributes.extensionAttribute3"), ["LIT; EST"]);
    assert.deepEqual(valuesAtPath(record, "businessPhones.0"), ["+1 602 555 0100 x218"]);
    assert.deepEqual(valuesAtPath(record, "businessPhones.1"), []);
    assert.deepEqual(valuesAtPath(record, "organizations[primary].title"), ["Paralegal"]);
    assert.deepEqual(valuesAtPath(record, "missing.deeper"), []);
    // Empty strings are not values — a blank extension attribute must not
    // count as "filled".
    assert.deepEqual(valuesAtPath(record, "onPremisesExtensionAttributes.extensionAttribute7"), []);
  });

  test("a typed pick keeps the elements whose type matches; a navigation object reads like any other", () => {
    assert.deepEqual(valuesAtPath(record, "relations[assistant].value"), ["dana@firm.example", "sam@firm.example"], "case-insensitive");
    assert.deepEqual(valuesAtPath(record, "relations[manager].value"), ["boss@firm.example"]);
    assert.deepEqual(valuesAtPath(record, "relations[spouse].value"), [], "no match is empty, not the whole list");
    assert.deepEqual(valuesAtPath(record, "officeLocation[work]"), [], "a scalar has no typed elements");
    assert.deepEqual(valuesAtPath(record, "manager.mail"), ["boss@firm.example"]);
    // The fetch layer asks for the top-level property, whatever the pick.
    assert.deepEqual(mappingProperties({ kind: "path", path: "relations[assistant].value" }), ["relations"]);
    assert.deepEqual(mappingProperties({ kind: "path", path: "manager.mail" }), ["manager"]);
  });
});

describe("applyMapping", () => {
  test("compose drops the separator beside an empty placeholder", () => {
    const m: Mapping = { kind: "compose", template: "{officeLocation} – {city}" };
    assert.deepEqual(applyMapping(m, record), ["PHX1 – Phoenix"]);
    assert.deepEqual(applyMapping(m, { ...record, city: "" }), ["PHX1"]);
    assert.deepEqual(applyMapping(m, { ...record, officeLocation: undefined }), ["Phoenix"]);
    assert.deepEqual(applyMapping(m, {}), []);
  });

  test("extract takes the first capture from the first matching value", () => {
    const m: Mapping = { kind: "extract", path: "businessPhones", pattern: "x(\\d{2,5})$" };
    assert.deepEqual(applyMapping(m, record), ["218"]);
    assert.deepEqual(applyMapping(m, { businessPhones: ["+1 602 555 0100"] }), []);
    // A pattern that does not compile yields nothing rather than throwing.
    assert.deepEqual(applyMapping({ kind: "extract", path: "mail", pattern: "(" }, record), []);
  });

  test("first-of falls through to the first mapping that yields", () => {
    const m: Mapping = {
      kind: "first",
      of: [
        { kind: "path", path: "onPremisesExtensionAttributes.extensionAttribute7" },
        { kind: "derive", rule: "initials" },
      ],
    };
    assert.deepEqual(applyMapping(m, record), ["JS"]);
  });

  test("groups yields the values of the groups the person is in, in mapping order", () => {
    const m: Mapping = {
      kind: "groups",
      groups: [
        { id: "g-est", value: "Estate Planning" },
        { id: "g-lit", value: "Litigation" },
        { id: "g-notary", value: "Notary" },
      ],
    };
    assert.deepEqual(applyMapping(m, record), ["Litigation", "Notary"]);
    assert.deepEqual(applyMapping(m, { ...record, _groups: undefined }), []);
  });

  test("derive: email local part", () => {
    assert.deepEqual(applyMapping({ kind: "derive", rule: "email_localpart" }, record), ["jsmith"]);
  });
});

describe("initials", () => {
  test("last-first, honorifics, suffixes", () => {
    assert.equal(initialsFromName("Smith, Jane"), "JS");
    assert.equal(initialsFromName("Dr. Jane Smith, Esq."), "JS");
    assert.equal(initialsFromName("Jane Marie Smith"), "JMS");
    assert.equal(initialsFromName(""), "");
    assert.equal(initialsOf("Smith, Jane"), "JS");
    assert.equal(initialsOf("Jane Marie Smith"), "JM");
  });
});

describe("parseMapping / properties", () => {
  test("rejects junk and reports what a mapping needs", () => {
    assert.equal(parseMapping({ kind: "path", path: " " }), null);
    assert.equal(parseMapping({ kind: "extract", path: "x", pattern: "(" }), null);
    assert.equal(parseMapping({ kind: "nope" }), null);
    const m = parseMapping({
      kind: "first",
      of: [{ kind: "compose", template: "{officeLocation} – {city}" }, { kind: "path", path: "businessPhones.1" }],
    })!;
    assert.deepEqual(mappingProperties(m).sort(), ["businessPhones", "city", "officeLocation"]);
    assert.deepEqual(mappingGroupIds({ kind: "groups", groups: [{ id: "a", value: "A" }] }), ["a"]);
    assert.equal(describeMapping({ kind: "extract", path: "businessPhones", pattern: "x(\\d+)$" }), "businessPhones ~ /x(\\d+)$/");
  });
});

// --- display -----------------------------------------------------------------------

const position: FieldLike = {
  key: "position",
  label: "Position",
  kind: "text",
  multi: 0,
  builtin: 0,
  group_by: 1,
  options: [
    { value: "Attorney", matches: ["*Attorney*", "Partner", "Of Counsel"] },
    { value: "Legal Assistant", matches: ["LA", "Legal Asst*"] },
    { value: "Paralegal" },
  ],
  value_format: "label",
  display: "field",
  show_with: "",
  highlight: 0,
  inverse_label: "",
  show_in_card: 0,
};
const office: FieldLike = {
  ...position,
  key: "office",
  label: "Office",
  builtin: 1,
  options: [{ value: "PHX1", label: "Phoenix" }, { value: "FLG1", label: "Flagstaff" }],
  value_format: "code_label",
};

function person(over: Partial<PersonLike>): PersonLike {
  return {
    id: 0, name: "", title: "", department: "", email: "", phone: "", mobile: "", office: "", custom: {}, ...over,
  };
}

describe("options", () => {
  test("resolve by value, label, and wildcard alias; unmatched keeps the raw value", () => {
    assert.equal(resolveValue(position, "Associate Attorney").value, "Attorney");
    assert.equal(resolveValue(position, "of counsel").value, "Attorney");
    assert.equal(resolveValue(position, "la").value, "Legal Assistant");
    assert.equal(resolveValue(position, "Receptionist").value, "Receptionist");
    assert.equal(resolveValue(position, "Receptionist").index, Number.POSITIVE_INFINITY);
    assert.equal(resolveValue(office, "phoenix").value, "PHX1");
  });

  test("value_format: raw, label, code – label", () => {
    assert.equal(displayValue(office, "PHX1"), "PHX1 – Phoenix");
    assert.equal(displayValue({ ...office, value_format: "label" }, "PHX1"), "Phoenix");
    assert.equal(displayValue({ ...office, value_format: "raw" }, "PHX1"), "PHX1");
    assert.equal(displayValue(office, "TUC1"), "TUC1");
    assert.equal(displayValue(position, "Senior Partner"), "Senior Partner");
    assert.equal(displayValue({ ...position, multi: 1 }, "LA, Partner"), "Legal Assistant, Attorney");
  });
});

describe("grouping and ordering", () => {
  const people = [
    person({ id: 1, name: "Zed Paralegal", custom: { position: "Sr. Paralegal" } }),
    person({ id: 2, name: "Amy Attorney", custom: { position: "Partner" } }),
    person({ id: 3, name: "Bob Assistant", custom: { position: "LA" } }),
    person({ id: 4, name: "Cy Receptionist", custom: { position: "Receptionist" } }),
    person({ id: 5, name: "Dee Nobody" }),
    person({ id: 6, name: "Eve Attorney", custom: { position: "Associate Attorney" } }),
  ];

  test("sections follow option order, unmatched after, empty last", () => {
    const groups = groupPeople(people, position);
    assert.deepEqual(
      groups.map((g) => g.label),
      ["Attorney", "Legal Assistant", "Receptionist", "Sr. Paralegal", "No position"]
    );
    assert.deepEqual(groups[0].members.map((p) => p.id), [2, 6]);
    // Headers are labelled by the option even when the field shows raw
    // values in cells: "Partner" and "Associate Attorney" both file under
    // "Attorney", not under whichever alias happened to come first.
    assert.deepEqual(
      groupPeople(people, { ...position, value_format: "raw" }).map((g) => g.label).slice(0, 2),
      ["Attorney", "Legal Assistant"]
    );
    // "Sr. Paralegal" does not match the plain "Paralegal" option (no alias)
    // — it lands in its own unmatched section, alphabetically after the mapped
    // ones. That is what the unmatched report is for; a silent fold would
    // hide a data problem.
    assert.ok(groups.some((g) => g.label === "Sr. Paralegal"));
  });

  test("multi-valued fields list a person under each group once", () => {
    const multi = { ...position, multi: 1 };
    const both = person({ id: 9, name: "Two Hats", custom: { position: "Partner, LA, Attorney" } });
    const groups = groupPeople([both], multi);
    assert.deepEqual(groups.map((g) => [g.label, g.members.length]), [["Attorney", 1], ["Legal Assistant", 1]]);
  });

  test("sorting by a field with options uses option order, then value, then name", () => {
    const sorted = [...people].sort(comparePeople([position], "position"));
    assert.deepEqual(sorted.map((p) => p.id), [2, 6, 3, 4, 1, 5]);
  });

  test("cellValue resolves people fields and inverse keys from links", () => {
    const p = person({
      id: 1,
      name: "Amy",
      links: { assistant: [{ id: 3, name: "Bob" }, { id: 4, name: "Cy" }] },
      linked_by: { assistant: [{ id: 7, name: "Gil" }] },
    });
    const assistant: FieldLike = { ...position, key: "assistant", label: "Assistant", kind: "people", multi: 1, options: [], inverse_label: "Assists" };
    assert.equal(cellValue(p, "assistant", [assistant]), "Bob, Cy");
    assert.equal(cellValue(p, "assists", [assistant]), "Gil");
    assert.equal(cellValue(p, "assistant:in", [assistant]), "Gil");
  });
});
