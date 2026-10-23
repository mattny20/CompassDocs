// Saving export presets keeps every id distinct (1.15.0): download links name
// a preset by id, so two presets must never share one, and the de-duplication
// must finish. ["a", "a-3", "a"] used to retry "a-3" for the third preset
// forever, hanging the save.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/directory-export-presets.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getSetting, setSetting, pool } from "../src/lib/db";
import { getExportPreset, listExportPresets, saveExportPresets } from "../src/lib/directory-export-config";

const KEY = "directory_export_presets";
let saved: string | undefined;

before(async () => {
  await getSetting("__schema_bootstrap__");
  saved = await getSetting(KEY);
});

after(async () => {
  await pool().query("DELETE FROM settings WHERE key = $1", [KEY]);
  if (saved !== undefined) await setSetting(KEY, saved);
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
