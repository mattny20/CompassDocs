// Helpdesk 1.20.2: the Integrations hub's statuses (lib/helpdesk/integrations-hub).
//   - an admin gets every tile, each with a status computed from that
//     integration's own data (Snipe-IT, Intune, the chat apps, Claude, the
//     API, alert sources);
//   - a role that opens only some pages gets only those tiles: nothing
//     about a page it could not open before is in the answer;
//   - the catalogue: every tile's address is under the hub (or the page it
//     always had), the reserved segments never clash with a source's id,
//     and each page that moved has somewhere to redirect to.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-integrations-hub.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting } from "../src/lib/db";
import { fixtureQuery } from "./support/retry";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-integrations-hub.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "@/lib/ee") return EE_STUB;
    if (parent?.filename && request.startsWith(".") && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const hub = require("../src/lib/helpdesk/integrations-hub") as typeof import("../src/lib/helpdesk/integrations-hub");
const shared = require("../src/lib/helpdesk/integrations-hub-shared") as typeof import("../src/lib/helpdesk/integrations-hub-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const assets = require("../src/lib/helpdesk/assets") as typeof import("../src/lib/helpdesk/assets");
const connector = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
/* eslint-enable @typescript-eslint/no-require-imports */

const STAMP = `hdhub${Date.now().toString(36)}${process.pid}`;
const ids: number[] = [];
const U: Record<string, { id: number; role: "viewer" }> = {};

async function person(key: string, deskRole: string) {
  const r = await fixtureQuery("INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id", [`${STAMP}-${key}`, `${key} ${STAMP}`, `${STAMP}-${key}@example.test`]);
  ids.push(r.rows[0].id);
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2)", [r.rows[0].id, deskRole]);
  U[key] = { id: r.rows[0].id, role: "viewer" };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  await person("admin", "admin");
  await person("manager", "manager");
  await person("agent", "agent");
  assets.setIntuneCredentialsForTests(null);
  connector.setClaudeLevelForTests("notes");
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  assets.setAssetSettingsForTests(null);
  assets.setIntuneCredentialsForTests(undefined);
  connector.setClaudeLevelForTests(null);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  await pool().end();
});

describe("the catalogue", () => {
  test("tiles, groups, reserved segments and the pages that moved", () => {
    const keys = shared.HUB_TILES.map((t) => t.key);
    assert.deepEqual(keys, ["snipe-it", "intune", "assets", "teams", "slack", "claude-connector", "claude-desk", "api-tokens", "webhooks", "alerts"]);
    assert.equal(new Set(keys).size, keys.length);
    for (const t of shared.HUB_TILES) {
      assert.ok(shared.HUB_GROUPS.some((g) => g.key === t.group), t.key);
      // Under the hub, except Claude in the desk, which keeps its own page and rail entry.
      assert.ok(t.href.startsWith(`${shared.INTEGRATIONS_HUB}/`) || t.key === "claude-desk", t.href);
      const seg = t.href.startsWith(shared.INTEGRATIONS_HUB) ? t.href.slice(shared.INTEGRATIONS_HUB.length + 1).split(/[#/?]/)[0] : "";
      if (seg) assert.ok((shared.HUB_RESERVED as readonly string[]).includes(seg), `${seg} is reserved`);
      assert.ok(t.description.length > 20 && !t.description.includes("—"));
    }
    // A reserved segment is never a number, so /integrations/<id> (an alert source) can't clash.
    for (const s of shared.HUB_RESERVED) assert.ok(!/^\d+$/.test(s), s);
    assert.deepEqual(Object.keys(shared.MOVED_SETTINGS).sort(), ["/desk/settings/api", "/desk/settings/assets", "/desk/settings/chat", "/desk/settings/claude"]);
    for (const to of Object.values(shared.MOVED_SETTINGS)) assert.ok(to === shared.INTEGRATIONS_HUB || to.startsWith(`${shared.INTEGRATIONS_HUB}/`));
  });
});

describe("statuses", () => {
  const settings = (over: Partial<import("../src/lib/helpdesk/assets").AssetSettings> = {}) => ({
    snipeit: { url: "", token: "", on_solve: "nothing" as const },
    agents_search_all: true,
    cache_source: "",
    intune: { on: false, cache_source: "" },
    ...over,
  });

  test("an admin sees every tile, each with its own state", async () => {
    roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
    assets.setAssetSettingsForTests(settings());
    const tiles = await hub.integrationsHub(U.admin as never);
    assert.deepEqual(Object.keys(tiles).sort(), shared.HUB_TILES.map((t) => t.key).sort());
    assert.deepEqual(tiles["snipe-it"], { status: "not_set_up", note: "" });
    assert.deepEqual(tiles.intune, { status: "not_set_up", note: "" });
    assert.deepEqual(tiles.assets, { status: "none", note: "Agents can search all assets" });
    assert.deepEqual(tiles["claude-connector"], { status: "connected", note: "Reads and adds notes" });
    for (const t of Object.values(tiles)) assert.ok(["connected", "not_set_up", "attention", "none"].includes(t!.status));
    // Snipe-IT connected (never synced: no failure), and an agents-see-less setting.
    assets.setAssetSettingsForTests(settings({ snipeit: { url: "https://snipe.test", token: "k".repeat(40), on_solve: "nothing" }, agents_search_all: false }));
    const now = await hub.integrationsHub(U.admin as never);
    assert.equal(now["snipe-it"]!.status, "connected");
    assert.match(now["snipe-it"]!.note, /^\d[\d,]* assets?$/);
    assert.equal(now.assets!.note, "Agents see their people's assets");
    // Intune that was on the directory sync app, which is gone: it needs a look, and says what.
    assets.setIntuneCredentialsForTests(undefined);
    assets.setAssetSettingsForTests(settings({ intune: { on: true, cache_source: "tid", cred_tag: "x" } }));
    assert.deepEqual((await hub.integrationsHub(U.admin as never)).intune, { status: "attention", note: "Needs its own app registration." });
    assets.setIntuneCredentialsForTests(null);
  });

  test("a role that opens only some pages gets only those tiles; one that opens none gets none", async () => {
    assets.setAssetSettingsForTests(settings());
    // A manager with the email channel's capability but not settings.manage: alert sources only.
    const m = roles.HD_DEFAULT_MATRIX;
    roles.setRoleMatrixForTests({ ...m, manager: [...m.manager.filter((c) => c !== "settings.manage" && c !== "channels.manage"), "channels.manage"] });
    assert.deepEqual(Object.keys(await hub.integrationsHub(U.manager as never)), ["alerts"]);
    // With settings.manage instead: everything (it covers every settings page).
    roles.setRoleMatrixForTests({ ...m, manager: [...m.manager.filter((c) => c !== "settings.manage" && c !== "channels.manage"), "settings.manage"] });
    assert.equal(Object.keys(await hub.integrationsHub(U.manager as never)).length, shared.HUB_TILES.length);
    roles.setRoleMatrixForTests(m);
    assert.deepEqual(await hub.integrationsHub(U.agent as never), {});
  });
});
