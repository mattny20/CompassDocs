// Helpdesk 1.19.1 shortcut defaults (agent V5, mock-up #7): Desk settings →
// Shortcuts picks the request type each CompassDocs trigger opens, or
// Hidden; E's trigger resolution reads it first and falls back to the
// 1.19.0 slug and category rule. Request access takes only a "Request
// access" type (its workflow asks the space's owner), the S1 rule.
//
// The setting is workspace-wide (settings key helpdesk_shortcuts), so this
// file holds an advisory lock while it changes it and restores the value it
// found; every request type, workflow and account is its own (STAMP).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-shortcuts.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import type { PoolClient } from "pg";
import { pool, getSetting, setSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import { HD_SHORTCUTS_KEY, normalizeShortcuts, shortcutTypeLabel } from "../src/lib/helpdesk/shortcuts-shared";

// --- Request scope and licence stubs ---------------------------------------------------

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-shortcuts.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-shortcuts.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const jar = () => {
    const m = new Map<string, string>();
    for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) m.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
    }
    return m;
  };
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const j = jar();
      return { get: (n: string) => (j.has(n) ? { name: n, value: j.get(n) } : undefined), getAll: () => [...j].map(([name, value]) => ({ name, value })), has: (n: string) => j.has(n) };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (r: string, p: { filename?: string } | null, ...rest: unknown[]) => string };
  const orig = loader._resolveFilename;
  loader._resolveFilename = function (r: string, p: { filename?: string } | null, ...rest: unknown[]) {
    if (r === "next/headers") return HEADERS_STUB;
    if (r === "@/lib/ee") return EE_STUB;
    if ((r === "./ee" || r === "../ee") && p?.filename && path.resolve(path.dirname(p.filename), r) === EE_REAL) return EE_STUB;
    return orig.call(this, r, p, ...rest);
  };
}
/* eslint-disable @typescript-eslint/no-require-imports */
const shortcuts = require("../src/lib/helpdesk/shortcuts") as typeof import("../src/lib/helpdesk/shortcuts");
const triggerType = require("../src/components/helpdesk/help/trigger-type") as typeof import("../src/components/helpdesk/help/trigger-type");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const route = require("../src/app/api/helpdesk/admin/shortcuts/route") as typeof import("../src/app/api/helpdesk/admin/shortcuts/route");
/* eslint-enable @typescript-eslint/no-require-imports */

const STAMP = `hdsc-${Date.now()}-${process.pid}`;
/** Held while this file changes helpdesk_shortcuts (another run of it waits). */
const SHORTCUTS_TEST_LOCK = 7_281_953;
let lockClient: PoolClient | null = null;
let original: string | undefined;
let teamId = 0;
let adminId = 0;
let adminSession = "";
let plainId = 0;
let groupId = 0;
let problemType = 0;
let hiddenGroupType = 0;
let accessType = 0;
let accessWorkflow = 0;
const typeIds: number[] = [];
const workflowIds: number[] = [];
const userIds: number[] = [];

async function user(key: string): Promise<number> {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $1, $2, 'viewer', 'active') RETURNING id`, [`${STAMP}-${key}`, `${STAMP}-${key}@example.test`]);
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function type(title: string, extra: Record<string, unknown> = {}): Promise<number> {
  const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} ${title}`, team_id: teamId, form: [], ...extra });
  assert.ok(input.ok, !input.ok ? input.error : "");
  const rt = await requestTypes.createRequestType(input.value);
  typeIds.push(rt.id);
  return rt.id;
}

async function call(method: "GET" | "PUT", body?: unknown, session = adminSession): Promise<{ status: number; body: any }> {
  currentRequest = new Request("http://localhost/api/helpdesk/admin/shortcuts", {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const res = method === "GET" ? await route.GET() : await route.PUT(currentRequest);
    return { status: res.status, body: await res.json() };
  } finally {
    currentRequest = null;
  }
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  lockClient = await pool().connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [SHORTCUTS_TEST_LOCK]);
  original = await getSetting(HD_SHORTCUTS_KEY);
  teamId = (await pool().query("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} Knowledge team`])).rows[0].id;
  adminId = await user("admin");
  plainId = await user("plain");
  await pool().query(`INSERT INTO role_assignments (role_id, user_id, scope_type) SELECT id, $1, 'global' FROM roles WHERE key = 'helpdesk-manager'`, [adminId]);
  adminSession = newToken();
  await createSession(adminSession, adminId, new Date(Date.now() + 3_600_000).toISOString());
  groupId = (await pool().query("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} group`])).rows[0].id;
  problemType = await type("Content problem");
  hiddenGroupType = await type("Leaders only", { visibility: "groups", group_ids: [groupId] });
  // A "Request access" type: its published workflow asks the space's owner.
  const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} Access` });
  assert.ok(meta.ok);
  const def = workflows.parseWorkflowDefinition({
    trigger: {},
    steps: [
      { key: "approve", kind: "approval", title: "The owner approves", approver: { kind: "space_owner" }, on_decline: "close" },
      { key: "done", kind: "finish", title: "Done" },
    ],
  });
  assert.ok(def.ok);
  const wf = await workflows.createWorkflow(meta.value, def.value);
  accessWorkflow = wf.id;
  workflowIds.push(wf.id);
  accessType = await type("Access to a space", { workflow_id: wf.id });
  assert.ok((await workflows.publishWorkflow(wf.id)).ok);
});

after(async () => {
  if (original === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [HD_SHORTCUTS_KEY]);
  else await setSetting(HD_SHORTCUTS_KEY, original);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1::int[])", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1::int[])", [workflowIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = $1", [teamId]);
  await pool().query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool().query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]);
  await lockClient?.query("SELECT pg_advisory_unlock($1)", [SHORTCUTS_TEST_LOCK]);
  lockClient?.release();
  await pool().end();
});

describe("the stored value", () => {
  test("normalised: unknown keys and bad values read as automatic", () => {
    assert.deepEqual(normalizeShortcuts({ doc: 12, link: "hidden", handbook: "x", space_access: -3, other: 1 }), { doc: 12, handbook: null, space_access: null, link: "hidden" });
    assert.deepEqual(normalizeShortcuts("nonsense"), { doc: null, handbook: null, space_access: null, link: null });
  });

  test("labels follow the mock-up", () => {
    assert.equal(shortcutTypeLabel({ title: "Content problem", team_name: "Knowledge team", access: false }), "Content problem · Knowledge team");
    assert.equal(shortcutTypeLabel({ title: "Access to a space", team_name: "IT", access: true }), "Access to a space · approved by its owner");
  });
});

describe("trigger resolution", () => {
  test("a chosen type comes first; one the person can't use falls back to the 1.19.0 rule", async () => {
    await shortcuts.saveShortcuts({ doc: problemType, link: hiddenGroupType });
    const doc = await triggerType.triggerRequestType({ id: plainId }, "doc");
    assert.equal(doc?.id, problemType);
    const usable = await requestTypes.listRequestTypesForUser({ id: plainId });
    const automatic = await triggerType.automaticTriggerType("link", usable);
    const link = await triggerType.triggerRequestType({ id: plainId }, "link");
    assert.equal(link?.id ?? null, automatic?.id ?? null, "not in the group: the automatic choice");
    assert.notEqual(link?.id, hiddenGroupType);
    await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, plainId]);
    assert.equal((await triggerType.triggerRequestType({ id: plainId }, "link"))?.id, hiddenGroupType, "in the group: the chosen type");
  });

  test("Hidden is stored and read back; automatic clears it", async () => {
    await shortcuts.saveShortcuts({ handbook: "hidden" });
    assert.equal(await shortcuts.shortcutChoice("handbook"), "hidden");
    assert.equal(await shortcuts.configuredShortcut("handbook", [{ id: problemType }]), "hidden");
    await shortcuts.saveShortcuts({ handbook: null });
    assert.equal(await shortcuts.shortcutChoice("handbook"), null);
  });

  test("Request access takes only an access type, and falls back if its workflow stops asking the owner", async () => {
    await assert.rejects(shortcuts.saveShortcuts({ space_access: problemType }), /asks the space's owner/);
    await shortcuts.saveShortcuts({ space_access: accessType });
    assert.equal((await triggerType.triggerRequestType({ id: plainId }, "space_access"))?.id, accessType);
    // Its workflow is changed to a plain approval: the choice no longer applies.
    await pool().query(`UPDATE hd_workflows SET definition = jsonb_set(definition, '{steps,0,approver}', '{"kind":"manager"}') WHERE id = $1`, [accessWorkflow]);
    assert.equal(await shortcuts.configuredShortcut("space_access", [{ id: accessType }]), null);
  });
});

describe("Desk settings → Shortcuts API", () => {
  test("settings.manage reads and saves; the save is audited; bad choices are refused", async () => {
    const view = await call("GET");
    assert.equal(view.status, 200);
    assert.ok(view.body.types.some((t: { id: number; access: boolean }) => t.id === problemType && !t.access));
    assert.ok("automatic" in view.body);
    const bad = await call("PUT", { space_access: problemType });
    assert.equal(bad.status, 400);
    const unknown = await call("PUT", { sidebar: 1 });
    assert.equal(unknown.status, 400);
    const ok = await call("PUT", { doc: "hidden", link: problemType });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.shortcuts.doc, "hidden");
    assert.equal(ok.body.shortcuts.link, problemType);
    const a = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.shortcuts.updated' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [adminId]);
    assert.equal(a.rows[0].details.doc.to, "hidden");
    const plainSession = newToken();
    await createSession(plainSession, plainId, new Date(Date.now() + 3_600_000).toISOString());
    assert.equal((await call("GET", undefined, plainSession)).status, 403);
  });
});
