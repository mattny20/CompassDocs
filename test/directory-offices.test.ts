// Office profiles — pure rules: what an admin's JSON becomes, which office a
// person's value names, and which blocks a set of people produces on paper.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OFFICE_FIELDS,
  officeBlocksFor,
  officeKeyOf,
  sanitizeOfficeConfig,
  type OfficeConfig,
} from "../src/lib/directory-offices";

const officeField = {
  options: [
    { value: "PHX1", label: "Phoenix", matches: ["phx", "*Phoenix*"] },
    { value: "TUC", label: "Tucson" },
  ],
  value_format: "label" as const,
};

const config: OfficeConfig = {
  fields: [
    { key: "address", label: "Address", multiline: true },
    { key: "main_phone", label: "Main phone", multiline: false },
    { key: "fax", label: "Fax", multiline: false },
  ],
  profiles: [
    { office: "phx1", name: "", values: { address: "1 N Central Ave\nPhoenix, AZ 85004", main_phone: "602-555-0100" } },
    { office: "TUC", name: "Tucson office", values: {} },
    { office: "Remote", name: "", values: { main_phone: "800-555-0199" } },
  ],
};

describe("sanitizeOfficeConfig", () => {
  test("defaults, slugged keys, deduplication, and values only for known fields", () => {
    const empty = sanitizeOfficeConfig({});
    assert.deepEqual(empty.fields, DEFAULT_OFFICE_FIELDS);
    assert.deepEqual(empty.profiles, []);

    const c = sanitizeOfficeConfig({
      fields: [{ label: "Main phone" }, { label: "Main phone" }, { key: "Parking Info!", label: "Parking", multiline: 1 }, { label: "" }],
      profiles: [
        { office: " PHX1 ", name: "Phoenix", values: { main_phone: " 602 ", parking_info: "Garage B", bogus: "x", main_phone_2: "" } },
        { office: "phx1", values: { main_phone: "dup" } },
        { office: "", values: {} },
      ],
    });
    assert.deepEqual(
      c.fields.map((f) => [f.key, f.label, f.multiline]),
      [["main_phone", "Main phone", false], ["main_phone_2", "Main phone", false], ["parking_info", "Parking", true]]
    );
    assert.equal(c.profiles.length, 1, "the same office twice keeps the first; a blank office is dropped");
    assert.deepEqual(c.profiles[0], { office: "PHX1", name: "Phoenix", values: { main_phone: "602", parking_info: "Garage B" } });
  });
});

describe("officeKeyOf", () => {
  test("resolves through the Office field's options, else keeps the raw value", () => {
    assert.equal(officeKeyOf("phx", officeField), "PHX1", "an alias resolves to the option value");
    assert.equal(officeKeyOf("Phoenix", officeField), "PHX1", "so does the label");
    assert.equal(officeKeyOf(" TUC ", officeField), "TUC");
    assert.equal(officeKeyOf("Remote", officeField), "Remote", "no option: the raw value");
    assert.equal(officeKeyOf("", officeField), "");
    assert.equal(officeKeyOf("PHX1", undefined), "PHX1");
  });
});

describe("officeBlocksFor", () => {
  test("one block per office with people and content, in option order, named by the label", () => {
    const people = [{ office: "Remote" }, { office: "phx" }, { office: "TUC" }, { office: "PHX1" }, { office: "" }, { office: "Nowhere" }];
    const blocks = officeBlocksFor(people, officeField, config);
    assert.deepEqual(
      blocks.map((b) => [b.name, b.count]),
      [["Phoenix", 2], ["Remote", 1]],
      "Tucson has a profile but nothing in it; Nowhere has no profile; options lead"
    );
    assert.deepEqual(blocks[0].rows, [
      { label: "Address", value: "1 N Central Ave\nPhoenix, AZ 85004", multiline: true },
      { label: "Main phone", value: "602-555-0100", multiline: false },
    ]);
    assert.deepEqual(officeBlocksFor(people, officeField, undefined), []);
    assert.deepEqual(officeBlocksFor([{ office: "TUC" }], officeField, config), [], "an office without content prints nothing");
  });
});
