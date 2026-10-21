// Program settings (E4, 1.10.1): the defaults every policy inherits.
// Round-trip through the settings table, COMPLIANCE_DEFAULTS applied when a
// key is absent or unreadable, an unknown key refused, and one
// settings.compliance audit row per changed key.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/compliance-settings.test.ts

// lib/ee as a licensed build sees it, installed before the route loads.
import "./support/ee-stub";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { pool, getSetting, setSetting, createRole, assignRole, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
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
    // (due_days became a known key in 1.13.0, E1: the unknown one here is
    // a key no build has.)
    await setSetting("ack_defaults", JSON.stringify({ edit_default: "never", keep_reason_required: false, cooldown_hours: 2 }));
    const s = await readComplianceSettings();
    assert.equal(s.ack_defaults.edit_default, "ask", "an unknown edit_default is the default");
    assert.equal(s.ack_defaults.keep_reason_required, false, "a valid sibling still counts");
    assert.ok(!("cooldown_hours" in s.ack_defaults), "unknown keys are not surfaced");
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
    // The default interval offers the Select's options only (a policy may choose 1..60 for itself).
    refused({ ack_defaults: { recert_months: 7 } }, "6, 12 or 24");
    refused({ ack_defaults: { recert_months: "12" } }, "6, 12 or 24");
    refused({ ack_defaults: { recert_months: 0 } }, "6, 12 or 24");
    refused({ ack_defaults: ["ask"] }, "must be an object");
    refused({ compliance_statement_default: "" }, "Enter a confirmation statement");
    refused({ compliance_statement_default: "x".repeat(301) }, "under 300 characters");
    refused({ compliance_statement_default: 42 }, "must be text");
    // The report block (F2, 1.14.0): its three keys, each checked; the
    // active-account rule on recipients is the route's (validateReportRecipients).
    refused({ ack_report: { enabled: "yes" } }, "must be true or false");
    refused({ ack_report: { cadence: "daily" } }, "weekly or monthly");
    refused({ ack_report: { recipients: [1, "2"] } }, "list of user ids");
    refused({ ack_report: { digest: true } }, 'Unknown setting "ack_report.digest"');
    refused({ ack_report: [] }, "must be an object");
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
    for (const months of [null, 6, 12, 24]) {
      const r = parseComplianceSettingsPatch({ ack_defaults: { recert_months: months } });
      assert.equal(r.ok, true, `recert_months ${months}`);
      if (r.ok) assert.deepEqual(r.patch, { ack_defaults: { recert_months: months } });
    }
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

  test("the default re-confirmation interval round-trips, rejects 7, and a hand-edited 7 reads as never", async () => {
    await clearKeys();
    assert.equal((await readComplianceSettings()).ack_defaults.recert_months, null, "never until an admin chooses");

    const { settings, changes } = await saveComplianceSettings({ ack_defaults: { recert_months: 12 } }, { actor });
    assert.equal(settings.ack_defaults.recert_months, 12);
    assert.deepEqual(changes, [{ key: "ack_defaults.recert_months", from: null, to: 12 }]);
    assert.equal((await readComplianceSettings()).ack_defaults.recert_months, 12, "a fresh read returns what was saved");
    assert.deepEqual(
      JSON.parse((await getSetting("ack_defaults"))!),
      { leads_see_policies: true, recert_months: 12 },
      "the first write of the row pins leads_see_policies to what the workspace read (F4)"
    );
    assert.equal(settings.ack_defaults.edit_default, "ask", "the siblings keep their defaults");

    const back = await saveComplianceSettings({ ack_defaults: { recert_months: null } }, { actor });
    assert.equal(back.settings.ack_defaults.recert_months, null);
    assert.deepEqual(back.changes, [{ key: "ack_defaults.recert_months", from: 12, to: null }]);
    assert.deepEqual(
      JSON.parse((await getSetting("ack_defaults"))!),
      { leads_see_policies: true, recert_months: null },
      "never is stored as null, not dropped"
    );

    // The route refuses 7 (parseComplianceSettingsPatch); a hand edit of 7
    // in the settings row is read as the default, like an unknown edit_default.
    const refused = parseComplianceSettingsPatch({ ack_defaults: { recert_months: 7 } });
    assert.equal(refused.ok, false);
    await setSetting("ack_defaults", JSON.stringify({ recert_months: 7, edit_default: "material" }));
    const read = await readComplianceSettings();
    assert.equal(read.ack_defaults.recert_months, null, "7 is not an option the build offers");
    assert.equal(read.ack_defaults.edit_default, "material", "a valid sibling still counts");
    await clearKeys();
    await pool().query("DELETE FROM audit_log WHERE action = 'settings.compliance' AND actor_name = $1", [STAMP]);
  });

  test("a first save without the key keeps leads on; a row without the key reads off and a later save leaves it so", async () => {
    await clearKeys();
    assert.equal((await readComplianceSettings()).ack_defaults.leads_see_policies, true, "no row: a new install reads on");
    const first = await saveComplianceSettings({ ack_defaults: { recert_months: 12 } }, { actor });
    assert.equal(first.settings.ack_defaults.leads_see_policies, true, "the first save of another key keeps it on");
    assert.deepEqual(first.changes.map((c) => c.key), ["ack_defaults.recert_months"], "the pinned key is not a change");
    assert.deepEqual(JSON.parse((await getSetting("ack_defaults"))!), { leads_see_policies: true, recert_months: 12 });
    const off = await saveComplianceSettings({ ack_defaults: { leads_see_policies: false } }, { actor });
    assert.equal(off.settings.ack_defaults.leads_see_policies, false);
    assert.deepEqual(off.changes, [{ key: "ack_defaults.leads_see_policies", from: true, to: false }]);

    // An upgraded workspace: a row without the key reads off, and a save of
    // another key merges over the row as it is (no key is seeded).
    await setSetting("ack_defaults", JSON.stringify({ edit_default: "material" }));
    assert.equal((await readComplianceSettings()).ack_defaults.leads_see_policies, false);
    await saveComplianceSettings({ ack_defaults: { recert_months: 6 } }, { actor });
    assert.deepEqual(JSON.parse((await getSetting("ack_defaults"))!), { edit_default: "material", recert_months: 6 });
    assert.equal((await readComplianceSettings()).ack_defaults.leads_see_policies, false, "still off until an admin turns it on");
    await clearKeys();
    await pool().query("DELETE FROM audit_log WHERE action = 'settings.compliance' AND actor_name = $1", [STAMP]);
  });
});

// --- The route ----------------------------------------------------------------
// PUT /api/admin/compliance/settings is called directly, as
// test/team-policies.test.ts calls its route: next/headers resolves to a stub
// serving the request under test, lib/ee to the licensed stub installed
// above. The report block (F2) is writable here as through PUT
// /api/admin/compliance/report, and with the same rule: every recipient an
// active account, checked before anything is written.

describe("PUT /api/admin/compliance/settings", () => {
  let currentRequest: Request | null = null;
  let route: typeof import("../src/app/api/admin/compliance/settings/route");
  let managerId = 0;
  let activeId = 0;
  let disabledId = 0;
  let roleId = 0;
  let token = "";
  let savedReport: string | undefined;

  before(async () => {
    const client = await pool().connect();
    await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
    lockClient = client;
    savedReport = await getSetting("ack_report");
    await pool().query("DELETE FROM settings WHERE key = 'ack_report'");

    const Module = (await import("node:module")).default;
    const path = (await import("node:path")).default;
    const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.compliance-settings.virtual.js");
    const jar = () => {
      const out = new Map<string, string>();
      for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
      }
      return out;
    };
    const headers = new Module(HEADERS_STUB);
    headers.filename = HEADERS_STUB;
    headers.loaded = true;
    headers.exports = {
      headers: async () => new Headers(currentRequest?.headers ?? {}),
      cookies: async () => {
        const c = jar();
        return {
          get: (name: string) => (c.has(name) ? { name, value: c.get(name) } : undefined),
          getAll: () => [...c].map(([name, value]) => ({ name, value })),
          has: (name: string) => c.has(name),
        };
      },
      draftMode: async () => ({ isEnabled: false }),
    };
    require.cache[HEADERS_STUB] = headers;
    const loader = Module as unknown as {
      _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
    };
    const resolveFilename = loader._resolveFilename;
    loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
      if (request === "next/headers") return HEADERS_STUB;
      return resolveFilename.call(this, request, parent, ...rest);
    };
    route = await import("../src/app/api/admin/compliance/settings/route");

    const users = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status) VALUES
         ($1, $2, $3, 'viewer', 'active'),
         ($4, $5, $6, 'viewer', 'active'),
         ($7, $8, $9, 'viewer', 'disabled')
       RETURNING id`,
      [
        `${STAMP}-mgr`,
        `Mgr ${STAMP}`,
        `${STAMP}-mgr@example.test`,
        `${STAMP}-active`,
        `Active ${STAMP}`,
        `${STAMP}-active@example.test`,
        `${STAMP}-gone`,
        `Gone ${STAMP}`,
        `${STAMP}-gone@example.test`,
      ]
    );
    [managerId, activeId, disabledId] = users.rows.map((r: { id: number }) => r.id);
    const role = await createRole({ name: `Programme manager ${STAMP}`, permissions: ["compliance.program_read", "compliance.program_manage"] });
    assert.ok("id" in role, "the custom role exists");
    roleId = (role as { id: number }).id;
    await assignRole({ roleId, userId: managerId });
    token = newToken();
    await createSession(token, managerId, new Date(Date.now() + 3_600_000).toISOString());
  });

  after(async () => {
    await pool().query("DELETE FROM settings WHERE key = 'ack_report'");
    if (savedReport !== undefined) await setSetting("ack_report", savedReport);
    await pool().query("DELETE FROM audit_log WHERE action = 'ack.report_settings' AND actor_id = $1", [managerId]);
    await pool().query("DELETE FROM sessions WHERE user_id = $1", [managerId]);
    if (roleId) await pool().query("DELETE FROM roles WHERE id = $1", [roleId]);
    await pool().query("DELETE FROM users WHERE id = ANY($1)", [[managerId, activeId, disabledId]]);
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
      lockClient.release();
      lockClient = null;
    }
  });

  async function put(body: unknown): Promise<{ status: number; body: any }> {
    const req = new Request("http://localhost/api/admin/compliance/settings", {
      method: "PUT",
      headers: { cookie: `compass_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    currentRequest = req;
    try {
      const res = await route.PUT(req);
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
      currentRequest = null;
    }
  }

  test("a report recipient that is not an active account is refused before anything is written; active ones save", async () => {
    let r = await put({ ack_report: { enabled: true, recipients: [disabledId] } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "Every recipient must be an active account.");
    assert.equal(await getSetting("ack_report"), undefined, "nothing was written");
    r = await put({ ack_report: { recipients: [activeId, 999_999_999] } });
    assert.equal(r.status, 400, "an id no account has");
    assert.equal(await getSetting("ack_report"), undefined);

    r = await put({ ack_report: { enabled: true, recipients: [activeId] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.settings.ack_report, { enabled: true, cadence: "weekly", recipients: [activeId] });
    assert.deepEqual(r.body.changed, ["ack_report.enabled", "ack_report.recipients"]);
    assert.deepEqual(JSON.parse((await getSetting("ack_report"))!), { enabled: true, cadence: "weekly", recipients: [activeId] });

    // A body without recipients does not run the check; an empty list clears them.
    r = await put({ ack_report: { cadence: "monthly" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.changed, ["ack_report.cadence"]);
    r = await put({ ack_report: { recipients: [] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.settings.ack_report, { enabled: true, cadence: "monthly", recipients: [] });
  });
});
