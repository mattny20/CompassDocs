// Saving export presets (1.15.0): download links name a preset by id, so two
// presets must never share one (and the de-duplication must finish: ["a",
// "a-3", "a"] used to retry "a-3" for the third preset forever), a preset
// sent without an id is named from its name, and an id once deleted is never
// given to a new preset.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/directory-export-presets.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getSetting, setSetting, pool } from "../src/lib/db";
import { getExportPreset, listExportPresets, retiredPresetIds, saveExportPresets } from "../src/lib/directory-export-config";

const KEYS = ["directory_export_presets", "directory_export_retired_ids"];
const saved = new Map<string, string | undefined>();

before(async () => {
  await getSetting("__schema_bootstrap__");
  for (const k of KEYS) saved.set(k, await getSetting(k));
  // Start from no presets and no retired ids, whatever the database holds
  // (an earlier interrupted run leaves its own behind); after() restores.
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
});

after(async () => {
  for (const k of KEYS) {
    await pool().query("DELETE FROM settings WHERE key = $1", [k]);
    const v = saved.get(k);
    if (v !== undefined) await setSetting(k, v);
  }
});

test("a repeated id is numbered past a suffix that is itself taken, and the save finishes", async () => {
  const out = await saveExportPresets([
    { id: "a", name: "A" },
    { id: "a-3", name: "A three" },
    { id: "a", name: "A again" },
  ]);
  const ids = out.map((p) => p.id);
  assert.equal(new Set(ids).size, 3, `distinct ids: ${ids.join(", ")}`);
  assert.deepEqual(ids.slice(0, 2), ["a", "a-3"], "the first of each id keeps it");
  assert.equal(ids[2], "a-4");
});

test("a saved preset is found by its id, which is what a download link names", async () => {
  await saveExportPresets([
    { id: "front-desk", name: "Front desk", is_default: true },
    { id: "partners", name: "Partners" },
  ]);
  assert.equal((await getExportPreset("partners"))?.name, "Partners");
  assert.equal(await getExportPreset("gone"), undefined, "an unknown id is no preset (the landing page says the link is dead)");
  assert.deepEqual((await listExportPresets()).map((p) => p.id), ["front-desk", "partners"]);
});

test("a preset sent without an id is named from its name, past live ids, ids in the same save and deleted ones", async () => {
  await saveExportPresets([
    { id: "front-desk", name: "Front desk", is_default: true },
    { id: "partners", name: "Partners" },
  ]);
  // Partners is deleted: its id is retired.
  await saveExportPresets([{ id: "front-desk", name: "Front desk", is_default: true }]);
  assert.ok((await retiredPresetIds()).has("partners"));
  const out = await saveExportPresets([
    { id: "front-desk", name: "Front desk", is_default: true },
    { name: "Partners" },
    { id: "", name: "Front desk" },
    { name: "Front desk" },
    { name: "  " },
  ]);
  assert.deepEqual(
    out.map((p) => p.id),
    ["front-desk", "partners-2", "front-desk-2", "front-desk-3", "directory"],
    "a retired id and a live one are both passed over; a blank name falls back to the stored name"
  );
});

test("the retired list keeps every id a save removes, and drops one that is live again", async () => {
  await saveExportPresets([
    { id: "a1", name: "A1", is_default: true },
    { id: "b1", name: "B1" },
    { id: "c1", name: "C1" },
  ]);
  await saveExportPresets([{ id: "a1", name: "A1", is_default: true }]);
  let retired = await retiredPresetIds();
  assert.ok(retired.has("b1") && retired.has("c1"));
  // Put back through the API with its id: live again, so no longer retired.
  await saveExportPresets([
    { id: "a1", name: "A1", is_default: true },
    { id: "b1", name: "B1" },
  ]);
  retired = await retiredPresetIds();
  assert.equal(retired.has("b1"), false);
  assert.ok(retired.has("c1"));
});

test("a duplicated id renumbered by the save passes over retired ids, and a '~' draft id is named like a new preset", async () => {
  await saveExportPresets([
    { id: "dup", name: "Dup", is_default: true },
    { id: "dup-2", name: "Dup two" },
  ]);
  await saveExportPresets([{ id: "dup", name: "Dup", is_default: true }]);
  assert.ok((await retiredPresetIds()).has("dup-2"));
  const out = await saveExportPresets([
    { id: "dup", name: "Dup", is_default: true },
    { id: "dup", name: "Dup again" },
    { id: "~draft-1", name: "Reception" },
  ]);
  assert.deepEqual(out.map((p) => p.id), ["dup", "dup-3", "reception"]);
});

test("two saves at once both land their retirements (saves run one at a time)", async () => {
  await saveExportPresets([
    { id: "keep", name: "Keep", is_default: true },
    { id: "x1", name: "X1" },
    { id: "y1", name: "Y1" },
  ]);
  await Promise.all([
    saveExportPresets([{ id: "keep", name: "Keep", is_default: true }, { id: "y1", name: "Y1" }]),
    saveExportPresets([{ id: "keep", name: "Keep", is_default: true }, { id: "x1", name: "X1" }]),
  ]);
  const retired = await retiredPresetIds();
  // Whichever ran second removed the id the first kept; both removals are recorded.
  assert.ok(retired.has("x1") || retired.has("y1"));
  const live = new Set((await listExportPresets()).map((p) => p.id));
  for (const id of ["x1", "y1"]) assert.ok(live.has(id) !== retired.has(id), `${id} is either live or retired, never both or neither`);
});

test("more saves at once than the pool has connections all finish (each save uses one connection)", async () => {
  await saveExportPresets([{ id: "keep", name: "Keep", is_default: true }]);
  const n = 8; // above the default pool of 5: a save that read through the pool while holding the lock's connection deadlocked here
  const outs = await Promise.all(
    Array.from({ length: n }, (_, i) => saveExportPresets([{ id: "keep", name: "Keep", is_default: true }, { name: `Burst ${i}` }]))
  );
  assert.equal(outs.length, n);
  // Each save replaced the list: the last one to run left its own preset; all the others' were retired.
  const live = await listExportPresets();
  assert.equal(live.length, 2);
  const retired = await retiredPresetIds();
  const burstIds = outs.map((o) => o[1].id);
  assert.equal(new Set(burstIds).size, n, `every save named its preset afresh: ${burstIds.join(", ")}`);
  assert.equal(burstIds.filter((id) => retired.has(id)).length, n - 1);
});
