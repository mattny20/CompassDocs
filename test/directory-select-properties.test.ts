// What the Microsoft fetch asks Graph for (1.14.1): the mapped properties,
// plus the handles the people resolver indexes whenever a people field is
// mapped from Microsoft. Graph returns those only when $select names them.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { selectPropertiesFor, applyFieldMappings } from "../src/lib/directory";
import { MICROSOFT_RESOLVER_PROPERTIES, buildPeopleIndex } from "../src/lib/directory-people-resolve";
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

// A multi-valued DN attribute (AD's secretary, a multi-valued extension)
// through the real mapping step and then the resolver (1.14.1 review).
describe("a people field's values on their way to the resolver", () => {
  const secretary = field("secretary", "people", { microsoft: { kind: "path", path: "extension_abc123_secretary" } });
  const index = buildPeopleIndex([
    { id: 1, external_id: "a1", email: "dana.ruiz@firm.test", name: "Dana Ruiz", record: { onPremisesDistinguishedName: "CN=Ruiz\\, Dana,OU=Staff,DC=firm,DC=local" } },
    { id: 2, external_id: "a2", email: "sam.chen@firm.test", name: "Sam Chen", record: { onPremisesDistinguishedName: "CN=Chen\\, Sam,OU=Staff,DC=firm,DC=local" } },
  ]);
  const ids = (v: string) => index.resolveList(v).map((r) => (r.hit && "id" in r.hit ? r.hit.id : r.token));

  test("two DNs are stored with '; ' between them and both resolve, whichever comes first", () => {
    const both = applyFieldMappings([secretary], "microsoft", { extension_abc123_secretary: ["CN=Ruiz\\, Dana,OU=Staff,DC=firm,DC=local", "CN=Chen\\, Sam,OU=Staff,DC=firm,DC=local"] });
    assert.equal(both.synced.secretary, "CN=Ruiz\\, Dana,OU=Staff,DC=firm,DC=local; CN=Chen\\, Sam,OU=Staff,DC=firm,DC=local");
    assert.deepEqual(ids(both.synced.secretary), [1, 2]);
    const gone = "CN=Gone\\, Person,OU=Staff,DC=firm,DC=local";
    const first = applyFieldMappings([secretary], "microsoft", { extension_abc123_secretary: [gone, "CN=Chen\\, Sam,OU=Staff,DC=firm,DC=local"] });
    assert.deepEqual(ids(first.synced.secretary), [gone, 2], "an unknown first DN is reported whole and the second still links");
  });

  test("a long list is cut between values, never through a DN", () => {
    const many = Array.from({ length: 12 }, (_, i) => `CN=Person\\, Number ${i},OU=Staff,DC=firm,DC=local`);
    const v = applyFieldMappings([secretary], "microsoft", { extension_abc123_secretary: many }).synced.secretary;
    assert.ok(v.length <= 500);
    assert.ok(v.split("; ").every((dn) => many.includes(dn)), "every stored entry is a whole DN");
  });

  test("other multi-valued fields still join with ', '", () => {
    const tags = field("skills", "text", { microsoft: { kind: "path", path: "skills" } });
    (tags as unknown as { multi: number }).multi = 1;
    assert.equal(applyFieldMappings([tags], "microsoft", { skills: ["Tax", "Audit"] }).synced.skills, "Tax, Audit");
  });
});
