// The directory registry against a real PostgreSQL: the two-layer store, the
// mapping engine wired into a provider sync, adoption of hand-typed rows, and
// people-kind fields resolving into links. None of this is reachable from the
// HTTP surface (no endpoint seeds a provider's people), so like the brake test
// this drives replaceProviderPeople directly. It uses the graph source so it
// cannot collide with the brake test, which owns the google source and runs
// in parallel.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, getSetting } from "../src/lib/db";
import {
  createField,
  createPerson,
  deleteField,
  effectiveMapping,
  getPersonById,
  listFields,
  listPeople,
  reapplyMappings,
  replaceProviderPeople,
  updateField,
  updatePerson,
} from "../src/lib/directory";

const SOURCE = "graph" as const;
const PREFIX = "registry-test-";
const DOMAIN = "registry-test.example";

async function clean() {
  await pool().query("DELETE FROM directory_people WHERE external_id LIKE $1 OR email LIKE $2", [
    `${PREFIX}%`,
    `%@${DOMAIN}`,
  ]);
  for (const key of ["rt_position", "rt_office_label", "rt_ext", "rt_legal_group", "rt_legacy"]) {
    const f = (await listFields()).find((x) => x.key === key);
    if (f) await deleteField(f.id);
  }
}

describe("directory registry", () => {
  before(async () => {
    await getSetting("__schema_bootstrap__");
    await clean();
  });
  after(async () => {
    await clean();
  });

  test("built-in rows exist and cannot be deleted", async () => {
    const fields = await listFields();
    for (const key of ["title", "department", "office", "assistant"]) {
      const f = fields.find((x) => x.key === key);
      assert.ok(f, `${key} row seeded`);
      assert.equal(f!.builtin, 1);
    }
    const assistant = fields.find((x) => x.key === "assistant")!;
    assert.equal(assistant.kind, "people");
    assert.equal(assistant.inverse_label, "Assists");
    await assert.rejects(deleteField(assistant.id), /Built-in/);
  });

  test("records flow through mappings into the synced layer; manual wins per key", async () => {
    const position = await createField({
      label: "RT Position",
      key: "rt_position",
      kind: "text",
      group_by: true,
      options: [{ value: "Attorney", matches: ["*Attorney*", "Partner"] }, { value: "Paralegal" }],
      mappings: { microsoft: { kind: "path", path: "organizations[primary].title" } },
    });
    const ext = await createField({
      label: "RT Ext",
      key: "rt_ext",
      mappings: { microsoft: { kind: "extract", path: "phones.value", pattern: "x(\\d+)$" } },
    });
    assert.equal(position.graph_path, "organizations[primary].title", "a path mapping fills the legacy column");
    assert.equal(ext.graph_path, "", "a non-path mapping leaves the legacy column empty");

    const outcome = await replaceProviderPeople(SOURCE, [
      {
        external_id: `${PREFIX}amy`,
        name: "Amy Attorney",
        email: `amy@${DOMAIN}`,
        record: {
          organizations: [{ title: "Senior Partner", primary: true }],
          phones: [{ value: "+1 602 555 0100 x218", type: "work" }],
        },
      },
    ]);
    assert.equal(outcome.upserted, 1);

    let amy = (await listPeople({ includeHidden: true })).find((p) => p.external_id === `${PREFIX}amy`)!;
    assert.equal(amy.synced.rt_position, "Senior Partner");
    assert.equal(amy.synced.rt_ext, "218");
    assert.equal(amy.custom.rt_ext, "218", "effective value comes from synced when nothing is manual");
    assert.equal(amy.has_record, true);

    // A manual value shadows the synced one; deleting it (null) reveals it again.
    await updatePerson(amy.id, { custom: { rt_ext: "999" } });
    amy = (await getPersonById(amy.id))!;
    assert.equal(amy.custom.rt_ext, "999");
    assert.equal(amy.synced.rt_ext, "218", "the sync's value is untouched");
    await updatePerson(amy.id, { custom: { rt_ext: null } });
    amy = (await getPersonById(amy.id))!;
    assert.equal(amy.custom.rt_ext, "218");

    // A second sync with a changed record replaces the synced layer wholesale:
    // a value that vanished upstream vanishes here (the 1.1 stale-value bug).
    await replaceProviderPeople(SOURCE, [
      {
        external_id: `${PREFIX}amy`,
        name: "Amy Attorney",
        email: `amy@${DOMAIN}`,
        record: { organizations: [{ title: "Of Counsel", primary: true }], phones: [], mail: `amy@${DOMAIN}` },
      },
    ]);
    amy = (await getPersonById(amy.id))!;
    assert.equal(amy.synced.rt_position, "Of Counsel");
    assert.equal(amy.synced.rt_ext, undefined);
    assert.equal(amy.custom.rt_ext, undefined);
  });

  test("editing a mapping re-applies to stored records without a sync", async () => {
    const f = (await listFields()).find((x) => x.key === "rt_ext")!;
    await updateField(f.id, { mappings: { microsoft: { kind: "derive", rule: "email_localpart" } } });
    const { updated } = await reapplyMappings();
    assert.ok(updated >= 1);
    const amy = (await listPeople({ includeHidden: true })).find((p) => p.external_id === `${PREFIX}amy`)!;
    assert.equal(amy.synced.rt_ext, "amy");
  });

  test("built-in columns can be composed from the record", async () => {
    const office = (await listFields()).find((x) => x.key === "office")!;
    await updateField(office.id, {
      mappings: { microsoft: { kind: "compose", template: "{locations[primary].buildingId} – {locations[primary].area}" } },
    });
    await replaceProviderPeople(SOURCE, [
      {
        external_id: `${PREFIX}amy`,
        name: "Amy Attorney",
        email: `amy@${DOMAIN}`,
        office: "raw-from-provider",
        record: { locations: [{ buildingId: "PHX1", area: "Phoenix", primary: true }] },
      },
    ]);
    const amy = (await listPeople({ includeHidden: true })).find((p) => p.external_id === `${PREFIX}amy`)!;
    assert.equal(amy.office, "PHX1 – Phoenix");
    await updateField(office.id, { mappings: {} });
  });

  test("a hand-typed person is adopted by the sync that matches their email", async () => {
    const manual = await createPerson({
      name: "Bob Beforehand",
      email: `bob@${DOMAIN}`,
      custom: { rt_position: "Paralegal" },
      pin_order: 3,
    });
    const outcome = await replaceProviderPeople(SOURCE, [
      { external_id: `${PREFIX}amy`, name: "Amy Attorney", email: `amy@${DOMAIN}`, record: {} },
      { external_id: `${PREFIX}bob`, name: "Bob Synced", email: `BOB@${DOMAIN}`, record: {} },
    ]);
    assert.equal(outcome.adopted, 1);
    const bob = (await getPersonById(manual.id))!;
    assert.equal(bob.source, SOURCE, "same row, now owned by the provider");
    assert.equal(bob.external_id, `${PREFIX}bob`);
    assert.equal(bob.name, "Bob Synced");
    assert.equal(bob.manual.rt_position, "Paralegal", "the manual layer survives adoption");
    assert.equal(bob.pin_order, 3, "so does the pin");
    const dupes = await pool().query("SELECT count(*)::int AS c FROM directory_people WHERE lower(email) = $1", [
      `bob@${DOMAIN}`,
    ]);
    assert.equal(dupes.rows[0].c, 1, "no duplicate row");
  });

  test("people fields resolve tokens into links both ways; manual links survive", async () => {
    const assistant = (await listFields()).find((x) => x.key === "assistant")!;
    // The value lives on the assistant and names the people they assist.
    await updateField(assistant.id, {
      link_direction: "in",
      mappings: { microsoft: { kind: "path", path: "relations.value" } },
    });
    const outcome = await replaceProviderPeople(SOURCE, [
      { external_id: `${PREFIX}amy`, name: "Amy Attorney", email: `amy@${DOMAIN}`, record: {} },
      { external_id: `${PREFIX}bob`, name: "Bob Synced", email: `bob@${DOMAIN}`, record: {} },
      {
        external_id: `${PREFIX}dana`,
        name: "Dana Assistant",
        email: `dana@${DOMAIN}`,
        record: { relations: [{ value: `amy@${DOMAIN}` }, { value: `${PREFIX}bob` }, { value: `nobody@${DOMAIN}` }] },
      },
    ]);
    assert.deepEqual(outcome.unresolved, [{ field: "assistant", count: 1, samples: [`nobody@${DOMAIN}`] }]);

    const all = await listPeople({ includeHidden: true });
    const amy = all.find((p) => p.external_id === `${PREFIX}amy`)!;
    const bob = all.find((p) => p.external_id === `${PREFIX}bob`)!;
    const dana = all.find((p) => p.external_id === `${PREFIX}dana`)!;
    assert.deepEqual(amy.links.assistant?.map((l) => l.name), ["Dana Assistant"]);
    assert.equal(amy.assistant_name, "Dana Assistant");
    assert.deepEqual(bob.links.assistant?.map((l) => l.name), ["Dana Assistant"]);
    assert.deepEqual(dana.linked_by.assistant?.map((l) => l.name).sort(), ["Amy Attorney", "Bob Synced"]);

    // A manual link added by an admin is kept when the provider's pairs change.
    const carl = await createPerson({ name: "Carl Manual", email: `carl@${DOMAIN}` });
    await updatePerson(amy.id, { links: { assistant: [carl.id] } });
    await replaceProviderPeople(SOURCE, [
      { external_id: `${PREFIX}amy`, name: "Amy Attorney", email: `amy@${DOMAIN}`, record: {} },
      { external_id: `${PREFIX}bob`, name: "Bob Synced", email: `bob@${DOMAIN}`, record: {} },
      { external_id: `${PREFIX}dana`, name: "Dana Assistant", email: `dana@${DOMAIN}`, record: { relations: [{ value: `${PREFIX}bob` }] } },
    ]);
    const amy2 = (await getPersonById(amy.id))!;
    assert.deepEqual(amy2.links.assistant?.map((l) => l.name), ["Carl Manual"], "synced pair gone, manual pair kept");

    // Hidden people never surface through a link.
    await updatePerson(carl.id, { hidden: true });
    const amy3 = (await getPersonById(amy.id))!;
    assert.deepEqual(amy3.links.assistant ?? [], []);

    await updateField(assistant.id, { link_direction: "out", mappings: {} });
  });

  test("clearing a mapping clears it, including one that lived only in the legacy column", async () => {
    const made = await createField({ label: "RT Legacy", key: "rt_legacy", mappings: { microsoft: { kind: "path", path: "onPremisesExtensionAttributes.extensionAttribute9" } } });
    // A field mapped before 1.2 has the path column and an empty blob. It
    // reads as one mapping, the same one the row and the editor show.
    await pool().query("UPDATE directory_fields SET mappings = '{}'::jsonb WHERE id = $1", [made.id]);
    const legacy = (await listFields()).find((x) => x.id === made.id)!;
    assert.equal(legacy.graph_path, "onPremisesExtensionAttributes.extensionAttribute9");
    assert.deepEqual(legacy.mappings.microsoft, { kind: "path", path: "onPremisesExtensionAttributes.extensionAttribute9" });

    // "Not mapped" is a save without the provider. 1.2.0 kept the legacy
    // column and read it back, so the property returned on the next load.
    const cleared = (await updateField(made.id, { mappings: {} }))!;
    assert.equal(cleared.mappings.microsoft, undefined);
    assert.equal(cleared.graph_path, "");
    assert.equal(effectiveMapping(cleared, "microsoft"), null);
    const reread = (await listFields()).find((x) => x.id === made.id)!;
    assert.equal(reread.mappings.microsoft, undefined, "stays cleared on re-read");

    // Editing one provider leaves the other's mapping alone; a non-path
    // mapping leaves the legacy column empty rather than stale.
    const both = (await updateField(made.id, { mappings: { microsoft: { kind: "derive", rule: "initials" }, google: { kind: "path", path: "organizations[primary].title" } } }))!;
    assert.equal(both.graph_path, "");
    assert.equal(both.google_path, "organizations[primary].title");
    const oneGone = (await updateField(made.id, { mappings: { google: both.mappings.google } }))!;
    assert.equal(oneGone.mappings.microsoft, undefined);
    assert.deepEqual(oneGone.mappings.google, { kind: "path", path: "organizations[primary].title" });
    assert.equal(oneGone.google_path, "organizations[primary].title");
  });
});
