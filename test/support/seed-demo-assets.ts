// Demo data for assets on tickets (1.19.3): a fake Snipe-IT (test/support/
// fake-snipeit) with a small estate, synced into the real cache through the
// client, the workspace pointed at it, and Daniel Okafor's laptop linked to
// the tickets you name, with earlier history and maintenance on it.
//
//   DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json test/support/seed-demo-assets.ts \
//     --requester daniel.okafor@acme.example --link 1047 --history 988,731,402
//   DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json test/support/seed-demo-assets.ts --clean
//
// What it changes is recorded in the state file (--state, default
// /tmp/compassdocs-demo-assets.json) and --clean puts it all back: the asset
// rows it added, the links, and the workspace's asset settings as they were.
// The running app can't reach this fake (https only; local addresses are
// blocked), so its pages show the synced copy and say the source can't be
// reached; maintenance records live in the fake only.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { pool } from "../../src/lib/db";
import { fakeHardware, fakePerson, fakeSnipeItTransport, startFakeSnipeIt } from "./fake-snipeit";
import { setAssetTransportForTests } from "../../src/lib/helpdesk/assets/http";
import { saveAssetSettings, syncProvider } from "../../src/lib/helpdesk/assets";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const STATE = arg("state") ?? "/tmp/compassdocs-demo-assets.json";
const HOST = "assets.acme.example";
const KEY = "demo-snipe-it-key-not-real";

async function clean() {
  if (!existsSync(STATE)) return console.log("Nothing to clean.");
  const s = JSON.parse(readFileSync(STATE, "utf8")) as { settings: { key: string; value: string }[]; assetIds: number[] };
  await pool().query("DELETE FROM hd_assets WHERE id = ANY($1::int[])", [s.assetIds]);
  await pool().query("DELETE FROM settings WHERE key IN ('helpdesk_assets', 'helpdesk_assets_sync:snipeit')");
  for (const r of s.settings) await pool().query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [r.key, r.value]);
  unlinkSync(STATE);
  console.log(`Removed ${s.assetIds.length} demo assets and restored the asset settings.`);
}

async function seed() {
  const requester = (arg("requester") ?? "daniel.okafor@acme.example").toLowerCase();
  const link = (arg("link") ?? "").split(",").map(Number).filter(Boolean);
  const history = (arg("history") ?? "").split(",").map(Number).filter(Boolean);
  if (existsSync(STATE)) throw new Error(`${STATE} exists: run --clean first.`);
  const before = (await pool().query("SELECT key, value FROM settings WHERE key IN ('helpdesk_assets', 'helpdesk_assets_sync:snipeit')")).rows;
  const existing = new Set((await pool().query("SELECT id FROM hd_assets WHERE provider = 'snipeit'")).rows.map((r) => r.id as number));

  // Start from nothing saved, so pointing at the demo address doesn't retire an earlier source's cache (--clean restores it).
  await pool().query("DELETE FROM settings WHERE key = 'helpdesk_assets'");
  const fake = await startFakeSnipeIt(KEY);
  const daniel = fakePerson(1, requester, "Daniel Okafor");
  const people = [daniel, fakePerson(2, "priya.natarajan@acme.example", "Priya Natarajan"), fakePerson(3, "tom.becker@acme.example", "Tom Becker"), fakePerson(4, "grace.lin@acme.example", "Grace Lin")];
  fake.state.users.push(...people);
  const deployed = { id: 2, name: "Deployed", status_type: "deployable", status_meta: "deployed" };
  fake.state.hardware.push(
    fakeHardware(421, "ASSET", { name: "MacBook Pro 14 (2024)", asset_tag: "ASSET-00421", serial: "C02XK2Q1MD6R", assigned_to: daniel, status_label: deployed }),
    fakeHardware(877, "ASSET", { name: "iPhone 15", asset_tag: "ASSET-00877", serial: "F2LXK8Q1N72", model: { id: 3, name: "iPhone 15" }, category: { id: 3, name: "Mobile Phones" }, assigned_to: daniel, status_label: deployed, warranty_expires: { date: "2026-09-30" } }),
    fakeHardware(312, "ASSET", { name: "Dell U2723QE monitor", asset_tag: "ASSET-00312", serial: "CN0U2723QE312", model: { id: 4, name: "U2723QE" }, category: { id: 4, name: "Monitors" }, assigned_to: daniel, status_label: deployed, warranty_expires: { date: "2028-01-31" } })
  );
  for (let i = 1; i <= 36; i++) {
    const who = people[1 + (i % 3)];
    fake.state.hardware.push(fakeHardware(500 + i, "ASSET", { asset_tag: `ASSET-${String(500 + i).padStart(5, "0")}`, name: i % 4 === 0 ? "ThinkPad X1 Carbon" : "MacBook Air 13 (2023)", assigned_to: i % 5 === 0 ? null : who, status_label: i % 5 === 0 ? { id: 1, name: "Ready to Deploy", status_type: "deployable", status_meta: "deployable" } : deployed }));
  }
  fake.state.suppliers.push({ id: 1, name: "Apple" }, { id: 2, name: "CDW" });
  setAssetTransportForTests(fakeSnipeItTransport(fake.port, HOST));
  try {
    await saveAssetSettings({ url: `https://${HOST}`, api_key: KEY, on_solve: "offer_maintenance", agents_search_all: true });
    const r = await syncProvider("snipeit", { force: true });
    if (!r.ok) throw new Error(r.error);
    const added = (await pool().query("SELECT id FROM hd_assets WHERE provider = 'snipeit'")).rows.map((x) => x.id as number).filter((id) => !existing.has(id));
    writeFileSync(STATE, JSON.stringify({ settings: before, assetIds: added }, null, 2));
    const laptop = (await pool().query("SELECT id FROM hd_assets WHERE provider = 'snipeit' AND external_id = '421'")).rows[0].id as number;
    for (const n of [...link, ...history]) {
      const t = (await pool().query("SELECT id FROM hd_tickets WHERE number = $1", [n])).rows[0];
      if (!t) {
        console.log(`No ticket #${n}; skipped.`);
        continue;
      }
      await pool().query("INSERT INTO hd_ticket_assets (ticket_id, asset_id, linked_by_name) VALUES ($1, $2, 'Demo') ON CONFLICT DO NOTHING", [t.id, laptop]);
    }
    console.log(`Synced ${r.seen} demo assets from https://${HOST}; linked ASSET-00421 to ${[...link, ...history].map((n) => `#${n}`).join(", ") || "no tickets"}. State: ${STATE}`);
  } finally {
    setAssetTransportForTests(null);
    await fake.close();
  }
}

(process.argv.includes("--clean") ? clean() : seed())
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
