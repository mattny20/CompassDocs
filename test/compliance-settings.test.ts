// Program settings (E4, 1.10.1): the defaults every policy inherits.
// Round-trip through the settings table, COMPLIANCE_DEFAULTS applied when a
// key is absent or unreadable, an unknown key refused, and one
// settings.compliance audit row per changed key.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/compliance-settings.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { pool, getSetting, setSetting } from "../src/lib/db";
import {
  COMPLIANCE_DEFAULTS,
  getComplianceSettings,
  readComplianceSettings,
  parseComplianceSettingsPatch,
  saveComplianceSettings,
} from "../src/lib/compliance-settings";

const KEYS = ["ack_defaults", "compliance_statement_default", "ack_report"];
const STAMP = `compset-${Date.now()}`;
const actor = { id: null, name: STAMP, role: "admin" };

/**
 * The settings row is shared with test/ack-revision.test.ts (its A5
 * describe writes ack_defaults), and node:test runs files in parallel: one
 * advisory lock, held on a dedicated connection for the length of each
 * describe, keeps the two from restoring each other's values.
 */
const SETTINGS_LOCK = 728342;
let lockClient: PoolClient | null = null;

/** What the shared database held before the suite, restored after it. */
const saved = new Map<string, string>();

async function clearKeys() {
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
}

async function auditRows() {
  const r = await pool().query<{ target_id: string; details: { key: string; from: unknown; to: unknown } }>(
    "SELECT target_id, details FROM audit_log WHERE action = 'settings.compliance' AND actor_name = $1 ORDER BY id",
    [STAMP]
  );
  return r.rows;
}

describe("program settings", () => {
  before(async () => {
    await getSetting("__schema_bootstrap__"); // run the schema and migrations first
    const client = await pool().connect();
    await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
    lockClient = client;
    for (const key of KEYS) {
      const v = await getSetting(key);
      if (v !== undefined) saved.set(key, v);
    }
    await clearKeys();
  });

  after(async () => {
    await clearKeys();
    for (const [key, value] of saved) await setSetting(key, value);
    await pool().query("DELETE FROM audit_log WHERE action = 'settings.compliance' AND actor_name = $1", [STAMP]);
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
      lockClient.release();
    }
  });

  test("defaults apply when a key is absent, unreadable or holds a value the build does not know", async () => {
    await clearKeys();
    assert.deepEqual(await readComplianceSettings(), COMPLIANCE_DEFAULTS, "nothing stored: the defaults");
    // getComplianceSettings is the per-request reader (React cache()); outside
    // a request it memoises nothing, so this only proves it reads the same
    // values, not that a stale cache is detected.
    assert.deepEqual(await getComplianceSettings(), COMPLIANCE_DEFAULTS, "the per-request reader reads the same values");

    await setSetting("ack_defaults", "not json");
    await setSetting("compliance_statement_default", "   ");
    await setSetting("ack_report", "[1,2]");
    assert.deepEqual(await readComplianceSettings(), COMPLIANCE_DEFAULTS, "unreadable rows fall back key by key");

    // A value from a later build, or a hand edit, never takes a known key
    // off its default; keys the build does not know are ignored on read.
    await setSetting("ack_defaults", JSON.stringify({ edit_default: "never", keep_reason_required: false, due_days: 14 }));
    const s = await readComplianceSettings();
    assert.equal(s.ack_defaults.edit_default, "ask", "an unknown edit_default is the default");
    assert.equal(s.ack_defaults.keep_reason_required, false, "a valid sibling still counts");
    assert.ok(!("due_days" in s.ack_defaults), "unknown keys are not surfaced");
    await clearKeys();
  });

  test("a save round-trips, normalises the statement and keeps keys it does not own", async () => {
    await clearKeys();
    // A key a later card will write: the save must merge over it, not replace it.
    await setSetting("ack_defaults", JSON.stringify({ due_days: 21 }));

    const { settings, changes } = await saveComplianceSettings(
      {
        ack_defaults: { edit_default: "material", keep_reason_required: false },
        compliance_statement_default: "  I have read   this policy\nand will follow it.  ",
      },
      { actor }
    );
    assert.equal(settings.ack_defaults.edit_default, "material");
    assert.equal(settings.ack_defaults.keep_reason_required, false);
    assert.equal(settings.compliance_statement_default, "I have read this policy and will follow it.");
    assert.deepEqual(settings.ack_report, COMPLIANCE_DEFAULTS.ack_report, "the report keys are untouched");
    assert.deepEqual(
      changes.map((c) => c.key),
      ["ack_defaults.edit_default", "ack_defaults.keep_reason_required", "compliance_statement_default"]
    );

    assert.deepEqual(await readComplianceSettings(), settings, "a fresh read returns what was saved");
    const stored = JSON.parse((await getSetting("ack_defaults"))!);
    assert.deepEqual(stored, { due_days: 21, edit_default: "material", keep_reason_required: false });
    assert.equal(await getSetting("compliance_statement_default"), "I have read this policy and will follow it.");

    // A partial save touches only what it names.
    const second = await saveComplianceSettings({ ack_defaults: { edit_default: "reset" } }, { actor });
    assert.equal(second.settings.ack_defaults.edit_default, "reset");
    assert.equal(second.settings.ack_defaults.keep_reason_required, false, "the sibling stayed");
    assert.equal(second.settings.compliance_statement_default, "I have read this policy and will follow it.");
    await clearKeys();
  });

  test("an unknown key, a wrong type or an empty statement is refused; a valid body passes", () => {
    const refused = (body: unknown, fragment: string) => {
      const r = parseComplianceSettingsPatch(body);
      assert.equal(r.ok, false, `${JSON.stringify(body)} should be refused`);
      if (!r.ok) assert.match(r.error, new RegExp(fragment), `${JSON.stringify(body)}: ${r.error}`);
    };
    refused({ cooldown_hours: 2 }, 'Unknown setting "cooldown_hours"');
    refused({ ack_defaults: { edit_default: "ask", nope: true } }, 'Unknown setting "ack_defaults.nope"');
    refused({ ack_defaults: { edit_default: "never" } }, "ask, material or reset");
    refused({ ack_defaults: { keep_reason_required: "yes" } }, "true or false");
    refused({ ack_defaults: ["ask"] }, "must be an object");
    refused({ compliance_statement_default: "" }, "Enter a confirmation statement");
    refused({ compliance_statement_default: "x".repeat(301) }, "under 300 characters");
    refused({ compliance_statement_default: 42 }, "must be text");
    // Read with its default, but not writable until F2's Evidence card ships.
    refused({ ack_report: { enabled: true } }, 'Unknown setting "ack_report"');
    refused(null, "JSON object");
    refused([], "JSON object");
    refused("ask", "JSON object");

    const ok = parseComplianceSettingsPatch({
      ack_defaults: { edit_default: "material" },
      compliance_statement_default: " I confirm. ",
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.deepEqual(ok.patch, { ack_defaults: { edit_default: "material" }, compliance_statement_default: "I confirm." });
    }
    const empty = parseComplianceSettingsPatch({});
    assert.equal(empty.ok, true, "nothing to change is not an error");
  });

  test("one settings.compliance audit row per changed key, none for a key sent unchanged", async () => {
    await clearKeys();
    await pool().query("DELETE FROM audit_log WHERE action = 'settings.compliance' AND actor_name = $1", [STAMP]);

    // Two of the three keys change; keep_reason_required is sent with its default.
    const first = await saveComplianceSettings(
      {
        ack_defaults: { edit_default: "reset", keep_reason_required: true },
        compliance_statement_default: "I have read and understood this policy.",
      },
      { actor, ip: "203.0.113.7" }
    );
    assert.deepEqual(
      first.changes.map((c) => c.key),
      ["ack_defaults.edit_default", "compliance_statement_default"]
    );
    let rows = await auditRows();
    assert.equal(rows.length, 2, "one row per changed key");
    assert.deepEqual(
      rows.map((r) => r.details),
      [
        { key: "ack_defaults.edit_default", from: "ask", to: "reset" },
        {
          key: "compliance_statement_default",
          from: COMPLIANCE_DEFAULTS.compliance_statement_default,
          to: "I have read and understood this policy.",
        },
      ]
    );
    assert.deepEqual(
      rows.map((r) => r.target_id),
      ["ack_defaults.edit_default", "compliance_statement_default"]
    );
    const ip = await pool().query("SELECT ip FROM audit_log WHERE action = 'settings.compliance' AND actor_name = $1", [STAMP]);
    assert.ok(ip.rows.every((r) => r.ip === "203.0.113.7"));

    // Saving the same values again changes nothing and writes nothing.
    const again = await saveComplianceSettings(
      {
        ack_defaults: { edit_default: "reset", keep_reason_required: true },
        compliance_statement_default: "I have read and understood this policy.",
      },
      { actor }
    );
    assert.deepEqual(again.changes, []);
    rows = await auditRows();
    assert.equal(rows.length, 2, "no row for a no-op save");

    // Flipping one toggle writes exactly one more.
    await saveComplianceSettings({ ack_defaults: { keep_reason_required: false } }, { actor });
    rows = await auditRows();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[2].details, { key: "ack_defaults.keep_reason_required", from: true, to: false });
    await clearKeys();
  });
});
