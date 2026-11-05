// Policy handbooks (1.18.0): the data, access and API layer (lib/handbooks,
// the "Handbooks 1.18.0" block of lib/db, src/app/api/handbooks/**).
//
// Who builds: handbook.manage held globally (the Administrator preset)
// owns workspace handbooks; assigned on one space it owns that space's
// handbooks, from documents in the spaces where it is held, and never a
// space its holder cannot read. Who reads: a published handbook's
// audience (everyone / the space's readers / chosen groups) and its
// editors at any status. Reading a handbook opens its documents through
// the handbook (handbookGrantsRead, getHandbookPolicy) without the
// document's space. "Where people find it" lives on the document and the
// no-orphans rule makes handbook_only count only while a published
// handbook holds it. Contents are rewritten under the handbook's lock; the
// whole-handbook confirmation record is keyed by a fingerprint of the
// published items' current versions.
//
// Fixtures: two private spaces granted to this file's own groups and one
// internal space; this file's own people and a custom role holding
// handbook.manage, assigned on one space. Route handlers are called
// directly with next/headers stubbed to serve the request under test and
// lib/ee stubbed to grant policy_ack (as test/ack-sets.test.ts does).
//
// No administrator account (integration files share one database and run
// in parallel, and an administrator reads every private space, so joins
// every private-space policy's audience and other files' exact counts).
// The workspace's handbook admin is `wsAdmin`, a viewer holding a custom
// role with handbook.manage GLOBALLY (what the Administrator preset gives
// for handbooks) and reading spaces A and B through this file's group gW.
// A policy switched on here is in space A, asked of this file's people, and
// held only by handbooks whose audience is this file's groups.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/handbooks.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import {
  pool,
  getSetting,
  createDocument,
  createGroup,
  addGroupMember,
  setSpaceGroups,
  createSession,
  createRole,
  assignRole,
  deleteRole,
  hasOpenAssignment,
  createChangeRequest,
  approveChangeRequest,
  updateDocument,
  updatePolicySettings,
  updateSpace,
  listVersions,
  getPolicySettings,
  complianceDocs,
} from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";
import type { HandbookUser } from "../src/lib/handbooks";

// --- The request scope outside Next ------------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.handbooks.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.handbooks.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;

  const edition = { present: true, features: ["policy_ack"] };
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;

  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

// Loaded after the stubs are in place (lib/handbooks reads lib/ee).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hb = require("../src/lib/handbooks") as typeof import("../src/lib/handbooks");

type Answer = { status: number; body: any };

async function call(run: () => Promise<Response>, req: Request): Promise<Answer> {
  currentRequest = req;
  try {
    const res = await run();
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON body */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

function request(method: string, url: string, session: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.45" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

// --- Fixtures -------------------------------------------------------------------

const STAMP = `handbooks-${Date.now()}`;

let spaceA = 0; // private, granted to gA (alice, mgrA)
let spaceB = 0; // private, granted to gB (bob)
let spaceI = 0; // internal
let gA = 0;
let gB = 0;
let gReaders = 0; // carol
let gW = 0; // wsAdmin: reads A and B
let roleId = 0;
let globalRoleId = 0;
const people: Record<string, number> = {};
const userIds: number[] = [];
const docIds: number[] = [];
const handbookIds: number[] = [];
const sessions: Record<string, string> = {};
const docs: Record<string, number> = {};

const as = (tag: string): HandbookUser => ({ id: people[tag], role: (roles[tag] ?? "viewer") as HandbookUser["role"], name: `${tag} ${STAMP}` });
const roles: Record<string, string> = {};

async function newPerson(tag: string, role = "viewer"): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [`${STAMP}-${tag}`, `${tag} ${STAMP}`, `${STAMP}-${tag}@example.test`, role]
  );
  people[tag] = r.rows[0].id;
  roles[tag] = role;
  userIds.push(r.rows[0].id);
  const token = newToken();
  await createSession(token, r.rows[0].id, new Date(Date.now() + 3600_000).toISOString());
  sessions[tag] = token;
  return r.rows[0].id;
}

async function newDoc(tag: string, spaceId: number, opts: { type?: "policy" | "knowledge"; status?: "published" | "draft" } = {}): Promise<number> {
  const doc = await createDocument({
    space_id: spaceId,
    title: `${STAMP} ${tag}`,
    type: opts.type ?? "policy",
    status: opts.status ?? "published",
    content: `# ${tag}\n\nStaff must follow this.`,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  docs[tag] = doc.id;
  return doc.id;
}

function track<T extends { id: number }>(h: T): T {
  if (!handbookIds.includes(h.id)) handbookIds.push(h.id);
  return h;
}

const input = (over: Partial<import("../src/lib/handbooks").HandbookInput> = {}) => ({
  title: `${STAMP} Handbook`,
  space_id: null,
  introduction: "Welcome.",
  audience: "all" as const,
  group_ids: [],
  confirm_whole: false,
  require_signature: false,
  ...over,
});

async function auditActions(handbookId: number): Promise<string[]> {
  const r = await pool().query(
    "SELECT action FROM audit_log WHERE target_type = 'handbook' AND target_id = $1 ORDER BY id",
    [String(handbookId)]
  );
  return r.rows.map((x: { action: string }) => x.action);
}

async function expectError(p: Promise<unknown>, status: number, message?: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof hb.HandbookError, `expected HandbookError, got ${String(e)}`);
    assert.equal(e.status, status);
    if (message) assert.equal(e.message, message);
    return true;
  });
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const mk = async (name: string, visibility: string) =>
    (
      await fixtureQuery("INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', $3) RETURNING id", [
        `${name} ${STAMP}`,
        `${STAMP}-${name.toLowerCase()}`,
        visibility,
      ])
    ).rows[0].id as number;
  spaceA = await mk("A", "private");
  spaceB = await mk("B", "private");
  spaceI = await mk("I", "internal");
  for (const tag of ["wsAdmin", "alice", "bob", "carol", "dave", "mgrA", "owen", "sam", "rita", "subm", "appr"]) await newPerson(tag);
  await newPerson("ed", "editor"); // edits the internal space, may not publish (approval mode strict)
  await newPerson("pub", "approver"); // edits and publishes there
  gA = (await createGroup({ name: `${STAMP} GA` })).id;
  gB = (await createGroup({ name: `${STAMP} GB` })).id;
  gReaders = (await createGroup({ name: `${STAMP} Readers` })).id;
  gW = (await createGroup({ name: `${STAMP} GW` })).id;
  await addGroupMember(gA, people.alice);
  await addGroupMember(gA, people.mgrA);
  await addGroupMember(gB, people.bob);
  await addGroupMember(gReaders, people.carol);
  await addGroupMember(gW, people.wsAdmin);
  // The policy-owner candidates read space A (an owner must, as the Settings tab checks).
  for (const tag of ["owen", "sam", "rita"]) await addGroupMember(gA, people[tag]);
  await setSpaceGroups(spaceA, [gA, gW]);
  await setSpaceGroups(spaceB, [gB, gW]);

  const global = await createRole({ name: `${STAMP} Workspace handbook admin`, permissions: ["handbook.manage"] });
  assert.ok("id" in global, "custom global role created");
  globalRoleId = global.id;
  await assignRole({ roleId: globalRoleId, userId: people.wsAdmin });

  const role = await createRole({ name: `${STAMP} Handbook admin`, permissions: ["handbook.manage"] });
  assert.ok("id" in role, "custom role created");
  roleId = role.id;
  await assignRole({ roleId, userId: people.mgrA, spaceId: spaceA });
  // Held on B too, but mgrA cannot read B: visibility is folded in, so B is never theirs.
  await assignRole({ roleId, userId: people.mgrA, spaceId: spaceB });

  await newDoc("pA1", spaceA);
  await newDoc("pA2", spaceA);
  await newDoc("pA3draft", spaceA, { status: "draft" });
  await newDoc("pB1", spaceB);
  await newDoc("kI1", spaceI, { type: "knowledge" });
});

after(async () => {
  await fixtureQuery(
    `DELETE FROM audit_log WHERE action LIKE 'handbook.%'
       AND ((target_type = 'handbook' AND target_id = ANY($1)) OR (target_type = 'document' AND target_id = ANY($2)))`,
    [handbookIds.map(String), docIds.map(String)]
  );
  await fixtureQuery("DELETE FROM handbook_confirmations WHERE handbook_id = ANY($1) OR handbook_title LIKE $2 OR user_id = ANY($3)", [
    handbookIds,
    `${STAMP}%`,
    userIds,
  ]);
  await fixtureQuery("DELETE FROM handbooks WHERE id = ANY($1) OR title LIKE $2", [handbookIds, `${STAMP}%`]);
  await fixtureQuery("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM audit_log WHERE target_type = 'document' AND target_id = ANY($1)", [docIds.map(String)]);
  for (const table of ["acknowledgements", "ack_decisions", "ack_notices", "ack_outbox", "attested_texts", "policy_assignments", "change_requests"]) {
    await fixtureQuery(`DELETE FROM ${table} WHERE document_id = ANY($1)`, [docIds]);
  }
  await fixtureQuery("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM role_assignments WHERE role_id = ANY($1)", [[roleId, globalRoleId]]);
  if (roleId) await deleteRole(roleId);
  if (globalRoleId) await deleteRole(globalRoleId);
  await fixtureQuery("DELETE FROM groups WHERE id = ANY($1)", [[gA, gB, gReaders, gW]]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM spaces WHERE id = ANY($1)", [[spaceA, spaceB, spaceI]]);
  await pool().end();
});

// --- Pure parsing -------------------------------------------------------------------

describe("lib/handbooks: request parsing", () => {
  test("parseHandbookInput names the first problem and fills the defaults", () => {
    assert.deepEqual(hb.parseHandbookInput(null), { ok: false, error: "Send a JSON object." });
    assert.deepEqual(hb.parseHandbookInput({}), { ok: false, error: hb.HANDBOOK_TITLE_REQUIRED });
    assert.deepEqual(hb.parseHandbookInput({ title: "   " }), { ok: false, error: hb.HANDBOOK_TITLE_REQUIRED });
    assert.deepEqual(hb.parseHandbookInput({ title: "x".repeat(161) }), { ok: false, error: hb.HANDBOOK_TITLE_REQUIRED });
    assert.deepEqual(hb.parseHandbookInput({ title: "T", space_id: "3" }), { ok: false, error: hb.HANDBOOK_OWNER_INVALID });
    assert.deepEqual(hb.parseHandbookInput({ title: "T", audience: "some" }), { ok: false, error: hb.HANDBOOK_AUDIENCE_INVALID });
    assert.deepEqual(hb.parseHandbookInput({ title: "T", group_ids: [1, "2"] }), { ok: false, error: hb.HANDBOOK_GROUPS_INVALID });
    assert.deepEqual(hb.parseHandbookInput({ title: "T", confirm_whole: "yes" }), { ok: false, error: "'confirm_whole' must be true or false." });
    assert.deepEqual(hb.parseHandbookInput({ title: "T", introduction: "y".repeat(20001) }), { ok: false, error: hb.HANDBOOK_INTRO_TOO_LONG });
    assert.deepEqual(hb.parseHandbookInput({ title: "  Employee   Handbook ", group_ids: [3, 3, 1], introduction: " Hi\r\nthere " }), {
      ok: true,
      value: {
        title: "Employee Handbook",
        space_id: null,
        introduction: "Hi\nthere",
        audience: "all",
        group_ids: [3, 1],
        confirm_whole: false,
        require_signature: false,
      },
    });
  });

  test("parseHandbookPatch takes any subset and refuses an empty one", () => {
    assert.deepEqual(hb.parseHandbookPatch({}), { ok: false, error: hb.HANDBOOK_NOTHING_TO_CHANGE });
    assert.deepEqual(hb.parseHandbookPatch({ space_id: null, confirm_whole: true }), { ok: true, value: { space_id: null, confirm_whole: true } });
  });

  test("parseHandbookContents needs 1–50 named sections and each document once", () => {
    assert.equal(hb.parseHandbookContents({ sections: [] }).ok, false);
    assert.deepEqual(hb.parseHandbookContents({ sections: [{ title: " ", doc_ids: [] }] }), { ok: false, error: hb.HANDBOOK_SECTION_TITLE_REQUIRED });
    assert.deepEqual(hb.parseHandbookContents({ sections: [{ title: "A", doc_ids: [1, 1] }] }), { ok: false, error: hb.HANDBOOK_DOC_IDS_INVALID });
    assert.deepEqual(hb.parseHandbookContents({ sections: [{ title: "A", doc_ids: [1] }, { title: "B", doc_ids: [1] }] }), {
      ok: false,
      error: hb.HANDBOOK_DOC_IDS_INVALID,
    });
    assert.deepEqual(hb.parseHandbookContents({ sections: [{ id: 4, title: " Working  here ", doc_ids: [2, 1] }, { title: "B" }] }), {
      ok: true,
      value: { sections: [{ id: 4, title: "Working here", doc_ids: [2, 1] }, { title: "B", doc_ids: [] }] },
    });
  });

  test("summary points and applies-to are trimmed and capped", () => {
    assert.deepEqual(hb.parseSummaryPoints([" One ", "", "Two"]), { ok: true, value: ["One", "Two"] });
    assert.deepEqual(hb.parseSummaryPoints(null), { ok: true, value: [] });
    assert.equal(hb.parseSummaryPoints(["1", "2", "3", "4", "5", "6"]).ok, false);
    assert.equal(hb.parseSummaryPoints(["x".repeat(201)]).ok, false);
    assert.equal(hb.parseSummaryPoints("one").ok, false);
    assert.deepEqual(hb.parseAppliesTo("  All   staff "), { ok: true, value: "All staff" });
    assert.equal(hb.parseAppliesTo("x".repeat(201)).ok, false);
    assert.equal(hb.isFindMode("handbook_only"), true);
    assert.equal(hb.isFindMode("hidden"), false);
  });

  test("the fingerprint is the ordered doc:version list", () => {
    const a = hb.handbookFingerprint([{ doc_id: 1, version_id: 10 }, { doc_id: 2, version_id: null }]);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, hb.handbookFingerprint([{ doc_id: 2, version_id: null }, { doc_id: 1, version_id: 10 }]));
    assert.notEqual(a, hb.handbookFingerprint([{ doc_id: 1, version_id: 11 }, { doc_id: 2, version_id: null }]));
  });
});

// --- Who builds -------------------------------------------------------------------------

describe("who builds a handbook", () => {
  test("handbook.manage is in the catalog, space-scoped, and the Administrator preset holds it", async () => {
    const { permission, PRESET_ROLES } = await import("../src/lib/permissions");
    assert.equal(permission("handbook.manage").scope, "space");
    assert.ok((PRESET_ROLES.admin.permissions as readonly string[]).includes("handbook.manage"));
    assert.ok(!(PRESET_ROLES.editor.permissions as readonly string[]).includes("handbook.manage"));
  });

  test("a workspace handbook admin owns the workspace and any space they read; a space's handbook admin owns only spaces they manage AND can read", async () => {
    assert.equal(await hb.canManageOwner(as("wsAdmin"), null), true);
    assert.equal(await hb.canManageOwner(as("wsAdmin"), spaceB), true);
    assert.equal(await hb.canManageOwner(as("wsAdmin"), spaceI), true);
    assert.equal(await hb.canManageOwner(as("mgrA"), null), false);
    assert.equal(await hb.canManageOwner(as("mgrA"), spaceA), true);
    assert.equal(await hb.canManageOwner(as("mgrA"), spaceB), false, "held on B but B is not readable");
    assert.deepEqual(await hb.manageableHandbookSpaces(as("mgrA")), [spaceA]);
    assert.equal(await hb.canCreateHandbooks(as("mgrA")), true);
    assert.equal(await hb.canCreateHandbooks(as("alice")), false);
    const opts = await hb.handbookOptions(as("mgrA"));
    assert.equal(opts.can_create_workspace, false);
    assert.deepEqual(opts.spaces.map((s) => s.id), [spaceA]);
    assert.equal(opts.policy_ack, true);
  });

  test("creating where you don't manage is refused; a space admin creates their space's handbook", async () => {
    await expectError(hb.createHandbook(as("mgrA"), input()), 403, hb.HANDBOOK_OWNER_DENIED);
    await expectError(hb.createHandbook(as("mgrA"), input({ space_id: spaceB })), 403, hb.HANDBOOK_OWNER_DENIED);
    await expectError(hb.createHandbook(as("wsAdmin"), input({ space_id: 2_000_000_000 })), 400, hb.HANDBOOK_SPACE_MISSING);
    const h = track(await hb.createHandbook(as("mgrA"), input({ title: `${STAMP} Space A book`, space_id: spaceA })));
    assert.equal(h.status, "draft");
    assert.equal(h.owner_label, `A ${STAMP}`);
    assert.equal(h.can_edit, true);
    assert.equal(h.sections.length, 1);
    assert.equal(h.sections[0].title, hb.HANDBOOK_FIRST_SECTION);
    assert.deepEqual(await auditActions(h.id), ["handbook.created"]);
    // The admin edits it too (global grant); alice (a reader of A) cannot see the draft at all.
    assert.equal(await hb.canManage(as("wsAdmin"), h.id), true);
    assert.equal(await hb.getHandbook(as("alice"), h.id), undefined);
    await expectError(hb.updateHandbook(as("alice"), h.id, { title: "x" }), 404);
  });

  test("a space admin adds only documents from spaces they manage", async () => {
    const h = track(await hb.createHandbook(as("mgrA"), input({ title: `${STAMP} Scoped adds`, space_id: spaceA })));
    await expectError(hb.addHandbookItems(as("mgrA"), h.id, [docs.pB1]), 400, hb.HANDBOOK_DOCS_INVALID);
    await expectError(hb.addHandbookItems(as("mgrA"), h.id, [docs.kI1]), 400, hb.HANDBOOK_DOCS_INVALID);
    await expectError(hb.addHandbookItems(as("mgrA"), h.id, [docs.pA3draft]), 400, hb.HANDBOOK_DOCS_INVALID);
    const after = await hb.addHandbookItems(as("mgrA"), h.id, [docs.pA1, docs.pA2]);
    assert.deepEqual(after.sections[0].items.map((i) => i.doc_id), [docs.pA1, docs.pA2]);
    const cands = await hb.handbookCandidates(as("mgrA"), h.id, { q: STAMP, type: "all" });
    assert.deepEqual(cands.map((c) => c.id).sort(), [docs.pA1, docs.pA2].sort());
    assert.ok(cands.every((c) => c.in_handbook));
    // The admin's search for a workspace handbook covers every space they can see; 'policy' leaves knowledge out.
    const w = track(await hb.createHandbook(as("wsAdmin"), input({ title: `${STAMP} Workspace adds` })));
    const policies = await hb.handbookCandidates(as("wsAdmin"), w.id, { q: STAMP });
    assert.deepEqual(policies.map((c) => c.id).sort((a, b) => a - b), [docs.pA1, docs.pA2, docs.pB1].sort((a, b) => a - b));
    const all = await hb.handbookCandidates(as("wsAdmin"), w.id, { q: STAMP, type: "all", spaceId: spaceI });
    assert.deepEqual(all.map((c) => c.id), [docs.kI1]);
    await expectError(hb.handbookCandidates(as("alice"), w.id), 404);
  });
});

// --- Contents -------------------------------------------------------------------------------

describe("contents", () => {
  test("sections and items: add, move across sections, rename, remove, numbering, the last section stays", async () => {
    const admin = as("wsAdmin");
    const h = track(await hb.createHandbook(admin, input({ title: `${STAMP} Contents` })));
    const s1 = h.sections[0].id;
    let c = await hb.addHandbookItems(admin, h.id, [docs.pA1, docs.pA2, docs.pB1]);
    c = await hb.addHandbookSection(admin, h.id, "Information security");
    const s2 = c.sections[1].id;
    assert.equal(c.sections[1].number, 2);
    c = await hb.moveHandbookItem(admin, h.id, docs.pB1, { direction: "down" }); // last of s1 → first of s2
    assert.deepEqual(c.sections.map((s) => s.items.map((i) => i.doc_id)), [[docs.pA1, docs.pA2], [docs.pB1]]);
    assert.deepEqual(c.sections.flatMap((s) => s.items.map((i) => i.number)), [1, 2, 3]);
    c = await hb.moveHandbookItem(admin, h.id, docs.pA1, { direction: "down" });
    assert.deepEqual(c.sections[0].items.map((i) => i.doc_id), [docs.pA2, docs.pA1]);
    c = await hb.moveHandbookItem(admin, h.id, docs.pB1, { direction: "up" }); // first of s2 → end of s1
    assert.deepEqual(c.sections[0].items.map((i) => i.doc_id), [docs.pA2, docs.pA1, docs.pB1]);
    c = await hb.moveHandbookItem(admin, h.id, docs.pA2, { sectionId: s2 });
    assert.deepEqual(c.sections[1].items.map((i) => i.doc_id), [docs.pA2]);
    c = await hb.renameHandbookSection(admin, h.id, s1, "  Working here ");
    assert.equal(c.sections[0].title, "Working here");
    c = await hb.moveHandbookSection(admin, h.id, s2, "up");
    assert.deepEqual(c.sections.map((s) => s.id), [s2, s1]);
    c = await hb.removeHandbookSection(admin, h.id, s2); // first section: its items go to the start of the next
    assert.deepEqual(c.sections.map((s) => s.id), [s1]);
    assert.deepEqual(c.sections[0].items.map((i) => i.doc_id), [docs.pA2, docs.pA1, docs.pB1]);
    await expectError(hb.removeHandbookSection(admin, h.id, s1), 409, hb.HANDBOOK_LAST_SECTION);
    await expectError(hb.removeHandbookItem(admin, h.id, docs.kI1), 404, hb.HANDBOOK_ITEM_NOT_FOUND);
    await expectError(hb.renameHandbookSection(admin, h.id, 2_000_000_000, "x"), 404, hb.HANDBOOK_SECTION_NOT_FOUND);
    c = await hb.removeHandbookItem(admin, h.id, docs.pA1);
    assert.deepEqual(c.sections[0].items.map((i) => i.doc_id), [docs.pA2, docs.pB1]);
    const actions = await auditActions(h.id);
    assert.equal(actions[0], "handbook.created");
    assert.ok(actions.slice(1).every((a) => a === "handbook.contents_changed"));
    assert.equal(actions.length, 11);
  });

  test("the whole card saved at once keeps section ids, makes new ones, and keeps a trashed item it never showed", async () => {
    const admin = as("wsAdmin");
    const h = track(await hb.createHandbook(admin, input({ title: `${STAMP} Replace` })));
    const s1 = h.sections[0].id;
    const trashed = await newDoc("trashme", spaceI);
    await hb.addHandbookItems(admin, h.id, [docs.pA1, trashed]);
    await pool().query("UPDATE documents SET deleted_at = now() WHERE id = $1", [trashed]);
    const c = await hb.setHandbookContents(admin, h.id, {
      sections: [
        { title: "New first", doc_ids: [docs.pB1] },
        { id: s1, title: "Kept", doc_ids: [docs.pA1, docs.kI1] },
      ],
    });
    assert.deepEqual(c.sections.map((s) => s.title), ["New first", "Kept"]);
    assert.equal(c.sections[1].id, s1);
    assert.deepEqual(c.sections.map((s) => s.items.map((i) => i.doc_id)), [[docs.pB1], [docs.pA1, docs.kI1]]);
    const kept = await pool().query("SELECT section_id FROM handbook_items WHERE handbook_id = $1 AND document_id = $2", [h.id, trashed]);
    assert.equal(kept.rows[0]?.section_id, s1, "the trashed document stays in its section");
    await expectError(
      hb.setHandbookContents(admin, h.id, { sections: [{ title: "X", doc_ids: [docs.pA3draft] }] }),
      400,
      hb.HANDBOOK_DOCS_INVALID
    );
  });
});

// --- Who reads, and what reading opens ---------------------------------------------------------

describe("who reads", () => {
  test("drafts are their editors'; publishing needs a published item; the audience decides who reads", async () => {
    const admin = as("wsAdmin");
    const h = track(await hb.createHandbook(admin, input({ title: `${STAMP} Readers` })));
    await expectError(hb.publishHandbook(admin, h.id, true), 409, hb.HANDBOOK_EMPTY_PUBLISH);
    await hb.addHandbookItems(admin, h.id, [docs.pB1]);
    assert.equal(await hb.canRead(as("dave"), h.id), false, "draft");
    const pub = await hb.publishHandbook(admin, h.id, true);
    assert.equal(pub.status, "published");
    assert.ok(pub.published_at);
    // Everyone (workspace, 'all').
    for (const who of ["alice", "bob", "carol", "dave"]) assert.equal(await hb.canRead(as(who), h.id), true, who);
    // Chosen groups only.
    await hb.updateHandbook(admin, h.id, { audience: "groups", group_ids: [gReaders] });
    assert.equal(await hb.canRead(as("carol"), h.id), true);
    assert.equal(await hb.canRead(as("dave"), h.id), false);
    assert.equal(await hb.canRead(as("wsAdmin"), h.id), true, "its editors always read it");
    await expectError(hb.updateHandbook(admin, h.id, { group_ids: [] }), 400, hb.HANDBOOK_GROUPS_REQUIRED);
    // The list shows carol the handbook and dave nothing of it.
    assert.ok((await hb.listHandbooks(as("carol"))).some((x) => x.id === h.id));
    assert.ok(!(await hb.listHandbooks(as("dave"))).some((x) => x.id === h.id));
    const asAdmin = (await hb.listHandbooks(admin)).find((x) => x.id === h.id)!;
    assert.equal(asAdmin.can_edit, true);
    assert.equal(asAdmin.item_count, 1);
    // Unpublished: readers lose it, its editors keep it.
    await hb.publishHandbook(admin, h.id, false);
    assert.equal(await hb.canRead(as("carol"), h.id), false);
    assert.deepEqual((await auditActions(h.id)).filter((a) => a !== "handbook.contents_changed"), [
      "handbook.created",
      "handbook.published",
      "handbook.updated",
      "handbook.unpublished",
    ]);
  });

  test("a space handbook's 'all' is the space's readers", async () => {
    const h = track(await hb.createHandbook(as("mgrA"), input({ title: `${STAMP} Space readers`, space_id: spaceA })));
    await hb.addHandbookItems(as("mgrA"), h.id, [docs.pA1]);
    await hb.publishHandbook(as("mgrA"), h.id, true);
    assert.equal(await hb.canRead(as("alice"), h.id), true);
    assert.equal(await hb.canRead(as("bob"), h.id), false);
    assert.equal(await hb.handbookGrantsRead(people.alice, docs.pA1), true);
    assert.equal(await hb.handbookGrantsRead(people.bob, docs.pA1), false);
  });

  test("handbook access opens its policies: a reader outside the space reads the document through the handbook", async () => {
    const admin = as("wsAdmin");
    const h = track(await hb.createHandbook(admin, input({ title: `${STAMP} Opens`, audience: "groups", group_ids: [gReaders] })));
    await hb.addHandbookItems(admin, h.id, [docs.pA1, docs.pA2]);
    // Carol cannot read space A, and the handbook is a draft: nothing opens.
    assert.equal(await hb.handbookGrantsRead(people.carol, docs.pA1), false);
    assert.equal(await hb.getHandbookPolicy(as("carol"), h.id, docs.pA1), undefined);
    await hb.publishHandbook(admin, h.id, true);
    assert.equal(await hb.handbookGrantsRead(people.carol, docs.pA1), true);
    assert.equal(await hb.handbookGrantsRead(people.carol, docs.pA1, h.id), true);
    assert.equal(await hb.handbookGrantsRead(people.carol, docs.pA1, h.id + 1_000_000), false);
    assert.equal(await hb.handbookGrantsRead(people.dave, docs.pA1), false, "not in the audience");
    assert.equal(await hb.handbookGrantsRead(people.carol, docs.pB1), false, "not in a handbook carol reads");
    const p = await hb.getHandbookPolicy(as("carol"), h.id, docs.pA2);
    assert.ok(p);
    assert.equal(p.document.id, docs.pA2);
    assert.equal(p.item.number, 2);
    assert.equal(p.prev?.doc_id, docs.pA1);
    assert.equal(p.next, null);
    assert.equal(await hb.getHandbookPolicy(as("carol"), h.id, docs.pB1), undefined);
    // A document taken back to draft is closed again, and readers no longer list it.
    await pool().query("UPDATE documents SET status = 'draft' WHERE id = $1", [docs.pA2]);
    try {
      assert.equal(await hb.handbookGrantsRead(people.carol, docs.pA2), false);
      const reader = (await hb.getHandbook(as("carol"), h.id))!;
      assert.deepEqual(reader.sections.flatMap((s) => s.items.map((i) => i.doc_id)), [docs.pA1]);
      const editor = (await hb.getHandbook(admin, h.id, { forEdit: true }))!;
      assert.deepEqual(editor.sections[0].items.map((i) => [i.doc_id, i.doc_status]), [
        [docs.pA1, "published"],
        [docs.pA2, "draft"],
      ]);
      assert.equal(await hb.getHandbook(as("carol"), h.id, { forEdit: true }), undefined);
    } finally {
      await pool().query("UPDATE documents SET status = 'published' WHERE id = $1", [docs.pA2]);
    }
  });
});

// --- Where people find it ---------------------------------------------------------------------

describe("where people find it", () => {
  test("stored on the document, effective only while a published handbook holds it; a space admin can't hide another space's document", async () => {
    const admin = as("wsAdmin");
    const doc = await newDoc("findme", spaceA);
    const h = track(await hb.createHandbook(admin, input({ title: `${STAMP} Find` })));
    await hb.addHandbookItems(admin, h.id, [doc, docs.pB1]);
    const before = await pool().query("SELECT updated_at FROM documents WHERE id = $1", [doc]);
    let c = await hb.setItemFindMode(admin, h.id, doc, "handbook_only");
    const item = c.sections[0].items.find((i) => i.doc_id === doc)!;
    assert.equal(item.find_mode, "handbook_only");
    assert.equal(item.effective_find_mode, "space", "no orphans: the handbook is a draft");
    assert.equal(await hb.effectiveFindMode(doc), "space");
    const afterRow = await pool().query("SELECT updated_at, find_mode FROM documents WHERE id = $1", [doc]);
    assert.equal(afterRow.rows[0].find_mode, "handbook_only");
    assert.equal(String(afterRow.rows[0].updated_at), String(before.rows[0].updated_at), "metadata only: updated_at stays");
    await hb.publishHandbook(admin, h.id, true);
    assert.equal(await hb.effectiveFindMode(doc), "handbook_only");
    c = (await hb.getHandbook(admin, h.id, { forEdit: true }))!;
    assert.equal(c.sections[0].items.find((i) => i.doc_id === doc)!.effective_find_mode, "handbook_only");
    const marks = await hb.handbooksForDocuments([doc]);
    assert.deepEqual(marks.get(doc), [{ id: h.id, title: `${STAMP} Find`, status: "published" }]);
    await hb.publishHandbook(admin, h.id, false);
    assert.equal(await hb.effectiveFindMode(doc), "space");
    const audit = await pool().query(
      "SELECT details FROM audit_log WHERE action = 'handbook.find_mode_changed' AND target_type = 'document' AND target_id = $1",
      [String(doc)]
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].details.to, "handbook_only");

    // mgrA edits a space-A handbook that (via the admin) holds a space-B document: hiding it is not theirs.
    const s = track(await hb.createHandbook(as("mgrA"), input({ title: `${STAMP} Find scoped`, space_id: spaceA })));
    await hb.setHandbookContents(admin, s.id, { sections: [{ id: s.sections[0].id, title: "P", doc_ids: [docs.pB1] }] });
    await expectError(hb.setItemFindMode(as("mgrA"), s.id, docs.pB1, "handbook_only"), 403, hb.HANDBOOK_FIND_MODE_DENIED);
  });
});

// --- Whole-handbook confirmation records and progress ----------------------------------------------

describe("confirmation records and progress", () => {
  test("a record is written only for the current contents; progress counts the audience's records of them", async () => {
    const admin = as("wsAdmin");
    const h0 = track(
      await hb.createHandbook(admin, input({ title: `${STAMP} Confirm`, audience: "groups", group_ids: [gReaders, gB], confirm_whole: true }))
    );
    await hb.addHandbookItems(admin, h0.id, [docs.pA1]);
    const h = await hb.publishHandbook(admin, h0.id, true);
    assert.equal(h.progress?.audience, 2, "carol and bob");
    assert.equal(h.progress?.confirmed, 0);
    assert.equal(await hb.recordHandbookConfirmation({ handbook_id: h.id, user_id: people.carol, fingerprint: "stale" }), null);
    const w = await hb.recordHandbookConfirmation({ handbook_id: h.id, user_id: people.carol, fingerprint: h.fingerprint, policies_confirmed: 1 });
    assert.ok(w?.at);
    assert.ok(await hb.handbookConfirmedAt(h.id, people.carol, h.fingerprint));
    assert.equal(await hb.handbookConfirmedAt(h.id, people.bob, h.fingerprint), null);
    const stored = await pool().query("SELECT user_name, items, handbook_title FROM handbook_confirmations WHERE handbook_id = $1", [h.id]);
    assert.equal(stored.rows[0].user_name, `carol ${STAMP}`);
    assert.equal(stored.rows[0].handbook_title, `${STAMP} Confirm`);
    assert.equal(stored.rows[0].items[0].doc_id, docs.pA1);
    let row = (await hb.listHandbooks(admin)).find((x) => x.id === h.id)!;
    assert.deepEqual(row.progress, { audience: 2, confirmed: 1, pct: 50 });
    assert.equal((await hb.listHandbooks(as("carol"))).find((x) => x.id === h.id)!.progress, null, "readers never see everyone's standing");
    // Adding a policy changes the fingerprint: carol's record is of the old contents.
    const changed = await hb.addHandbookItems(admin, h.id, [docs.pA2]);
    assert.notEqual(changed.fingerprint, h.fingerprint);
    row = (await hb.listHandbooks(admin)).find((x) => x.id === h.id)!;
    assert.deepEqual(row.progress, { audience: 2, confirmed: 0, pct: 0 });
    // Deleting the handbook keeps the record (SET NULL) with its title snapshot.
    await hb.deleteHandbook(admin, h.id);
    const kept = await pool().query("SELECT handbook_id FROM handbook_confirmations WHERE handbook_title = $1", [`${STAMP} Confirm`]);
    assert.equal(kept.rows.length, 1);
    assert.equal(kept.rows[0].handbook_id, null);
    assert.equal(await hb.getHandbook(admin, h.id), undefined);
    assert.ok((await auditActions(h.id)).includes("handbook.deleted"));
  });
});


// --- A published handbook's readers are in its policies' audience ------------------------------------

describe("publishing a handbook widens its policies' confirmation audience", () => {
  test("a reader the handbook lets in gets an open row; another audience, removing the item and deleting the handbook each close it", async () => {
    const admin = as("wsAdmin");
    // A policy of space A that asks for confirmation: its first audience is the space's readers.
    const doc = await newDoc("pConfirm", spaceA);
    await switchOn(doc, { editDefault: null, recertMonths: null });
    assert.equal(await hasOpenAssignment(doc, people.alice), true, "space A's reader is asked");
    assert.equal(await hasOpenAssignment(doc, people.carol), false, "carol cannot open space A");
    assert.equal(await hasOpenAssignment(doc, people.bob), false);

    const h = track(await hb.createHandbook(admin, input({ title: `${STAMP} Widens`, audience: "groups", group_ids: [gReaders] })));
    await hb.addHandbookItems(admin, h.id, [doc]);
    assert.equal(await hasOpenAssignment(doc, people.carol), false, "a draft handbook lets nobody in");
    await hb.publishHandbook(admin, h.id, true);
    assert.equal(await hasOpenAssignment(doc, people.carol), true, "published: the handbook's reader is asked");
    assert.equal(await hasOpenAssignment(doc, people.dave), false, "nobody outside the audience is");

    // Another audience: carol's row closes, bob's opens; and back.
    await hb.updateHandbook(admin, h.id, { group_ids: [gB] });
    assert.equal(await hasOpenAssignment(doc, people.carol), false, "out of the audience, out of the policy's");
    assert.equal(await hasOpenAssignment(doc, people.bob), true);
    await hb.updateHandbook(admin, h.id, { group_ids: [gReaders] });
    assert.equal(await hasOpenAssignment(doc, people.carol), true, "back in the audience: the row reopens");
    assert.equal(await hasOpenAssignment(doc, people.bob), false);

    // The policy taken out of the handbook: closed; put back: open.
    await hb.removeHandbookItem(admin, h.id, doc);
    assert.equal(await hasOpenAssignment(doc, people.carol), false, "no longer in a handbook carol reads");
    await hb.addHandbookItems(admin, h.id, [doc]);
    assert.equal(await hasOpenAssignment(doc, people.carol), true);

    // The published handbook deleted: closed; the space's own readers never moved.
    await hb.deleteHandbook(admin, h.id);
    assert.equal(await hasOpenAssignment(doc, people.carol), false, "the handbook is gone");
    assert.equal(await hasOpenAssignment(doc, people.alice), true, "the space's reader is asked throughout");
    const closed = await pool().query(
      "SELECT removed_reason FROM policy_assignments WHERE document_id = $1 AND user_id = $2",
      [doc, people.carol]
    );
    assert.equal(closed.rows.length, 1, "one row, reopened and closed, never duplicated");
  });
});

// --- The policy page's facts (Owner, Approved by, Version, Effective) -----------------------------------

describe("the facts a handbook shows for a policy", () => {
  // One rule for the reader and the printed copy (lib/db listHandbookItemRows):
  // Owner = the compliance portal's order (one shared SQL fragment,
  // POLICY_OWNER_PICK): the policy's own owner, else the space's Policy
  // owner, else whoever switched the requirement on — an owner only while an
  // active account — then the latest published version's publisher, else its
  // author. Version, Approved by and Effective are the LATEST published
  // version's.
  test("each step of the owner cascade, and the latest version's number, approver and date", async () => {
    const admin = as("wsAdmin");
    const doc = await createDocument({
      space_id: spaceA,
      title: `${STAMP} pFacts`,
      type: "policy",
      status: "published",
      content: "# Facts\n\nStaff must follow this.",
      summary: "",
      tags: [],
      author: `Byline ${STAMP}`,
    });
    docIds.push(doc.id);
    const h = track(await hb.createHandbook(admin, input({ title: `${STAMP} Facts`, audience: "groups", group_ids: [gReaders] })));
    await hb.addHandbookItems(admin, h.id, [doc.id]);
    const item = async () => {
      const p = await hb.getHandbookPolicy(admin, h.id, doc.id);
      assert.ok(p, "the editor reads the draft handbook's policy");
      return p.item;
    };
    const latest = async () => (await listVersions(doc.id))[0];
    const sameInstant = (a: string | null, b: string) => assert.equal(a && new Date(a).getTime(), new Date(b).getTime());

    // Version 1: nobody named, so its publisher (createDocument: the byline); no review.
    let it = await item();
    assert.equal(it.owner_name, `Byline ${STAMP}`);
    assert.equal(it.approver_name, "");
    assert.equal(it.version, 1);
    sameInstant(it.effective_at, (await latest()).created_at);

    // Version 2 through review: subm proposed it, appr approved it.
    const cr = await createChangeRequest({
      document_id: doc.id,
      kind: "edit",
      title: doc.title,
      content: "# Facts\n\nStaff must follow this, and say so.",
      summary: "",
      tags: [],
      type: "policy",
      target_status: "published",
      note: "Clarified",
      created_by: people.subm,
    });
    assert.ok(await approveChangeRequest(cr, people.appr, `appr ${STAMP}`));
    it = await item();
    assert.equal(it.owner_name, `subm ${STAMP}`, "the latest version's publisher");
    assert.equal(it.approver_name, `appr ${STAMP}`, "the reviewer who approved it");
    assert.equal(it.version, 2);
    sameInstant(it.effective_at, (await latest()).created_at);

    // The space's Policy owner outranks the publisher.
    const stored = (await pool().query("SELECT policy_defaults FROM spaces WHERE id = $1", [spaceA])).rows[0].policy_defaults;
    await updateSpace(spaceA, { policy_defaults: { ...(stored ?? {}), owner_user_id: people.sam } });
    try {
      assert.equal((await item()).owner_name, `sam ${STAMP}`, "the space's Policy owner");

      // The handbook names whom the portal names, at every step from here
      // (the requirement is on, so the portal lists the policy).
      const portalOwner = async () => (await complianceDocs()).find((r) => r.id === doc.id)?.owner_name;
      const sameAsPortal = async (name: string, why: string) => {
        assert.equal((await item()).owner_name, name, why);
        assert.equal(await portalOwner(), name, `the portal agrees: ${why}`);
      };

      // The space's Policy owner outranks whoever switched the requirement on.
      await switchOn(doc.id, { editDefault: null, recertMonths: null, requestedBy: people.rita });
      assert.equal((await getPolicySettings(doc.id))?.requested_by, people.rita);
      await sameAsPortal(`sam ${STAMP}`, "the space's Policy owner outranks the requester");

      // Without a space owner, whoever switched the requirement on.
      const { owner_user_id: _spaceOwner, ...withoutOwner } = stored ?? {};
      await updateSpace(spaceA, { policy_defaults: withoutOwner });
      await sameAsPortal(`rita ${STAMP}`, "who switched the requirement on");
      await updateSpace(spaceA, { policy_defaults: { ...(stored ?? {}), owner_user_id: people.sam } });

      // The policy's own owner outranks everyone — while an active account.
      await updatePolicySettings(doc.id, { owner_user_id: people.owen });
      await sameAsPortal(`owen ${STAMP}`, "the policy's own owner");
      await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [people.owen]);
      try {
        await sameAsPortal(`sam ${STAMP}`, "a disabled owner is passed over, to the space's owner");
        await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [people.sam]);
        try {
          await sameAsPortal(`rita ${STAMP}`, "and a disabled space owner, to the requester");
        } finally {
          await pool().query("UPDATE users SET status = 'active' WHERE id = $1", [people.sam]);
        }
      } finally {
        await pool().query("UPDATE users SET status = 'active' WHERE id = $1", [people.owen]);
      }

      // A kept edit (no one asked again): the confirmation marker stays on
      // version 2, but the facts are the latest version's, which went live
      // without a review.
      const before = (await pool().query("SELECT ack_version_id FROM documents WHERE id = $1", [doc.id])).rows[0].ack_version_id;
      await updateDocument(doc.id, {
        content: "# Facts\n\nStaff must follow this, and say so clearly.",
        author: `Byline ${STAMP}`,
        ackPolicy: "keep",
        ackReason: "Wording only, no change in meaning.",
        ackActor: { id: people.pub, name: `pub ${STAMP}` },
      });
      const marker = (await pool().query("SELECT ack_version_id FROM documents WHERE id = $1", [doc.id])).rows[0].ack_version_id;
      assert.equal(marker, before, "the marker stays: the edit was kept");
      it = await item();
      assert.equal(it.version, 3, "the latest version, not the marker's");
      assert.equal(it.approver_name, "", "version 3 had no review");
      sameInstant(it.effective_at, (await latest()).created_at);
      assert.equal(it.owner_name, `owen ${STAMP}`, "the owner is the policy's, whatever the version");
    } finally {
      await updateSpace(spaceA, { policy_defaults: stored ?? {} });
    }
  });
});

// --- The routes ----------------------------------------------------------------------------------

describe("the routes", () => {
  test("list, create, patch, contents, items, sections, candidates, publish, policy, delete", async () => {
    const list = await import("../src/app/api/handbooks/route");
    const one = await import("../src/app/api/handbooks/[id]/route");
    const contents = await import("../src/app/api/handbooks/[id]/contents/route");
    const items = await import("../src/app/api/handbooks/[id]/items/route");
    const item = await import("../src/app/api/handbooks/[id]/items/[docId]/route");
    const sections = await import("../src/app/api/handbooks/[id]/sections/route");
    const section = await import("../src/app/api/handbooks/[id]/sections/[sectionId]/route");
    const candidates = await import("../src/app/api/handbooks/[id]/candidates/route");
    const publish = await import("../src/app/api/handbooks/[id]/publish/route");
    const policy = await import("../src/app/api/handbooks/[id]/policies/[docId]/route");
    const options = await import("../src/app/api/handbooks/options/route");

    // A viewer may list (nothing to create) but not create.
    let r = await call(() => list.GET(), request("GET", "/api/handbooks", sessions.dave));
    assert.equal(r.status, 200);
    assert.equal(r.body.can_create, false);
    let req = request("POST", "/api/handbooks", sessions.dave, { title: "Nope" });
    r = await call(() => list.POST(req), req);
    assert.equal(r.status, 403);
    req = request("POST", "/api/handbooks", sessions.wsAdmin, { title: "" });
    r = await call(() => list.POST(req), req);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, hb.HANDBOOK_TITLE_REQUIRED);
    req = request("POST", "/api/handbooks", sessions.wsAdmin, { title: `${STAMP} Routed`, introduction: "Hello" });
    r = await call(() => list.POST(req), req);
    assert.equal(r.status, 201);
    const id = track(r.body.handbook).id as number;
    const firstSection = r.body.handbook.sections[0].id as number;

    req = request("GET", "/api/handbooks/options", sessions.mgrA);
    r = await call(() => options.GET(), req);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.spaces.map((s: { id: number }) => s.id), [spaceA]);

    req = request("PATCH", `/api/handbooks/${id}`, sessions.wsAdmin, { confirm_whole: true, title: `${STAMP} Routed 2` });
    r = await call(() => one.PATCH(req, params({ id: String(id) })), req);
    assert.equal(r.status, 200);
    assert.equal(r.body.handbook.title, `${STAMP} Routed 2`);
    req = request("PATCH", `/api/handbooks/${id}`, sessions.wsAdmin, {});
    r = await call(() => one.PATCH(req, params({ id: String(id) })), req);
    assert.equal(r.status, 400);

    req = request("POST", `/api/handbooks/${id}/items`, sessions.wsAdmin, { doc_ids: [docs.pA1, docs.pB1] });
    r = await call(() => items.POST(req, params({ id: String(id) })), req);
    assert.equal(r.status, 200);
    assert.equal(r.body.handbook.item_count, 2);

    req = request("POST", `/api/handbooks/${id}/sections`, sessions.wsAdmin, { title: "Security" });
    r = await call(() => sections.POST(req, params({ id: String(id) })), req);
    assert.equal(r.status, 201);
    const secId = r.body.handbook.sections[1].id as number;

    req = request("PATCH", `/api/handbooks/${id}/items/${docs.pB1}`, sessions.wsAdmin, { section_id: secId, find_mode: "handbook_only" });
    r = await call(() => item.PATCH(req, params({ id: String(id), docId: String(docs.pB1) })), req);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.handbook.sections[1].items.map((i: { doc_id: number }) => i.doc_id), [docs.pB1]);
    assert.equal(r.body.handbook.sections[1].items[0].find_mode, "handbook_only");
    await pool().query("UPDATE documents SET find_mode = 'space' WHERE id = $1", [docs.pB1]);

    req = request("PATCH", `/api/handbooks/${id}/sections/${secId}`, sessions.wsAdmin, { title: "Information security", move: "up" });
    r = await call(() => section.PATCH(req, params({ id: String(id), sectionId: String(secId) })), req);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.handbook.sections.map((s: { title: string }) => s.title), ["Information security", hb.HANDBOOK_FIRST_SECTION]);

    req = request("PUT", `/api/handbooks/${id}/contents`, sessions.wsAdmin, {
      sections: [{ id: firstSection, title: "Working here", doc_ids: [docs.pB1, docs.pA1] }],
    });
    r = await call(() => contents.PUT(req, params({ id: String(id) })), req);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.handbook.sections.map((s: { title: string }) => s.title), ["Working here"]);

    req = request("DELETE", `/api/handbooks/${id}/sections/${firstSection}`, sessions.wsAdmin);
    r = await call(() => section.DELETE(req, params({ id: String(id), sectionId: String(firstSection) })), req);
    assert.equal(r.status, 409);

    req = request("GET", `/api/handbooks/${id}/candidates?q=${encodeURIComponent(STAMP)}&type=all&space=${spaceI}`, sessions.wsAdmin);
    r = await call(() => candidates.GET(req, params({ id: String(id) })), req);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.candidates.map((c: { id: number }) => c.id), [docs.kI1]);
    req = request("GET", `/api/handbooks/${id}/candidates`, sessions.mgrA);
    r = await call(() => candidates.GET(req, params({ id: String(id) })), req);
    assert.equal(r.status, 404, "mgrA does not edit a workspace handbook");

    // Draft: dave can't see it (404), the editor's view is the admin's.
    req = request("GET", `/api/handbooks/${id}`, sessions.dave);
    r = await call(() => one.GET(req, params({ id: String(id) })), req);
    assert.equal(r.status, 404);
    req = request("GET", `/api/handbooks/${id}?edit=1`, sessions.wsAdmin);
    r = await call(() => one.GET(req, params({ id: String(id) })), req);
    assert.equal(r.status, 200);

    req = request("POST", `/api/handbooks/${id}/publish`, sessions.wsAdmin, { publish: true });
    r = await call(() => publish.POST(req, params({ id: String(id) })), req);
    assert.equal(r.status, 200);
    assert.equal(r.body.handbook.status, "published");

    // Dave (everyone) now reads it and the space-B policy inside it, though he can't open space B.
    req = request("GET", `/api/handbooks/${id}/policies/${docs.pB1}`, sessions.dave);
    r = await call(() => policy.GET(req, params({ id: String(id), docId: String(docs.pB1) })), req);
    assert.equal(r.status, 200);
    assert.equal(r.body.document.id, docs.pB1);
    assert.equal(r.body.item.number, 1);
    req = request("GET", `/api/handbooks/${id}?edit=1`, sessions.dave);
    r = await call(() => one.GET(req, params({ id: String(id) })), req);
    assert.equal(r.status, 404);
    req = request("PATCH", `/api/handbooks/${id}`, sessions.dave, { title: "x" });
    r = await call(() => one.PATCH(req, params({ id: String(id) })), req);
    assert.equal(r.status, 403, "a viewer holds no handbook.manage");

    req = request("DELETE", `/api/handbooks/${id}`, sessions.wsAdmin);
    r = await call(() => one.DELETE(req, params({ id: String(id) })), req);
    assert.equal(r.status, 200);
    req = request("GET", `/api/handbooks/${id}`, sessions.wsAdmin);
    r = await call(() => one.GET(req, params({ id: String(id) })), req);
    assert.equal(r.status, 404);
  });

  test("PUT /api/documents/[id]: changing a published document's facts needs publish rights (403, nothing written); a publisher saves them", async () => {
    const route = await import("../src/app/api/documents/[id]/route");
    const doc = await newDoc("factsLive", spaceI);
    const put = (session: string, body: unknown) => {
      const req = request("PUT", `/api/documents/${doc}`, session, body);
      return call(() => route.PUT(req, params({ id: String(doc) })), req);
    };
    const facts = async () =>
      (await pool().query("SELECT summary_points, applies_to FROM documents WHERE id = $1", [doc])).rows[0] as { summary_points: string[]; applies_to: string };
    const crs = async () => Number((await pool().query("SELECT count(*) FROM change_requests WHERE document_id = $1", [doc])).rows[0].count);

    // ed edits the internal space but may not publish (approval mode strict).
    let r = await put(sessions.ed, { summary_points: ["You get 25 days."] });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "Changing In short or Applies to on a published document needs publish rights.");
    r = await put(sessions.ed, { applies_to: "All employees" });
    assert.equal(r.status, 403);
    assert.deepEqual(await facts(), { summary_points: [], applies_to: "" }, "nothing written");
    assert.equal(await crs(), 0, "and nothing queued for review");

    // pub (approver) holds document.publish: the same save goes straight through.
    r = await put(sessions.pub, { summary_points: ["You get 25 days."], applies_to: "All employees" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await facts(), { summary_points: ["You get 25 days."], applies_to: "All employees" });
    assert.equal(await crs(), 0);
  });
});
