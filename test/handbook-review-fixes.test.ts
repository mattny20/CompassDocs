// Handbooks 1.18.0: regressions for the review findings fixed after the
// first build. Each describe names its finding:
//
//   A1  editing rights don't read or widen past what the editor could add
//   A2  a space handbook's groups audience narrows within the space's readers
//   A3  the sidebar page tree leaves handbook-only pages out
//   A4  the handbook signature switch can't be stepped around by naming
//       another handbook
//   A5  the group and space hooks reconcile handbook policies; D3 deleting a
//       group or a space that cascades handbook rows reconciles too
//   A6  the [[ lookup leaves handbook-only documents out
//   D1  unpublish → republish keeps a still-valid confirmation counting
//   D2  conditional saves answer 409 when someone else saved first
//   D4  erasure rewrites whole-handbook records
//   D6  the whole-handbook record is of the contents that were checked
//   D7  two submits at once write one whole-handbook record
//
// Fixtures: private spaces granted to this file's own groups, viewer
// accounts with custom roles (no admin accounts), STAMP-prefixed, removed
// in after(). lib/ee is stubbed to grant policy_ack and next/headers to
// serve the request under test, as test/handbook-confirm.test.ts does.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/handbook-review-fixes.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import {
  pool,
  getSetting,
  createDocument,
  listVersions,
  recordAcknowledgement,
  getCurrentAck,
  hasOpenAssignment,
  createGroup,
  createRole,
  assignRole,
  deleteRole,
  setSpaceGroups,
  createSession,
  getUserById,
  setHandbookStatusRow,
  reconcilePoliciesForHandbook,
  reconcilePoliciesForGroup,
  reconcilePoliciesForSpace,
  deleteGroup,
  anonymiseComplianceRecord,
  attestationCountsByUser,
  countUserAttestations,
  insertHandbookConfirmation,
  publishedHandbookAdmits,
} from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";
import type { SessionUser } from "../src/lib/types";
import { SETTINGS_DEFAULTS } from "../src/lib/settings";

// --- The request scope outside Next, and a licensed lib/ee ---------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.handbook-review-fixes.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.handbook-review-fixes.virtual.js");
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

  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => ({ present: true, features: ["policy_ack"] }),
    eePresent: () => true,
    featureEnabled: async (feature: string) => feature === "policy_ack",
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

// After the stubs: these import lib/ee.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hb = require("../src/lib/handbooks") as typeof import("../src/lib/handbooks");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const confirm = require("../src/lib/handbook-confirm") as typeof import("../src/lib/handbook-confirm");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tree = require("../src/lib/doc-tree") as typeof import("../src/lib/doc-tree");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const visibility = require("../src/lib/handbook-visibility") as typeof import("../src/lib/handbook-visibility");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const readerData = require("../src/components/handbooks/reader/reader-data") as typeof import("../src/components/handbooks/reader/reader-data");

/** The reader's confirm bar for one policy in one handbook (what /handbooks/{id}/{docId} renders). */
async function readerConfirm(who: string, handbookId: number, docId: number) {
  const user = await sessionUser(who);
  const policy = await hb.getHandbookPolicy(user, handbookId, docId);
  assert.ok(policy, `handbook ${handbookId} opens ${docId} to ${who}`);
  const base = await readerData.loadReaderBase(user, policy.handbook, SETTINGS_DEFAULTS);
  const view = await readerData.loadPolicyView(user, base, policy, SETTINGS_DEFAULTS);
  assert.ok(view.ackSeed, `${who} is asked to confirm it`);
  return view.confirm;
}

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, req: Request, id: number | string): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await handler(req, { params: Promise.resolve({ id: String(id) }) });
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

function sessionRequest(url: string, session: string, body?: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: {
      cookie: `compass_session=${session}`,
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.77",
      "user-agent": "HandbookReviewFixes/1.0",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ------------------------------------------------------------------------

const STAMP = `hbfix-${Date.now()}`;
const PASSWORD = "Handbook!Fix12345";
const people: Record<string, number> = {};
const sessions: Record<string, string> = {};
const spaces: Record<string, number> = {};
const groups: Record<string, number> = {};
const roles: number[] = [];
const docIds: number[] = [];
const handbookIds: number[] = [];

const as = (who: string) => ({ id: people[who], role: "viewer" as const, name: `${who} ${STAMP}`, username: `${STAMP}-${who}` });
const sessionUser = async (who: string) => (await getUserById(people[who])) as unknown as SessionUser;

async function newDoc(title: string, space: string, opts: { type?: "policy" | "knowledge" } = {}): Promise<number> {
  const d = await createDocument({
    space_id: spaces[space],
    title: `${STAMP} ${title}`,
    type: opts.type ?? "policy",
    status: "published",
    content: `SECRET-${title}: staff must follow the procedure described here.`,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(d.id);
  return d.id;
}

const latestVersion = async (docId: number) => (await listVersions(docId))[0].id;

/**
 * A handbook written straight to the tables (for contents no manager here
 * could add: documents of the private space P nobody reads), one section
 * holding `docs` in order.
 */
async function rawHandbook(
  title: string,
  docs: number[],
  opts: { groups?: number[]; signature?: boolean; confirmWhole?: boolean; status?: "draft" | "published"; spaceId?: number | null } = {}
): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO handbooks (title, space_id, status, audience, confirm_whole, require_signature, created_by_name, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'test', now()) RETURNING id`,
    [
      `${STAMP} ${title}`,
      opts.spaceId ?? null,
      opts.status ?? "published",
      opts.groups ? "groups" : "all",
      opts.confirmWhole ? 1 : 0,
      opts.signature ? 1 : 0,
    ]
  );
  const id = r.rows[0].id as number;
  handbookIds.push(id);
  for (const g of opts.groups ?? []) await pool().query("INSERT INTO handbook_audience (handbook_id, group_id) VALUES ($1, $2)", [id, g]);
  const sec = await pool().query("INSERT INTO handbook_sections (handbook_id, title, position) VALUES ($1, 'Policies', 0) RETURNING id", [id]);
  for (const [i, d] of docs.entries()) {
    await pool().query("INSERT INTO handbook_items (handbook_id, section_id, document_id, position) VALUES ($1, $2, $3, $4)", [
      id,
      sec.rows[0].id,
      d,
      i,
    ]);
  }
  return id;
}

const input = (o: Partial<import("../src/lib/handbooks").HandbookInput> = {}) => ({
  title: `${STAMP} Handbook`,
  space_id: null,
  introduction: "",
  audience: "groups" as const,
  group_ids: [] as number[],
  confirm_whole: false,
  require_signature: false,
  ...o,
});

async function expectError(p: Promise<unknown>, status: number, message?: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof hb.HandbookError, `a HandbookError, got ${String(e)}`);
    assert.equal(e.status, status, e.message);
    if (message) assert.equal(e.message, message);
    return true;
  });
}

async function rowOf(docId: number, who: string) {
  return (
    await pool().query<{ removed_at: string | null; cycle_started_at: string }>(
      "SELECT removed_at, cycle_started_at FROM policy_assignments WHERE document_id = $1 AND user_id = $2",
      [docId, people[who]]
    )
  ).rows[0];
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const space = async (key: string) => {
    const r = await fixtureQuery(
      "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '🔒', '', 'private') RETURNING id",
      [`${STAMP} ${key}`, `${STAMP}-${key}`]
    );
    spaces[key] = r.rows[0].id;
  };
  // A and B: two private spaces; P: a private space nobody here reads; S,
  // S2: private spaces that own space handbooks.
  for (const k of ["A", "B", "P", "S", "S2"]) await space(k);

  const creds = hashPassword(PASSWORD);
  const names = ["mgrA", "wsMgr", "glob", "alice", "carol", "dave", "erin", "frank", "ivan", "gina", "hank", "looker", "deleter"];
  for (const who of names) {
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status, password_hash, password_salt)
       VALUES ($1, $2, $3, 'viewer', 'active', $4, $5) RETURNING id`,
      [`${STAMP}-${who}`, `${who} ${STAMP}`, `${STAMP}-${who}@example.test`, creds.hash, creds.salt]
    );
    people[who] = r.rows[0].id;
  }
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const who of ["wsMgr", "alice", "carol", "looker", "deleter"]) {
    sessions[who] = newToken();
    await createSession(sessions[who], people[who], expires);
  }

  for (const k of ["gA", "gB", "gR", "gH", "gS", "gD", "gS2"]) groups[k] = (await createGroup({ name: `${STAMP} ${k}` })).id;
  const member = (g: string, who: string) => pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groups[g], people[who]]);
  await member("gA", "mgrA");
  await member("gA", "wsMgr");
  await member("gB", "wsMgr");
  await member("gA", "alice");
  await member("gR", "carol");
  await member("gR", "dave");
  await member("gA", "dave");
  await member("gA", "looker");
  await member("gD", "gina");
  await member("gS2", "hank");
  await setSpaceGroups(spaces.A, [groups.gA]);
  await setSpaceGroups(spaces.B, [groups.gB]);
  await setSpaceGroups(spaces.S, [groups.gS]);
  await setSpaceGroups(spaces.S2, [groups.gS2]);

  const role = async (name: string, permissions: string[]) => {
    const r = await createRole({ name: `${STAMP} ${name}`, permissions });
    assert.ok("id" in r, JSON.stringify(r));
    roles.push(r.id);
    return r.id;
  };
  const manage = await role("Handbook admin", ["handbook.manage"]);
  await assignRole({ roleId: manage, userId: people.mgrA, spaceId: spaces.A });
  await assignRole({ roleId: manage, userId: people.wsMgr });
  await assignRole({ roleId: manage, userId: people.glob });
  await assignRole({ roleId: await role("Lookup", ["document.lookup"]), userId: people.looker });
  await assignRole({ roleId: await role("Space deleter", ["space.delete"]), userId: people.deleter });
});

after(async () => {
  const userIds = Object.values(people);
  const groupIds = Object.values(groups);
  await pool().query("DELETE FROM handbook_confirmations WHERE handbook_id = ANY($1) OR user_id = ANY($2) OR handbook_title LIKE $3", [
    handbookIds,
    userIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM handbooks WHERE id = ANY($1) OR title LIKE $2", [handbookIds, `${STAMP}%`]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM doc_views WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'handbook' AND target_id = ANY($1)", [handbookIds.map(String)]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'document' AND target_id = ANY($1)", [docIds.map(String)]);
  await pool().query("DELETE FROM policy_assignments WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1) OR space_id = ANY($2)", [docIds, Object.values(spaces)]);
  await pool().query("DELETE FROM role_assignments WHERE role_id = ANY($1) OR group_id = ANY($2) OR user_id = ANY($3)", [roles, groupIds, userIds]);
  for (const r of roles) await deleteRole(r);
  await pool().query("DELETE FROM group_members WHERE group_id = ANY($1)", [groupIds]);
  await pool().query("DELETE FROM groups WHERE id = ANY($1)", [groupIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [Object.values(spaces)]);
  await pool().end();
});

// --- A1 ------------------------------------------------------------------------------

describe("A1: editing rights don't read or widen past what the editor could add", () => {
  test("a space handbook admin sees another space's document as a placeholder, can't read it, publish it or widen who reads it", async () => {
    const a1 = await newDoc("A-policy", "A");
    const b1 = await newDoc("B-policy", "B");
    // wsMgr manages handbooks everywhere and reads A and B: builds a space-A handbook holding B's policy.
    const h = await hb.createHandbook(as("wsMgr"), input({ title: `${STAMP} A book`, space_id: spaces.A, group_ids: [groups.gA] }));
    handbookIds.push(h.id);
    await hb.addHandbookItems(as("wsMgr"), h.id, [a1, b1]);

    // mgrA manages A only and cannot read B.
    const edit = (await hb.getHandbook(as("mgrA"), h.id, { forEdit: true }))!;
    const items = edit.sections.flatMap((s) => s.items);
    const bItem = items.find((i) => i.doc_id === b1)!;
    assert.equal(bItem.restricted, true, "B's policy is a placeholder in mgrA's editor");
    assert.equal(bItem.title, hb.HANDBOOK_RESTRICTED_ITEM);
    assert.equal(bItem.space_name, "");
    assert.equal(items.find((i) => i.doc_id === a1)!.restricted, false);
    assert.ok(!JSON.stringify(edit).includes("B-policy"), "nothing of B's policy's title reaches mgrA");

    const reader = (await hb.getHandbook(as("mgrA"), h.id))!;
    assert.deepEqual(reader.sections.flatMap((s) => s.items.map((i) => i.doc_id)), [a1], "the preview leaves it out");
    assert.equal(await hb.getHandbookPolicy(as("mgrA"), h.id, b1), undefined, "and never renders it");
    assert.ok((await hb.getHandbookPolicy(as("mgrA"), h.id, a1))?.document.content.includes("SECRET-A-policy"));

    // A save of the Contents card sends the placeholder back and keeps it.
    const saved = await hb.setHandbookContents(as("mgrA"), h.id, {
      sections: edit.sections.map((s) => ({ id: s.id, title: s.title, doc_ids: s.items.map((i) => i.doc_id).reverse() })),
    });
    assert.deepEqual(saved.sections.flatMap((s) => s.items.map((i) => i.doc_id)), [b1, a1]);

    // No widening: audience, owner and publishing are refused; the details are not.
    await expectError(hb.updateHandbook(as("mgrA"), h.id, { audience: "all" }), 403, hb.HANDBOOK_FOREIGN_CONTENTS);
    await expectError(hb.updateHandbook(as("mgrA"), h.id, { group_ids: [groups.gA, groups.gR] }), 403, hb.HANDBOOK_FOREIGN_CONTENTS);
    await expectError(hb.publishHandbook(as("mgrA"), h.id, true), 403, hb.HANDBOOK_FOREIGN_CONTENTS);
    const renamed = await hb.updateHandbook(as("mgrA"), h.id, { title: `${STAMP} A book renamed`, audience: "groups", group_ids: [groups.gA] });
    assert.equal(renamed.title, `${STAMP} A book renamed`, "a details save that sends the same audience back is not refused");
    assert.equal(renamed.audience, "groups");
    assert.equal(renamed.status, "draft");

    // Someone who could add from both spaces is unaffected.
    const published = await hb.publishHandbook(as("wsMgr"), h.id, true);
    assert.equal(published.status, "published");
    assert.ok(published.sections.flatMap((s) => s.items).every((i) => !i.restricted));
    // Published, mgrA reads it as its audience (a reader of A in gA): the handbook opens B's policy to its readers.
    assert.ok((await hb.getHandbookPolicy(as("mgrA"), h.id, b1))?.document.content.includes("SECRET-B-policy"));
  });

  test("a workspace handbook admin who can't read a space sees its documents as placeholders and can't publish or widen", async () => {
    const b2 = await newDoc("B-policy-2", "B");
    const w = await hb.createHandbook(as("wsMgr"), input({ title: `${STAMP} W`, group_ids: [groups.gB] }));
    handbookIds.push(w.id);
    await hb.addHandbookItems(as("wsMgr"), w.id, [b2]);
    // glob holds handbook.manage globally and reads no private space.
    const edit = (await hb.getHandbook(as("glob"), w.id, { forEdit: true }))!;
    assert.equal(edit.sections[0].items[0].restricted, true);
    assert.equal(await hb.getHandbookPolicy(as("glob"), w.id, b2), undefined);
    await expectError(hb.updateHandbook(as("glob"), w.id, { audience: "all" }), 403, hb.HANDBOOK_FOREIGN_CONTENTS);
    await expectError(hb.publishHandbook(as("glob"), w.id, true), 403, hb.HANDBOOK_FOREIGN_CONTENTS);
    assert.equal((await hb.publishHandbook(as("wsMgr"), w.id, true)).status, "published");
    assert.equal(await hb.handbookGrantsRead(people.carol, b2), false, "carol (outside gB) was never let in");
  });
});

// --- A2 ------------------------------------------------------------------------------

describe("A2: a space handbook's groups audience narrows within the people who can read the space", () => {
  test("a group member who can't read the owning space is not in the audience (JS and SQL); a workspace handbook may target any group", async () => {
    const a3 = await newDoc("A-policy-3", "A");
    const s = await hb.createHandbook(as("mgrA"), input({ title: `${STAMP} S groups`, space_id: spaces.A, group_ids: [groups.gR] }));
    handbookIds.push(s.id);
    await hb.addHandbookItems(as("mgrA"), s.id, [a3]);
    await hb.publishHandbook(as("mgrA"), s.id, true);
    // carol is in gR but cannot read A; dave is in gR and reads A.
    assert.equal(await hb.getHandbook(as("carol"), s.id), undefined);
    assert.equal(await hb.canRead(as("carol"), s.id), false);
    assert.equal(await publishedHandbookAdmits(people.carol, a3, s.id), false, "the SQL twin agrees");
    assert.equal(await hb.handbookGrantsRead(people.carol, a3), false);
    assert.ok(await hb.getHandbook(as("dave"), s.id));
    assert.equal(await publishedHandbookAdmits(people.dave, a3, s.id), true);

    const w = await rawHandbook("W groups", [a3], { groups: [groups.gR] });
    assert.equal(await publishedHandbookAdmits(people.carol, a3, w), true, "a workspace handbook reaches its groups");
    assert.ok(await hb.getHandbook(as("carol"), w));
  });
});

// --- A3 / A6 -------------------------------------------------------------------------

describe("A3 + A6: the sidebar tree and the [[ lookup leave handbook-only documents out", () => {
  test("hidden from a reader who does not look after the space, listed without a find scope", async () => {
    const shown = await newDoc("Tree-shown", "A");
    const hidden = await newDoc("Tree-hidden", "A");
    await pool().query("UPDATE documents SET find_mode = 'handbook_only' WHERE id = $1", [hidden]);
    await rawHandbook("Tree book", [hidden], { groups: [groups.gA] });

    const ids = (nodes: { id: number; children: any[] }[]): number[] => nodes.flatMap((n) => [n.id, ...ids(n.children)]);
    const all = ids(await tree.treeForSpace(spaces.A, false));
    assert.ok(all.includes(hidden) && all.includes(shown), "no find scope: nothing hidden");
    const forAlice = ids(await tree.treeForSpace(spaces.A, false, await visibility.findScopeFor(as("alice"))));
    assert.ok(forAlice.includes(shown));
    assert.ok(!forAlice.includes(hidden), "alice (a reader of A) does not come across it in the tree");

    const lookup = await import("../src/app/api/documents/lookup/route");
    const res = await call(
      lookup.GET as unknown as Handler,
      sessionRequest(`http://localhost/api/documents/lookup?q=${encodeURIComponent(`${STAMP} Tree`)}&limit=50`, sessions.looker, undefined, "GET"),
      0
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const found = (res.body.docs as { id: number }[]).map((d) => d.id);
    assert.ok(found.includes(shown), "the lookup lists the ordinary page");
    assert.ok(!found.includes(hidden), "and leaves the handbook-only one out");
  });
});

// --- A4 ------------------------------------------------------------------------------

describe("A4: the handbook signature switch covers confirmations made in handbooks", () => {
  test("a reader who has the policy only through handbooks signs even when naming a handbook with the switch off, and the reader's bar asks for it; a space reader keeps the policy's (and the handbook's) setting", async () => {
    const ack = await import("../src/app/api/documents/[id]/ack/route");
    const p1 = await newDoc("Signed elsewhere", "P");
    await rawHandbook("Signed", [p1], { groups: [groups.gR], signature: true });
    const unsigned = await rawHandbook("Unsigned", [p1], { groups: [groups.gR], confirmWhole: true });
    await switchOn(p1, { editDefault: null, recertMonths: null });
    assert.equal(await hasOpenAssignment(p1, people.carol), true);

    // The whole-handbook page asks too.
    const view = (await confirm.loadConfirmView(await sessionUser("carol"), unsigned))!;
    assert.equal(view.signature.required, true);
    assert.deepEqual(view.signature.policies, [`${STAMP} Signed elsewhere`]);
    // And so does the reader's confirm bar in the unsigned handbook: it shows
    // the name (and password) fields the route below demands.
    const bar = await readerConfirm("carol", unsigned, p1);
    assert.equal(bar.signature, true, "the bar asks for the signature POST /ack will demand");
    assert.equal(bar.localAccount, true, "with the password field (carol has a local password)");

    const url = `http://localhost/api/documents/${p1}/ack`;
    const version = await latestVersion(p1);
    const post = (extra: Record<string, unknown>) =>
      call(ack.POST as Handler, sessionRequest(url, sessions.carol, { version_id: version, handbook_id: unsigned, ...extra }), p1);
    const bare = await post({});
    assert.equal(bare.status, 409, JSON.stringify(bare.body));
    assert.match(bare.body.error, /Type your full name/);
    assert.equal(await getCurrentAck(p1, people.carol), undefined, "nothing recorded");
    const signed = await post({ signed_name: `carol ${STAMP}`, password: PASSWORD });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal((await getCurrentAck(p1, people.carol))?.signed_name, `carol ${STAMP}`);

    // alice reads space A: on the document's own card the policy's own setting applies.
    const a4 = await newDoc("Space reader's", "A");
    const signedA = await rawHandbook("Signed A", [a4], { groups: [groups.gA], signature: true });
    const unsignedA = await rawHandbook("Unsigned A", [a4], { groups: [groups.gA] });
    await switchOn(a4, { editDefault: null, recertMonths: null });
    // Her bar follows the handbook it is read in, as the route does for a
    // space reader: asked in the signed one, not in the unsigned one.
    assert.equal((await readerConfirm("alice", signedA, a4)).signature, true, "the handbook's own switch");
    assert.equal((await readerConfirm("alice", unsignedA, a4)).signature, false, "a space reader isn't held to another handbook's switch");
    const own = await call(
      ack.POST as Handler,
      sessionRequest(`http://localhost/api/documents/${a4}/ack`, sessions.alice, { version_id: await latestVersion(a4) }),
      a4
    );
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal((await getCurrentAck(a4, people.alice))?.signed_name, null);
  });
});

// --- A5 / D3 -------------------------------------------------------------------------

describe("A5 + D3: the group and space hooks, and deletes, reconcile handbook policies", () => {
  test("a group whose handbook audience gains a member opens their row; so does a space whose handbook gains a reader", async () => {
    const g1 = await newDoc("Group-book policy", "P");
    await rawHandbook("Group book", [g1], { groups: [groups.gH] });
    await switchOn(g1, { editDefault: null, recertMonths: null });
    // Straight into the table: no hook ran.
    await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groups.gH, people.erin]);
    assert.equal(await hasOpenAssignment(g1, people.erin), false);
    await reconcilePoliciesForGroup(groups.gH);
    assert.equal(await hasOpenAssignment(g1, people.erin), true, "the group hook reaches the handbook's policy");

    const s1 = await newDoc("Space-book policy", "P");
    await rawHandbook("Space book", [s1], { spaceId: spaces.S });
    await switchOn(s1, { editDefault: null, recertMonths: null });
    await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groups.gS, people.frank]);
    assert.equal(await hasOpenAssignment(s1, people.frank), false);
    await reconcilePoliciesForSpace(spaces.S);
    assert.equal(await hasOpenAssignment(s1, people.frank), true, "the space hook reaches the policies of the handbooks it owns");
    await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groups.gS, people.ivan]);
    await reconcilePoliciesForGroup(groups.gS);
    assert.equal(await hasOpenAssignment(s1, people.ivan), true, "and a group reaching the owning space reaches them too");
  });

  test("deleting a handbook's only audience group closes its readers' rows", async () => {
    const d1 = await newDoc("Deleted-group policy", "P");
    await rawHandbook("Deleted group book", [d1], { groups: [groups.gD] });
    await switchOn(d1, { editDefault: null, recertMonths: null });
    assert.equal(await hasOpenAssignment(d1, people.gina), true);
    assert.equal(await deleteGroup(groups.gD), true);
    assert.equal(await hasOpenAssignment(d1, people.gina), false);
    assert.ok((await rowOf(d1, "gina")).removed_at, "closed, not deleted");
  });

  test("deleting a space that owns a handbook closes its readers' rows and audits handbook.deleted", async () => {
    const e1 = await newDoc("Deleted-space policy", "P");
    const book = await rawHandbook("Deleted space book", [e1], { spaceId: spaces.S2 });
    await switchOn(e1, { editDefault: null, recertMonths: null });
    assert.equal(await hasOpenAssignment(e1, people.hank), true, "hank reads S2, so its handbook");
    const route = await import("../src/app/api/admin/spaces/[id]/route");
    const res = await call(
      route.DELETE as unknown as Handler,
      sessionRequest(`http://localhost/api/admin/spaces/${spaces.S2}`, sessions.deleter, undefined, "DELETE"),
      spaces.S2
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await pool().query("SELECT 1 FROM handbooks WHERE id = $1", [book])).rowCount, 0, "the handbook went with the space");
    assert.equal(await hasOpenAssignment(e1, people.hank), false, "its reader's row closed");
    const audits = (
      await pool().query<{ details: Record<string, any> }>(
        "SELECT details FROM audit_log WHERE action = 'handbook.deleted' AND target_type = 'handbook' AND target_id = $1",
        [String(book)]
      )
    ).rows;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].details.via, "space.delete");
    assert.deepEqual(audits[0].details.doc_ids, [e1]);
  });
});

// --- D1 ------------------------------------------------------------------------------

describe("D1: unpublish → republish keeps a still-valid confirmation counting", () => {
  test("the re-opened row keeps its cycle while the confirmation still counts; after a per-person re-ask it starts afresh", async () => {
    const r1 = await newDoc("Republished policy", "P");
    const book = await rawHandbook("Republished", [r1], { groups: [groups.gR] });
    await switchOn(r1, { editDefault: null, recertMonths: null });
    assert.equal((await recordAcknowledgement(r1, people.carol, "", await latestVersion(r1))).recorded, true);
    const opened = await rowOf(r1, "carol");
    const flip = async (status: "draft" | "published") => {
      await setHandbookStatusRow(book, status, "test");
      await reconcilePoliciesForHandbook(book);
    };

    await flip("draft");
    assert.ok((await rowOf(r1, "carol")).removed_at, "unpublished: the row closes");
    await flip("published");
    const back = await rowOf(r1, "carol");
    assert.equal(back.removed_at, null, "republished: it re-opens");
    assert.equal(back.cycle_started_at, opened.cycle_started_at, "with the cycle it had");
    assert.ok(await getCurrentAck(r1, people.carol), "and the confirmation still counts");

    // A real re-ask is not undone: the row's cycle moves past the confirmation.
    await pool().query("UPDATE policy_assignments SET cycle_started_at = now() WHERE document_id = $1 AND user_id = $2", [r1, people.carol]);
    assert.equal(await getCurrentAck(r1, people.carol), undefined);
    const asked = await rowOf(r1, "carol");
    await flip("draft");
    await flip("published");
    const again = await rowOf(r1, "carol");
    assert.equal(again.removed_at, null);
    assert.ok(new Date(again.cycle_started_at).getTime() > new Date(asked.cycle_started_at).getTime(), "a fresh cycle");
    assert.equal(await getCurrentAck(r1, people.carol), undefined, "still asked again");
  });
});

// --- D2 ------------------------------------------------------------------------------

describe("D2: conditional saves", () => {
  test("a details or contents save with a stale if_updated_at answers 409 and writes nothing; a fresh one moves the token", async () => {
    const h = await hb.createHandbook(as("wsMgr"), input({ title: `${STAMP} Concurrent`, group_ids: [groups.gA] }));
    handbookIds.push(h.id);
    const t0 = h.updated_at;
    const first = await hb.updateHandbook(as("wsMgr"), h.id, { title: `${STAMP} Concurrent one` }, undefined, { ifUpdatedAt: t0 });
    const t1 = first.updated_at;
    assert.notEqual(t1, t0);
    await expectError(
      hb.updateHandbook(as("wsMgr"), h.id, { title: `${STAMP} Concurrent two` }, undefined, { ifUpdatedAt: t0 }),
      409,
      hb.HANDBOOK_CHANGED_ELSEWHERE
    );
    assert.equal((await hb.getHandbook(as("wsMgr"), h.id, { forEdit: true }))!.title, `${STAMP} Concurrent one`, "nothing written");

    const sections = [{ id: first.sections[0].id, title: "Renamed", doc_ids: [] }];
    await expectError(hb.setHandbookContents(as("wsMgr"), h.id, { sections }, undefined, { ifUpdatedAt: t0 }), 409, hb.HANDBOOK_CHANGED_ELSEWHERE);
    assert.equal((await hb.getHandbook(as("wsMgr"), h.id, { forEdit: true }))!.sections[0].title, first.sections[0].title);
    const second = await hb.setHandbookContents(as("wsMgr"), h.id, { sections }, undefined, { ifUpdatedAt: t1 });
    assert.equal(second.sections[0].title, "Renamed");
    assert.ok(new Date(second.updated_at).getTime() > new Date(t1).getTime());

    // The route: the token in the body, the new one in the answer.
    const route = await import("../src/app/api/handbooks/[id]/route");
    const patch = (body: unknown) =>
      call(route.PATCH as unknown as Handler, sessionRequest(`http://localhost/api/handbooks/${h.id}`, sessions.wsMgr, body, "PATCH"), h.id);
    const stale = await patch({ title: `${STAMP} Concurrent three`, if_updated_at: t1 });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error, "This handbook was changed by someone else. Reload to see their changes.");
    const fresh = await patch({ title: `${STAMP} Concurrent three`, if_updated_at: second.updated_at });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal(fresh.body.updated_at, fresh.body.handbook.updated_at);
    assert.notEqual(fresh.body.updated_at, second.updated_at);
    assert.equal((await patch({ title: "x", if_updated_at: "not a time" })).status, 400);
  });
});

// --- D6 / D7 -------------------------------------------------------------------------

describe("D6 + D7: the whole-handbook record", () => {
  test("D6: contents that change while the confirmation is written are not recorded as confirmed", async () => {
    const q1 = await newDoc("Measured policy", "P");
    const q2 = await newDoc("Added mid-flight", "P", { type: "knowledge" });
    const book = await rawHandbook("Measured", [q1], { groups: [groups.gR], confirmWhole: true });
    await switchOn(q1, { editDefault: null, recertMonths: null });
    const carol = await sessionUser("carol");
    const shown = (await hb.getHandbook(as("carol"), book))!.fingerprint;
    const page = (await confirm.loadConfirmView(carol, book))!;

    // Hold the policy's row lock, so the confirmation's write waits on it,
    // and change the handbook while it waits.
    const locker = await pool().connect();
    let pending: Promise<Awaited<ReturnType<typeof confirm.confirmHandbook>>> | null = null;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM documents WHERE id = $1 FOR UPDATE", [q1]);
      const pid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = confirm.confirmHandbook(carol, book, { agreed: true, versions: { [q1]: await latestVersion(q1) }, statement: page.statement, fingerprint: shown }, { ip: null, userAgent: "t" });
      const deadline = Date.now() + 15_000;
      for (;;) {
        const waiting = await pool().query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
        if ((waiting.rowCount ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("the confirmation never reached its write");
        await new Promise((r) => setTimeout(r, 20));
      }
      const sec = (await pool().query("SELECT id FROM handbook_sections WHERE handbook_id = $1", [book])).rows[0].id;
      await pool().query("INSERT INTO handbook_items (handbook_id, section_id, document_id, position) VALUES ($1, $2, $3, 1)", [book, sec, q2]);
      await locker.query("COMMIT");
    } catch (e) {
      await locker.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      locker.release();
    }
    const result = await pending!;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.ok && result.confirmed === 1, "the policy is confirmed");
    assert.ok(result.ok && result.handbook_confirmed === false, "but not the handbook: its contents changed under the confirmation");
    const records = await pool().query("SELECT fingerprint FROM handbook_confirmations WHERE handbook_id = $1 AND user_id = $2", [book, people.carol]);
    assert.equal(records.rowCount, 0, "no record of contents nobody showed carol");
    assert.notEqual((await hb.getHandbook(as("carol"), book))!.fingerprint, shown);
  });

  test("D7: two submits at once write one record and one handbook.confirmed row", async () => {
    const q3 = await newDoc("Double submit policy", "P");
    const book = await rawHandbook("Double", [q3], { groups: [groups.gR], confirmWhole: true });
    await switchOn(q3, { editDefault: null, recertMonths: null });
    const dave = await sessionUser("dave");
    const page = (await confirm.loadConfirmView(dave, book))!;
    const body = { agreed: true, versions: { [q3]: await latestVersion(q3) }, statement: page.statement, fingerprint: page.handbook.fingerprint };
    const results = await Promise.all([
      confirm.confirmHandbook(dave, book, body, { ip: null, userAgent: "a" }),
      confirm.confirmHandbook(dave, book, body, { ip: null, userAgent: "b" }),
    ]);
    assert.ok(results.some((r) => r.ok), JSON.stringify(results));
    const records = await pool().query("SELECT 1 FROM handbook_confirmations WHERE handbook_id = $1 AND user_id = $2", [book, people.dave]);
    assert.equal(records.rowCount, 1);
    const audits = await pool().query(
      "SELECT 1 FROM audit_log WHERE action = 'handbook.confirmed' AND actor_id = $1 AND target_id = $2",
      [people.dave, String(book)]
    );
    assert.equal(audits.rowCount, 1, "audited once, by the submit that wrote it");
    assert.equal((await pool().query("SELECT 1 FROM acknowledgements WHERE document_id = $1 AND user_id = $2", [q3, people.dave])).rowCount, 1);

    // The writer itself: a second insert of the same contents writes nothing.
    const fingerprint = (await hb.getHandbook(as("dave"), book))!.fingerprint;
    const row = {
      handbook_id: book,
      handbook_title: "t",
      user_id: people.dave,
      user_name: "dave",
      fingerprint,
      items: [],
      policies_confirmed: 0,
      signed_name: null,
      ip: "",
      user_agent: "",
    };
    assert.equal(await insertHandbookConfirmation(null, row), null);
    assert.equal(await hb.recordHandbookConfirmation({ handbook_id: book, user_id: people.dave, fingerprint }), null);
  });
});

// --- D4 ------------------------------------------------------------------------------

describe("D4: erasure", () => {
  test("anonymiseComplianceRecord rewrites the person's whole-handbook records; the counts include them", async () => {
    const book = await rawHandbook("Erased", [], { groups: [groups.gR] });
    const written = await insertHandbookConfirmation(null, {
      handbook_id: book,
      handbook_title: `${STAMP} Erased`,
      user_id: people.erin,
      user_name: `erin ${STAMP}`,
      fingerprint: "erasure",
      items: [],
      policies_confirmed: 0,
      signed_name: `erin ${STAMP}`,
      ip: "198.51.100.9",
      user_agent: "ErinBrowser/1.0",
    });
    assert.ok(written);
    assert.equal(await countUserAttestations(people.erin), 1, "a handbook record counts as an attestation record");
    assert.equal((await attestationCountsByUser()).get(people.erin), 1, "so the Users page offers the erasure");
    const result = await anonymiseComplianceRecord(people.erin);
    assert.ok(result.rows >= 1);
    const row = (
      await pool().query("SELECT user_name, signed_name, ip, user_agent FROM handbook_confirmations WHERE id = $1", [written!.id])
    ).rows[0];
    assert.deepEqual(row, { user_name: `Former staff #${people.erin}`, signed_name: "", ip: "", user_agent: "" });
  });
});
