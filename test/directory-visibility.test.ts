// Field visibility — pure rules.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hiddenKeysFor, redactPeople, visibleFields, parseColumnVisibility, parseVisibility } from "../src/lib/directory-visibility";
import type { FieldLike } from "../src/lib/directory-display";

const field = (key: string, extra: Partial<FieldLike & { visibility: string }> = {}): FieldLike & { visibility: string } =>
  ({ key, label: key, kind: "text", multi: 0, builtin: 0, group_by: 0, options: [], value_format: "raw", display: "field", show_with: "", highlight: 0, inverse_label: "", show_in_card: 1, visibility: "everyone", ...extra }) as FieldLike & { visibility: string };

describe("field visibility", () => {
  const fields = [
    field("title", { builtin: 1 }),
    field("birthday", { kind: "date", visibility: "admins" }),
    field("home", { label: "Home office", visibility: "admins" }),
    field("assistant", { kind: "people", builtin: 1 }),
    field("manager", { kind: "people", builtin: 1, visibility: "admins" }),
  ];
  const person = {
    id: 1, name: "Jane", title: "Partner", department: "", email: "jane@f.com", phone: "1", mobile: "2", office: "PHX1",
    custom: { birthday: "1990-05-01", home: "Tucson", bar: "123" }, synced: { birthday: "1990-05-01" }, manual: { home: "Tucson" },
    links: { assistant: [{ id: 2, name: "Dana" }], manager: [{ id: 3, name: "Zed" }] },
    linked_by: { manager: [{ id: 4, name: "Ann" }] },
    assistant_name: "Dana",
  };

  test("admins see everything; viewers lose admin-only fields, both ends of an admin-only people field, and restricted contact columns", () => {
    assert.equal(hiddenKeysFor(fields, { mobile: "admins" }, true).size, 0);
    const hidden = hiddenKeysFor(fields, { mobile: "admins" }, false);
    assert.deepEqual([...hidden].sort(), ["birthday", "home", "manager", "manager:in", "mobile"]);
    const [r] = redactPeople([person], hidden);
    assert.equal(r.mobile, "");
    assert.equal(r.phone, "1");
    assert.equal(r.email, "jane@f.com");
    assert.deepEqual(r.custom, { bar: "123" });
    assert.deepEqual(r.synced, {});
    assert.deepEqual(r.manual, {});
    assert.deepEqual(r.links, { assistant: [{ id: 2, name: "Dana" }] });
    assert.deepEqual(r.linked_by, {});
    assert.equal(r.assistant_name, "Dana");
    assert.deepEqual(visibleFields(fields, hidden).map((f) => f.key), ["title", "assistant"]);
    assert.equal(person.custom.home, "Tucson", "the input is not mutated");
  });

  test("nothing hidden returns the same objects; an admin-only assistant field also drops the joined name", () => {
    const none = hiddenKeysFor(fields.filter((f) => f.visibility !== "admins"), {}, false);
    assert.equal(none.size, 0);
    assert.equal(redactPeople([person], none)[0], person);
    const hidden = hiddenKeysFor([field("assistant", { kind: "people", builtin: 1, visibility: "admins" })], {}, false);
    assert.deepEqual([...hidden].sort(), ["assistant", "assists"]);
    assert.equal(redactPeople([person], hidden)[0].assistant_name, null);
  });

  test("parsers accept only the two levels and the three contact columns", () => {
    assert.equal(parseVisibility("admins"), "admins");
    assert.equal(parseVisibility("nobody"), "everyone");
    assert.deepEqual(parseColumnVisibility({ mobile: "admins", email: "everyone", name: "admins", phone: "ADMINS" }), { mobile: "admins" });
    assert.deepEqual(parseColumnVisibility("x"), {});
  });
});
