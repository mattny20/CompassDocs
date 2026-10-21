// What the Microsoft fetch asks Graph for (1.14.1): the mapped properties,
// plus the handles the people resolver indexes whenever a people field is
// mapped from Microsoft. Graph returns those only when $select names them.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { selectPropertiesFor } from "../src/lib/directory";
import { MICROSOFT_RESOLVER_PROPERTIES } from "../src/lib/directory-people-resolve";
import type { DirectoryField } from "../src/lib/directory";

function field(key: string, kind: DirectoryField["kind"], mappings: DirectoryField["mappings"]): DirectoryField {
  return { key, kind, mappings } as unknown as DirectoryField;
}

describe("selectPropertiesFor", () => {
  const office = field("office", "text", { microsoft: { kind: "path", path: "officeLocation" }, google: { kind: "path", path: "locations.0.buildingId" } });
  const assistant = field("assistant", "people", { microsoft: { kind: "path", path: "extension_abc123_assistant" } });

  test("a mapped people field adds the resolver's handles for Microsoft", () => {
    const props = selectPropertiesFor("microsoft", [office, assistant]);
    assert.ok(props.includes("officeLocation"));
    assert.ok(props.includes("extension_abc123_assistant"));
    for (const p of MICROSOFT_RESOLVER_PROPERTIES) assert.ok(props.includes(p), p);
    assert.equal(new Set(props).size, props.length, "no property twice");
  });

  test("no people field mapped from Microsoft: only what the mappings read", () => {
    assert.deepEqual(selectPropertiesFor("microsoft", [office]), ["officeLocation"]);
    const unmapped = field("assistant", "people", {});
    assert.deepEqual(selectPropertiesFor("microsoft", [office, unmapped]), ["officeLocation"]);
  });

  test("Google is unchanged", () => {
    const g = selectPropertiesFor("google", [office, field("assistant", "people", { google: { kind: "path", path: "relations[assistant].value" } })]);
    assert.deepEqual(g.sort(), ["locations", "relations"]);
  });
});
