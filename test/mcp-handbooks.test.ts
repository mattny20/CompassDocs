// Policy handbooks over the Claude connector (1.18.2): list_handbooks,
// read_handbook, handbook_status, create_handbook and
// update_handbook_contents, called through POST /api/mcp with a personal
// API token, exactly as a connected assistant calls them.
//
// What is pinned: reading goes through the handbook reader's access path (a
// published handbook opens a policy from a private space its reader can't
// otherwise open; a draft is its editors' alone; an editor sees a document
// from a space they can't add from only as a placeholder, never its title
// or text); handbook-only hiding of the ordinary listings is unaffected;
// the reader's standing and the editors' audience progress follow the
// Read confirmation licence; create always makes a draft and needs Build
// handbooks for the owner; a contents save validates like PUT
// …/contents, answers 409 on a stale if_updated_at and checks the
// find-mode permission before anything is written; every write is audited
// as the REST routes audit it, plus `via: "mcp"` and the caller's address.
// No tool confirms (test/ack-tokens.test.ts pins the tool names too).
//
// Fixtures: two private spaces granted to this file's own groups, viewer
// accounts holding custom roles (no administrator: integration files share
// one database and run in parallel), STAMP-prefixed and removed in after().
// Every published handbook's audience is this file's own groups, so no
// other file's accounts are enrolled in a policy. lib/ee is stubbed to grant
// policy_ack (one test takes it away) and next/headers to serve the request
// under test, as test/handbooks.test.ts does.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/mcp-handbooks.test.ts

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
  createRole,
  assignRole,
  deleteRole,
  createApiToken,
  listVersions,
  recordAcknowledgement,
} from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";
import type { HandbookUser } from "../src/lib/handbooks";

// --- The request scope outside Next ------------------------------------------

let currentRequest: Request | null = null;

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.mcp-handbooks.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.mcp-handbooks.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
/** lib/ee as a licensed build sees it; the licence test empties `features`. */
const edition = { present: true, features: ["policy_ack"] as string[] };
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;

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

/** The address every request claims, so the audit rows can be checked for it. */
const CLIENT_IP = "203.0.113.77";

type ToolAnswer = { isError: boolean; text: string; out: any };

/** One JSON-RPC call through the connector. */
async function rpc(bearer: string, method: string, params: Record<string, unknown>): Promise<any> {
  const mcp = await import("../src/app/api/mcp/route");
  currentRequest = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-forwarded-for": CLIENT_IP },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  try {
    const res = await mcp.POST(currentRequest);
    assert.equal(res.status, 200);
    return await res.json();
  } finally {
    currentRequest = null;
  }
}

/** One tools/call; `out` is the parsed JSON result, or null when the text is a plain sentence (an error). */
async function tool(who: string, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const body = await rpc(tokens[who], "tools/call", { name, arguments: args });
  const text: string = body.result?.content?.[0]?.text ?? "";
  let out: any = null;
  try {
    out = JSON.parse(text);
  } catch {
    /* a sentence */
  }
  return { isError: body.result?.isError === true, text, out };
}

// --- Fixtures -------------------------------------------------------------------

const STAMP = `mcphb-${Date.now()}`;

let spaceA = 0; // private: gA (alice, mgrA), gW (wsAdmin)
let spaceB = 0; // private: gW (wsAdmin)
let gA = 0;
let gW = 0;
let gR = 0; // carol: reads neither space
let roleId = 0;
let globalRoleId = 0;
const people: Record<string, number> = {};
const tokens: Record<string, string> = {};
const userIds: number[] = [];
const docIds: number[] = [];
const docs: Record<string, number> = {};
const handbooks: Record<string, number> = {};
/** Groups a test makes for itself (removed in after()). */
const extraGroups: number[] = [];

const as = (tag: string): HandbookUser => ({ id: people[tag], role: "viewer", name: `${tag} ${STAMP}` });

async function newPerson(tag: string): Promise<void> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP}-${tag}`, `${tag} ${STAMP}`, `${STAMP}-${tag}@example.test`]
  );
  people[tag] = r.rows[0].id;
  userIds.push(r.rows[0].id);
  tokens[tag] = (await createApiToken(r.rows[0].id, `${STAMP} ${tag}`, ["read", "write"])).token;
}

async function newDoc(tag: string, spaceId: number, status: "published" | "draft" = "published"): Promise<number> {
  const doc = await createDocument({
    space_id: spaceId,
    title: `${STAMP} ${tag}`,
    type: "policy",
    status,
    content: `# ${tag}\n\nSECRET-${tag}: staff must follow this.`,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  docs[tag] = doc.id;
  return doc.id;
}

async function auditRows(action: string, targetType: string, targetId: number) {
  const r = await pool().query<{ details: Record<string, any>; ip: string | null }>(
    "SELECT details, ip FROM audit_log WHERE action = $1 AND target_type = $2 AND target_id = $3 ORDER BY id",
    [action, targetType, String(targetId)]
  );
  return r.rows;
}

/** Runs `fn` with every query whose text matches `match` failing (pool queries and pooled clients alike): a fault injected after the checks. */
async function failingWhen<T>(match: RegExp, fn: () => Promise<T>): Promise<T> {
  const p = pool() as unknown as { query: (...a: unknown[]) => Promise<unknown>; connect: (...a: unknown[]) => Promise<any> };
  const query = p.query;
  const connect = p.connect;
  const guard = (orig: (...a: unknown[]) => Promise<unknown>) =>
    function (this: unknown, ...args: unknown[]) {
      const text = typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string } | null)?.text ?? "");
      if (match.test(text)) return Promise.reject(new Error("injected failure"));
      return orig.apply(this, args);
    };
  p.query = guard(query);
  p.connect = async function (...args: unknown[]) {
    if (typeof args[0] === "function") return connect.apply(p, args); // pool.query's own checkout
    const client = await connect.apply(p, args);
    const own = client.query;
    const release = client.release;
    client.query = guard(own);
    client.release = function (...r: unknown[]) {
      client.query = own;
      client.release = release;
      return release.apply(client, r);
    };
    return client;
  };
  try {
    return await fn();
  } finally {
    p.query = query;
    p.connect = connect;
  }
}

/** The pool queries `fn` makes (lib/db's q() goes through pool().query), with their text. */
async function queriesOf<T>(fn: () => Promise<T>): Promise<{ result: T; texts: string[] }> {
  const p = pool() as unknown as { query: (...a: unknown[]) => Promise<unknown> };
  const query = p.query;
  const texts: string[] = [];
  p.query = function (this: unknown, ...args: unknown[]) {
    texts.push(typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string } | null)?.text ?? ""));
    return query.apply(this, args);
  };
  try {
    return { result: await fn(), texts };
  } finally {
    p.query = query;
  }
}

async function handbookIdsTitled(prefix: string): Promise<number[]> {
  const r = await pool().query<{ id: number }>("SELECT id FROM handbooks WHERE title LIKE $1 ORDER BY id", [`${prefix}%`]);
  return r.rows.map((x) => x.id);
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const mk = async (name: string) =>
    (
      await fixtureQuery("INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id", [
        `${name} ${STAMP}`,
        `${STAMP}-${name.toLowerCase()}`,
      ])
    ).rows[0].id as number;
  spaceA = await mk("A");
  spaceB = await mk("B");
  for (const tag of ["wsAdmin", "mgrA", "alice", "carol", "nobody"]) await newPerson(tag);
  gA = (await createGroup({ name: `${STAMP} GA` })).id;
  gW = (await createGroup({ name: `${STAMP} GW` })).id;
  gR = (await createGroup({ name: `${STAMP} Readers` })).id;
  await addGroupMember(gA, people.alice);
  await addGroupMember(gA, people.mgrA);
  await addGroupMember(gW, people.wsAdmin);
  await addGroupMember(gR, people.carol);
  await setSpaceGroups(spaceA, [gA, gW]);
  await setSpaceGroups(spaceB, [gW]);

  const global = await createRole({ name: `${STAMP} Workspace handbook admin`, permissions: ["handbook.manage"] });
  assert.ok("id" in global);
  globalRoleId = global.id;
  await assignRole({ roleId: globalRoleId, userId: people.wsAdmin });
  const role = await createRole({ name: `${STAMP} Space handbook admin`, permissions: ["handbook.manage"] });
  assert.ok("id" in role);
  roleId = role.id;
  await assignRole({ roleId, userId: people.mgrA, spaceId: spaceA });

  await newDoc("pA1", spaceA);
  await newDoc("pA2", spaceA);
  await newDoc("pB1", spaceB);
  await newDoc("pAdraft", spaceA, "draft");
  // pA1 asks for confirmation: its space's readers, and (once H1 is
  // published) the handbook's audience, all of them this file's people.
  await switchOn(docs.pA1, { editDefault: null, recertMonths: null });
  // pA2 is found only in handbooks (by ordinary readers).
  await pool().query("UPDATE documents SET find_mode = 'handbook_only' WHERE id = $1", [docs.pA2]);

  // H1: a published workspace handbook read by gR (carol) and gA (alice, mgrA).
  const admin = as("wsAdmin");
  const h1 = await hb.createHandbook(admin, {
    title: `${STAMP} H1 Staff handbook`,
    space_id: null,
    introduction: "Welcome to the staff handbook.",
    audience: "groups",
    group_ids: [gR, gA],
    confirm_whole: true,
    require_signature: false,
  });
  handbooks.H1 = h1.id;
  await hb.setHandbookContents(admin, h1.id, {
    sections: [
      { id: h1.sections[0].id, title: "Working here", doc_ids: [docs.pA1, docs.pA2] },
      { title: "Security", doc_ids: [docs.pB1] },
    ],
  });
  await hb.publishHandbook(admin, h1.id, true);

  // H2: a draft workspace handbook.
  const h2 = await hb.createHandbook(admin, {
    title: `${STAMP} H2 Draft`,
    space_id: null,
    introduction: "",
    audience: "groups",
    group_ids: [gR],
    confirm_whole: false,
    require_signature: false,
  });
  handbooks.H2 = h2.id;
  await hb.setHandbookContents(admin, h2.id, { sections: [{ id: h2.sections[0].id, title: "Policies", doc_ids: [docs.pA1] }] });

  // H3: a draft space-A handbook holding B's policy (wsAdmin may add from B; mgrA may not).
  const h3 = await hb.createHandbook(admin, {
    title: `${STAMP} H3 Space A`,
    space_id: spaceA,
    introduction: "",
    audience: "all",
    group_ids: [],
    confirm_whole: false,
    require_signature: false,
  });
  handbooks.H3 = h3.id;
  await hb.setHandbookContents(admin, h3.id, { sections: [{ id: h3.sections[0].id, title: "Policies", doc_ids: [docs.pA1, docs.pB1] }] });
});

after(async () => {
  const ids = await handbookIdsTitled(STAMP);
  await fixtureQuery("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM audit_log WHERE target_type = 'handbook' AND target_id = ANY($1)", [ids.map(String)]);
  await fixtureQuery("DELETE FROM audit_log WHERE target_type = 'document' AND target_id = ANY($1)", [docIds.map(String)]);
  await fixtureQuery("DELETE FROM handbook_confirmations WHERE handbook_id = ANY($1) OR user_id = ANY($2)", [ids, userIds]);
  await fixtureQuery("DELETE FROM handbooks WHERE id = ANY($1)", [ids]);
  for (const table of ["acknowledgements", "ack_decisions", "ack_notices", "ack_outbox", "attested_texts", "policy_assignments", "doc_views"]) {
    await fixtureQuery(`DELETE FROM ${table} WHERE document_id = ANY($1)`, [docIds]);
  }
  await fixtureQuery("DELETE FROM policy_assignments WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM documents WHERE id = ANY($1) OR space_id = ANY($2)", [docIds, [spaceA, spaceB]]);
  await fixtureQuery("DELETE FROM api_tokens WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM role_assignments WHERE role_id = ANY($1)", [[roleId, globalRoleId]]);
  if (roleId) await deleteRole(roleId);
  if (globalRoleId) await deleteRole(globalRoleId);
  await fixtureQuery("DELETE FROM group_members WHERE group_id = ANY($1)", [[gA, gW, gR, ...extraGroups]]);
  await fixtureQuery("DELETE FROM groups WHERE id = ANY($1)", [[gA, gW, gR, ...extraGroups]]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM spaces WHERE id = ANY($1)", [[spaceA, spaceB]]);
  await pool().end();
});

// --- The tool surface -------------------------------------------------------------

describe("the handbook tools are offered, and none confirms", () => {
  test("tools/list has the five tools with object schemas; no tool name confirms", async () => {
    const tools: { name: string; description: string; inputSchema: { type: string } }[] = (await rpc(tokens.carol, "tools/list", {})).result.tools;
    const names = tools.map((t) => t.name);
    for (const n of ["list_handbooks", "read_handbook", "handbook_status", "create_handbook", "update_handbook_contents"]) {
      const t = tools.find((x) => x.name === n);
      assert.ok(t, `${n} is offered`);
      assert.equal(t!.inputSchema.type, "object");
    }
    assert.deepEqual(names.filter((n) => /ack|confirm|attest|reconfirm/i.test(n)), []);
    assert.match(tools.find((t) => t.name === "create_handbook")!.description, /DRAFT/);
    assert.match(tools.find((t) => t.name === "update_handbook_contents")!.description, /live/);
    // Audience progress shows to the people the Handbooks page shows it to (lib/handbooks seesProgress).
    for (const n of ["list_handbooks", "handbook_status"]) {
      assert.match(tools.find((t) => t.name === n)!.description, /editors, and people who hold Read compliance program/);
    }
  });
});

// --- Reading -------------------------------------------------------------------------

describe("list_handbooks and read_handbook follow the reader's access", () => {
  test("an audience reader lists the published handbook, never the drafts, with their own progress", async () => {
    const r = await tool("carol", "list_handbooks");
    assert.equal(r.isError, false, r.text);
    const mine = r.out.handbooks.filter((h: any) => String(h.title).startsWith(STAMP));
    assert.deepEqual(mine.map((h: any) => h.id), [handbooks.H1]);
    const h1 = mine[0];
    assert.equal(h1.status, "published");
    assert.equal(h1.owner, hb.HANDBOOK_WORKSPACE_LABEL);
    assert.equal(h1.policies, 3);
    assert.equal(h1.sections, 2);
    assert.equal(h1.confirm_whole, true);
    assert.equal(h1.can_edit, false);
    assert.equal(h1.confirm_url, `/handbooks/${handbooks.H1}/confirm`);
    assert.equal(h1.edit_url, undefined);
    assert.equal(h1.audience_progress, undefined, "a reader is never shown everyone's standing");
    assert.deepEqual(h1.your_progress, { confirmed: 0, of: 1 }, "pA1 asks carol through the handbook");
    assert.match(r.out.note, /no tool confirms/);

    const drafts = await tool("carol", "list_handbooks", { status: "draft" });
    assert.deepEqual(drafts.out.handbooks.filter((h: any) => String(h.title).startsWith(STAMP)), []);
    const alice = await tool("alice", "list_handbooks");
    assert.deepEqual(
      alice.out.handbooks.filter((h: any) => String(h.title).startsWith(STAMP)).map((h: any) => h.id),
      [handbooks.H1],
      "alice reads A, but H3 (space A) is a draft: its editors' alone"
    );
    assert.deepEqual((await tool("nobody", "list_handbooks")).out.handbooks.filter((h: any) => String(h.title).startsWith(STAMP)), []);
  });

  test("an editor lists drafts too, with audience progress; the space filter narrows", async () => {
    const r = await tool("wsAdmin", "list_handbooks");
    const mine = r.out.handbooks.filter((h: any) => String(h.title).startsWith(STAMP));
    assert.deepEqual(mine.map((h: any) => h.id).sort((a: number, b: number) => a - b), [handbooks.H1, handbooks.H2, handbooks.H3].sort((a, b) => a - b));
    const h1 = mine.find((h: any) => h.id === handbooks.H1);
    assert.ok(h1.audience_progress, "editors see the Handbooks page's progress");
    assert.equal(typeof h1.audience_progress.pct, "number");
    assert.equal(h1.edit_url, `/handbooks/${handbooks.H1}/edit`);
    const spaceOnly = await tool("wsAdmin", "list_handbooks", { space: `${STAMP}-a` });
    assert.deepEqual(spaceOnly.out.handbooks.map((h: any) => h.id), [handbooks.H3]);
    const ws = await tool("wsAdmin", "list_handbooks", { space: "workspace", status: "draft" });
    assert.deepEqual(ws.out.handbooks.filter((h: any) => String(h.title).startsWith(STAMP)).map((h: any) => h.id), [handbooks.H2]);
    assert.equal((await tool("carol", "list_handbooks", { space: `${STAMP}-a` })).isError, true, "a space carol can't see is not named");
  });

  test("a reader reads a policy from a private space they can't otherwise open, through the handbook", async () => {
    const r = await tool("carol", "read_handbook", { id: handbooks.H1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.introduction, "Welcome to the staff handbook.");
    assert.deepEqual(r.out.sections.map((s: any) => s.title), ["Working here", "Security"]);
    const flat = r.out.sections.flatMap((s: any) => s.policies);
    assert.deepEqual(flat.map((p: any) => p.number), [1, 2, 3]);
    const b1 = flat.find((p: any) => p.doc_id === docs.pB1);
    assert.match(b1.text, /SECRET-pB1/);
    assert.equal(b1.url, `/handbooks/${handbooks.H1}/${docs.pB1}`);
    assert.equal(b1.type, "policy");
    assert.ok("owner" in b1.facts && "next_review" in b1.facts && "applies_to" in b1.facts);
    assert.equal(b1.facts.version, 1);
    assert.match(String(b1.facts.effective), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(flat.find((p: any) => p.doc_id === docs.pA1).asks_confirmation, true);
    assert.equal(r.out.can_edit, false);
    assert.equal(r.out.groups, undefined, "the audience's groups are the editors' business");

    // The document's own page keeps its space check: read_doc does not open it.
    assert.equal((await tool("carol", "read_doc", { id: docs.pB1 })).isError, true);
    const one = await tool("carol", "read_handbook", { id: handbooks.H1, doc_id: docs.pB1 });
    assert.equal(one.isError, false, one.text);
    assert.match(one.out.policy.text, /SECRET-pB1/);
    assert.equal(one.out.section.title, "Security");
    assert.equal(one.out.prev.doc_id, docs.pA2);
    assert.equal(one.out.next, null);
    const outline = await tool("carol", "read_handbook", { id: handbooks.H1, include_text: false });
    assert.ok(outline.out.sections.flatMap((s: any) => s.policies).every((p: any) => p.text === undefined));
    // Someone outside the audience reads nothing.
    assert.equal((await tool("nobody", "read_handbook", { id: handbooks.H1 })).isError, true);
    assert.equal((await tool("nobody", "read_handbook", { id: handbooks.H1, doc_id: docs.pA1 })).isError, true);
  });

  test("a draft is invisible to non-editors", async () => {
    for (const who of ["carol", "alice"]) {
      const r = await tool(who, "read_handbook", { id: handbooks.H2 });
      assert.equal(r.isError, true);
      assert.ok(!r.text.includes("H2 Draft"));
      assert.equal((await tool(who, "handbook_status", { id: handbooks.H2 })).isError, true);
    }
    const editor = await tool("wsAdmin", "read_handbook", { id: handbooks.H2 });
    assert.equal(editor.isError, false, editor.text);
    assert.equal(editor.out.status, "draft");
  });

  test("a space-scoped editor sees another space's document as a placeholder, never its title or text", async () => {
    const r = await tool("mgrA", "read_handbook", { id: handbooks.H3 });
    assert.equal(r.isError, false, r.text);
    const flat = r.out.sections.flatMap((s: any) => s.policies);
    const b1 = flat.find((p: any) => p.doc_id === docs.pB1);
    assert.equal(b1.restricted, true);
    assert.equal(b1.title, hb.HANDBOOK_RESTRICTED_ITEM);
    assert.equal(b1.text, undefined);
    assert.ok(!r.text.includes("SECRET-pB1") && !r.text.includes(`${STAMP} pB1`), "nothing of B's policy reaches mgrA");
    assert.equal(b1.type, undefined, "a placeholder's type is not answered");
    // The editor's own JSON (GET /api/handbooks/[id] for editing) carries a neutral type, never the real one.
    const forEdit = await hb.getHandbook(as("mgrA"), handbooks.H3, { forEdit: true });
    const placeholder = forEdit!.sections.flatMap((s) => s.items).find((i) => i.doc_id === docs.pB1)!;
    assert.equal(placeholder.restricted, true);
    assert.equal(placeholder.type, hb.RESTRICTED_ITEM_TYPE);
    assert.notEqual(placeholder.type, "policy");
    assert.equal(forEdit!.item_types.other, 1, "counted as a plain document");
    assert.match(flat.find((p: any) => p.doc_id === docs.pA1).text, /SECRET-pA1/);
    const one = await tool("mgrA", "read_handbook", { id: handbooks.H3, doc_id: docs.pB1 });
    assert.equal(one.isError, true);
    assert.ok(!one.text.includes("SECRET-pB1"));
  });

  test("handbook-only filtering of the ordinary listings is unaffected; the handbook still shows it", async () => {
    const list = await tool("alice", "list_docs", { space: `${STAMP}-a` });
    const ids = list.out.map((d: any) => d.id);
    assert.ok(ids.includes(docs.pA1));
    assert.ok(!ids.includes(docs.pA2), "the handbook-only policy stays out of alice's space listing");
    const r = await tool("alice", "read_handbook", { id: handbooks.H1 });
    const a2 = r.out.sections.flatMap((s: any) => s.policies).find((p: any) => p.doc_id === docs.pA2);
    assert.equal(a2.handbook_only, true);
    assert.match(a2.text, /SECRET-pA2/);
  });
});

// --- Standing ------------------------------------------------------------------------

describe("handbook_status", () => {
  test("a reader's own standing per policy, the whole-handbook record and where to confirm", async () => {
    let r = await tool("carol", "handbook_status", { id: handbooks.H1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.confirmation_available, true);
    const standing = (out: any) => Object.fromEntries(out.policies.map((p: any) => [p.doc_id, p.standing]));
    assert.deepEqual(standing(r.out), { [docs.pA1]: "To confirm", [docs.pA2]: "For information", [docs.pB1]: "For information" });
    assert.deepEqual(r.out.your_progress, { confirmed: 0, of: 1, to_confirm: 1, updated: 0, for_information: 2 });
    assert.deepEqual(r.out.whole_handbook, { asked: true, recorded: false, recorded_at: null, confirm_url: `/handbooks/${handbooks.H1}/confirm` });
    assert.equal(r.out.audience_progress, undefined);
    assert.match(r.out.note, /never confirms/);

    // The person confirms in the app (here: the record the card writes).
    const v = (await listVersions(docs.pA1))[0].id;
    await recordAcknowledgement(docs.pA1, people.carol, "", v);
    r = await tool("carol", "handbook_status", { id: handbooks.H1 });
    assert.equal(standing(r.out)[docs.pA1], "Confirmed");
    assert.ok(r.out.policies.find((p: any) => p.doc_id === docs.pA1).confirmed_at);
    assert.equal(r.out.your_progress.confirmed, 1);
    const listed = (await tool("carol", "list_handbooks")).out.handbooks.find((h: any) => h.id === handbooks.H1);
    assert.deepEqual(listed.your_progress, { confirmed: 1, of: 1 });
  });

  test("an editor also gets the audience progress, without names", async () => {
    const r = await tool("wsAdmin", "handbook_status", { id: handbooks.H1 });
    assert.equal(r.isError, false, r.text);
    const p = r.out.audience_progress;
    assert.ok(p && typeof p.audience === "number" && typeof p.confirmed === "number" && typeof p.pct === "number");
    assert.ok(p.audience >= 3, "carol, alice and mgrA are in the audience");
    assert.ok(!r.text.includes(`carol ${STAMP}`) && !r.text.includes(`alice ${STAMP}`), "no per-person names");
    const draft = await tool("wsAdmin", "handbook_status", { id: handbooks.H2 });
    assert.match(draft.out.note, /draft/);
  });

  test("without the Read confirmation licence: confirmation isn't available, and no progress is given", async () => {
    edition.features = [];
    try {
      const r = await tool("carol", "handbook_status", { id: handbooks.H1 });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.out.confirmation_available, false);
      assert.equal(r.out.policies, undefined);
      assert.match(r.out.note, /licence/);
      const listed = (await tool("carol", "list_handbooks")).out;
      const h1 = listed.handbooks.find((h: any) => h.id === handbooks.H1);
      assert.equal(h1.your_progress, null);
      assert.equal(h1.confirm_url, undefined);
      const editor = (await tool("wsAdmin", "list_handbooks")).out.handbooks.find((h: any) => h.id === handbooks.H1);
      assert.equal(editor.audience_progress, undefined);
      // Reading is not licence-gated.
      assert.equal((await tool("carol", "read_handbook", { id: handbooks.H1 })).isError, false);
    } finally {
      edition.features = ["policy_ack"];
    }
  });
});

// --- Writing -------------------------------------------------------------------------

describe("create_handbook", () => {
  test("needs Build handbooks for the owner", async () => {
    const denied = await tool("alice", "create_handbook", { title: `${STAMP} by alice` });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /permission/);
    const ws = await tool("mgrA", "create_handbook", { title: `${STAMP} mgrA workspace` });
    assert.equal(ws.isError, true);
    assert.equal(ws.text, hb.HANDBOOK_OWNER_DENIED);
    const unseen = await tool("mgrA", "create_handbook", { title: `${STAMP} mgrA B`, owner: `${STAMP}-b` });
    assert.equal(unseen.isError, true, "a space mgrA can't read is not named");
    assert.deepEqual(await handbookIdsTitled(`${STAMP} mgrA`), []);
    assert.deepEqual(await handbookIdsTitled(`${STAMP} by alice`), []);
  });

  test("validates like POST /api/handbooks, and refuses documents you can't add before writing anything", async () => {
    assert.equal((await tool("wsAdmin", "create_handbook", { title: "  " })).text, hb.HANDBOOK_TITLE_REQUIRED);
    assert.equal((await tool("wsAdmin", "create_handbook", { title: "x".repeat(161) })).text, hb.HANDBOOK_TITLE_REQUIRED);
    assert.equal((await tool("wsAdmin", "create_handbook", { title: `${STAMP} v`, audience: "some" })).text, hb.HANDBOOK_AUDIENCE_INVALID);
    assert.equal((await tool("wsAdmin", "create_handbook", { title: `${STAMP} v`, groups: ["no such group anywhere"] })).isError, true);
    const dup = await tool("wsAdmin", "create_handbook", {
      title: `${STAMP} v`,
      sections: [{ title: "A", documents: [docs.pA1] }, { title: "B", documents: [docs.pA1] }],
    });
    assert.equal(dup.text, hb.HANDBOOK_DOC_IDS_INVALID);
    const foreign = await tool("mgrA", "create_handbook", {
      title: `${STAMP} vA`,
      owner: `${STAMP}-a`,
      sections: [{ title: "Policies", documents: [docs.pA1, docs.pB1] }],
    });
    assert.equal(foreign.isError, true);
    assert.match(foreign.text, new RegExp(String(docs.pB1)));
    const draftDoc = await tool("wsAdmin", "create_handbook", { title: `${STAMP} v`, sections: [{ title: "P", documents: [docs.pAdraft] }] });
    assert.equal(draftDoc.isError, true, "a draft document can't be added");
    assert.deepEqual(await handbookIdsTitled(`${STAMP} v`), [], "no empty draft left behind");
  });

  test("a space handbook admin creates a space handbook: always a draft, audited via mcp", async () => {
    const r = await tool("mgrA", "create_handbook", {
      title: `${STAMP} Created A`,
      owner: `${STAMP}-a`,
      introduction: "Read this first.",
      confirm_whole: true,
      publish: true, // not a parameter: nothing publishes
      sections: [
        { title: "One", documents: [docs.pA1] },
        { title: "Two", documents: [docs.pA2] },
      ],
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.status, "draft");
    assert.equal(r.out.owner, `A ${STAMP}`);
    assert.equal(r.out.edit_url, `/handbooks/${r.out.id}/edit`);
    assert.match(r.out.note, /draft/);
    assert.deepEqual(r.out.sections.map((s: any) => [s.title, s.documents]), [["One", [docs.pA1]], ["Two", [docs.pA2]]]);
    const created = await auditRows("handbook.created", "handbook", r.out.id);
    assert.equal(created.length, 1);
    assert.equal(created[0].details.via, "mcp");
    assert.equal(created[0].ip, CLIENT_IP);
    assert.equal(created[0].details.space_id, spaceA);
    const changed = await auditRows("handbook.contents_changed", "handbook", r.out.id);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].details.via, "mcp");
    assert.deepEqual(changed[0].details.added.sort(), [docs.pA1, docs.pA2].sort());
    assert.equal((await auditRows("handbook.published", "handbook", r.out.id)).length, 0);
    // alice reads space A but not this draft.
    assert.equal((await tool("alice", "read_handbook", { id: r.out.id })).isError, true);
  });

  test("a workspace handbook admin creates a workspace handbook for named groups", async () => {
    const r = await tool("wsAdmin", "create_handbook", {
      title: `${STAMP} Created W`,
      owner: "workspace",
      audience: "groups",
      groups: [`${STAMP} Readers`, gA],
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.status, "draft");
    assert.equal(r.out.owner, hb.HANDBOOK_WORKSPACE_LABEL);
    assert.deepEqual([...r.out.groups].sort(), [`${STAMP} GA`, `${STAMP} Readers`].sort());
    assert.deepEqual(r.out.sections.map((s: any) => s.title), [hb.HANDBOOK_FIRST_SECTION]);
    assert.equal((await auditRows("handbook.created", "handbook", r.out.id))[0].details.via, "mcp");
    assert.equal((await auditRows("handbook.contents_changed", "handbook", r.out.id)).length, 0, "no contents given, none changed");
    assert.equal((await tool("carol", "read_handbook", { id: r.out.id })).isError, true, "drafts stay with their editors");
  });
});

describe("update_handbook_contents", () => {
  test("only an editor; validates like PUT …/contents", async () => {
    const reader = await tool("carol", "update_handbook_contents", { id: handbooks.H1, sections: [{ title: "x", documents: [] }] });
    assert.equal(reader.text, "You can't edit this handbook.");
    const stranger = await tool("nobody", "update_handbook_contents", { id: handbooks.H1, sections: [{ title: "x", documents: [] }] });
    assert.equal(stranger.isError, true);
    assert.match(stranger.text, /No handbook/);
    const w = (id: number, sections: unknown) => tool("wsAdmin", "update_handbook_contents", { id, sections });
    assert.equal((await w(handbooks.H2, [])).text, hb.HANDBOOK_SECTIONS_RANGE);
    assert.equal((await w(handbooks.H2, [{ title: " ", documents: [] }])).text, hb.HANDBOOK_SECTION_TITLE_REQUIRED);
    assert.equal((await w(handbooks.H2, [{ title: "A", documents: [docs.pA1, docs.pA1] }])).text, hb.HANDBOOK_DOC_IDS_INVALID);
    assert.equal((await w(handbooks.H2, [{ title: "A", documents: [docs.pAdraft] }])).text, hb.HANDBOOK_DOCS_INVALID);
    const bad = await tool("wsAdmin", "update_handbook_contents", { id: handbooks.H2, sections: [{ title: "A", documents: [] }], if_updated_at: "yesterday" });
    assert.equal(bad.text, hb.HANDBOOK_IF_UPDATED_AT_INVALID);
  });

  test("if_updated_at: a stale token answers 409 and saves nothing; a fresh one saves and returns the new token", async () => {
    const before = await tool("wsAdmin", "read_handbook", { id: handbooks.H2 });
    const token = before.out.updated_at;
    const stale = await tool("wsAdmin", "update_handbook_contents", {
      id: handbooks.H2,
      if_updated_at: "2001-01-01T00:00:00.000Z",
      sections: [{ title: "Renamed", documents: [docs.pA1, docs.pB1] }],
    });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /409/);
    assert.equal((await tool("wsAdmin", "read_handbook", { id: handbooks.H2 })).out.updated_at, token, "nothing written");

    const sectionId = before.out.sections[0].id;
    const saved = await tool("wsAdmin", "update_handbook_contents", {
      id: handbooks.H2,
      if_updated_at: token,
      sections: [
        { id: sectionId, title: "Renamed", documents: [docs.pB1] },
        { title: "New", documents: [docs.pA1] },
      ],
    });
    assert.equal(saved.isError, false, saved.text);
    assert.notEqual(saved.out.updated_at, token);
    assert.equal(saved.out.sections[0].id, sectionId, "a section sent with its id is kept");
    assert.deepEqual(saved.out.sections.map((s: any) => s.documents.map((d: any) => d.doc_id)), [[docs.pB1], [docs.pA1]]);
    assert.match(saved.out.note, /draft/);
    const rows = await auditRows("handbook.contents_changed", "handbook", handbooks.H2);
    const last = rows[rows.length - 1];
    assert.equal(last.details.via, "mcp");
    assert.equal(last.details.op, "replace");
    assert.equal(last.ip, CLIENT_IP);
    assert.deepEqual(last.details.added, [docs.pB1]);
    // The token it returned is the one to send next.
    const again = await tool("wsAdmin", "update_handbook_contents", {
      id: handbooks.H2,
      if_updated_at: saved.out.updated_at,
      sections: [{ id: sectionId, title: "Renamed", documents: [docs.pA1, docs.pB1] }],
    });
    assert.equal(again.isError, false, again.text);
  });

  test("a published handbook's change is live and says so; it stays published", async () => {
    const r = await tool("wsAdmin", "read_handbook", { id: handbooks.H1 });
    const [s1, s2] = r.out.sections;
    const saved = await tool("wsAdmin", "update_handbook_contents", {
      id: handbooks.H1,
      if_updated_at: r.out.updated_at,
      sections: [
        { id: s1.id, title: s1.title, documents: [docs.pA2, docs.pA1] },
        { id: s2.id, title: s2.title, documents: [docs.pB1] },
      ],
    });
    assert.equal(saved.isError, false, saved.text);
    assert.equal(saved.out.status, "published");
    assert.match(saved.out.note, /live/);
    const carol = await tool("carol", "read_handbook", { id: handbooks.H1 });
    assert.deepEqual(carol.out.sections[0].policies.map((p: any) => p.doc_id), [docs.pA2, docs.pA1]);
    assert.equal((await auditRows("handbook.published", "handbook", handbooks.H1)).length, 1, "only the fixture's publish");
  });

  test("a space-scoped editor keeps a placeholder by its id; find_mode needs Build handbooks on the document's space", async () => {
    const r = await tool("mgrA", "read_handbook", { id: handbooks.H3 });
    const sid = r.out.sections[0].id;
    // The placeholder sent back is kept, reordered like any other.
    const kept = await tool("mgrA", "update_handbook_contents", {
      id: handbooks.H3,
      if_updated_at: r.out.updated_at,
      sections: [{ id: sid, title: "Policies", documents: [docs.pB1, docs.pA1] }],
    });
    assert.equal(kept.isError, false, kept.text);
    const placeholder = kept.out.sections[0].documents[0];
    assert.equal(placeholder.doc_id, docs.pB1);
    assert.equal(placeholder.restricted, true);
    assert.equal(placeholder.title, hb.HANDBOOK_RESTRICTED_ITEM);
    assert.ok(!kept.text.includes("SECRET-pB1") && !kept.text.includes(`${STAMP} pB1`));

    // find_mode on B's document: refused, and nothing is saved.
    const deniedToken = kept.out.updated_at;
    const denied = await tool("mgrA", "update_handbook_contents", {
      id: handbooks.H3,
      sections: [{ id: sid, title: "Policies renamed", documents: [docs.pB1, docs.pA1] }],
      find_modes: [{ doc_id: docs.pB1, find_mode: "handbook_only" }],
    });
    assert.equal(denied.text, hb.HANDBOOK_FIND_MODE_DENIED);
    const after = await tool("mgrA", "read_handbook", { id: handbooks.H3 });
    assert.equal(after.out.updated_at, deniedToken, "the contents were not saved");
    assert.equal(after.out.sections[0].title, "Policies");
    const pB1 = await pool().query("SELECT find_mode FROM documents WHERE id = $1", [docs.pB1]);
    assert.equal(pB1.rows[0].find_mode, "space");

    // A document not in the handbook, or a bad mode, is refused too.
    const notIn = await tool("mgrA", "update_handbook_contents", {
      id: handbooks.H3,
      sections: [{ id: sid, title: "Policies", documents: [docs.pB1, docs.pA1] }],
      find_modes: [{ doc_id: docs.pA2, find_mode: "space" }],
    });
    assert.equal(notIn.isError, true);
    const badMode = await tool("mgrA", "update_handbook_contents", {
      id: handbooks.H3,
      sections: [{ id: sid, title: "Policies", documents: [docs.pB1, docs.pA1] }],
      find_modes: [{ doc_id: docs.pA1, find_mode: "hidden" }],
    });
    assert.equal(badMode.text, hb.HANDBOOK_FIND_MODE_INVALID);

    // On A's own document it is allowed, and audited as the item route audits it.
    const ok = await tool("mgrA", "update_handbook_contents", {
      id: handbooks.H3,
      sections: [{ id: sid, title: "Policies", documents: [docs.pB1, docs.pA1] }],
      find_modes: [{ doc_id: docs.pA1, find_mode: "handbook_only" }],
    });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.out.sections[0].documents.find((d: any) => d.doc_id === docs.pA1).find_mode, "handbook_only");
    const fm = await auditRows("handbook.find_mode_changed", "document", docs.pA1);
    assert.equal(fm.length, 1);
    assert.equal(fm[0].details.via, "mcp");
    assert.equal(fm[0].details.to, "handbook_only");
    assert.equal(fm[0].details.handbook_id, handbooks.H3);
    assert.equal(fm[0].ip, CLIENT_IP);
    await pool().query("UPDATE documents SET find_mode = 'space' WHERE id = $1", [docs.pA1]);

    // A document already found that way is left as it is, so B's needs no
    // permission when it is sent as it stands.
    const same = await tool("mgrA", "update_handbook_contents", {
      id: handbooks.H3,
      sections: [{ id: sid, title: "Policies", documents: [docs.pB1, docs.pA1] }],
      find_modes: [{ doc_id: docs.pB1, find_mode: "space" }],
    });
    assert.equal(same.isError, false, same.text);
    assert.equal((await auditRows("handbook.find_mode_changed", "document", docs.pB1)).length, 0);

    // Leaving the placeholder out removes it, as the REST save does.
    const removed = await tool("mgrA", "update_handbook_contents", {
      id: handbooks.H3,
      sections: [{ id: sid, title: "Policies", documents: [docs.pA1] }],
    });
    assert.equal(removed.isError, false, removed.text);
    assert.deepEqual(removed.out.sections[0].documents.map((d: any) => d.doc_id), [docs.pA1]);
    // mgrA can't add B's document back.
    const readd = await tool("mgrA", "update_handbook_contents", {
      id: handbooks.H3,
      sections: [{ id: sid, title: "Policies", documents: [docs.pA1, docs.pB1] }],
    });
    assert.equal(readd.text, hb.HANDBOOK_DOCS_INVALID);
  });
});

// --- The 1.18.2 review ------------------------------------------------------------------

describe("update_handbook_contents: find_modes in a batch", () => {
  const contentsOf = (out: any) =>
    out.sections.map((x: any) => ({ id: x.id, title: x.title, documents: x.policies.map((p: any) => p.doc_id) }));

  test("one entry per document: a repeat is one change, two modes for one document or more than 200 entries save nothing", async () => {
    const r = await tool("wsAdmin", "read_handbook", { id: handbooks.H2 });
    const sections = contentsOf(r.out);
    const token = r.out.updated_at;
    const twice = await tool("wsAdmin", "update_handbook_contents", {
      id: handbooks.H2,
      sections,
      find_modes: [
        { doc_id: docs.pB1, find_mode: "handbook_only" },
        { doc_id: docs.pB1, find_mode: "space" },
      ],
    });
    assert.equal(twice.isError, true);
    assert.ok(twice.text.startsWith(hb.HANDBOOK_FIND_MODE_TWICE), twice.text);
    const many = await tool("wsAdmin", "update_handbook_contents", {
      id: handbooks.H2,
      sections,
      find_modes: Array.from({ length: hb.HANDBOOK_ITEMS_MAX + 1 }, () => ({ doc_id: docs.pB1, find_mode: "handbook_only" })),
    });
    assert.equal(many.text, hb.HANDBOOK_FIND_MODES_RANGE);
    assert.equal((await tool("wsAdmin", "read_handbook", { id: handbooks.H2 })).out.updated_at, token, "nothing saved");

    try {
      const repeated = await tool("wsAdmin", "update_handbook_contents", {
        id: handbooks.H2,
        sections,
        find_modes: [
          { doc_id: docs.pB1, find_mode: "handbook_only" },
          { doc_id: docs.pB1, find_mode: "handbook_only" },
          { doc_id: docs.pA1, find_mode: "space" }, // already so: left alone
        ],
      });
      assert.equal(repeated.isError, false, repeated.text);
      const shown = repeated.out.sections.flatMap((x: any) => x.documents);
      assert.equal(shown.find((d: any) => d.doc_id === docs.pB1).find_mode, "handbook_only");
      const rowsFor = async (docId: number) =>
        (await auditRows("handbook.find_mode_changed", "document", docId)).filter((x) => x.details.handbook_id === handbooks.H2);
      const b1 = await rowsFor(docs.pB1);
      assert.equal(b1.length, 1, "one change, one audit row");
      assert.equal(b1[0].details.via, "mcp");
      assert.equal(b1[0].details.from, "space");
      assert.equal(b1[0].ip, CLIENT_IP);
      assert.equal((await rowsFor(docs.pA1)).length, 0, "an unchanged document is not audited");

      // Sent again as it now stands: nothing written, nothing audited.
      const again = await tool("wsAdmin", "update_handbook_contents", {
        id: handbooks.H2,
        sections,
        find_modes: [{ doc_id: docs.pB1, find_mode: "handbook_only" }],
      });
      assert.equal(again.isError, false, again.text);
      assert.equal((await rowsFor(docs.pB1)).length, 1);
    } finally {
      await pool().query("UPDATE documents SET find_mode = 'space' WHERE id = $1", [docs.pB1]);
    }
  });

  test("a find-mode write that fails after the contents save says what was saved and gives the new updated_at", async () => {
    const r = await tool("wsAdmin", "read_handbook", { id: handbooks.H2 });
    const sections = contentsOf(r.out);
    sections[0].title = "Renamed midway";
    const failed = await failingWhen(/SET find_mode = v\.mode/, () =>
      tool("wsAdmin", "update_handbook_contents", {
        id: handbooks.H2,
        if_updated_at: r.out.updated_at,
        sections,
        find_modes: [{ doc_id: docs.pB1, find_mode: "handbook_only" }],
      })
    );
    assert.equal(failed.isError, true);
    assert.match(failed.text, /The contents were saved/);
    assert.match(failed.text, /where people find its documents was not changed/);
    const after = await tool("wsAdmin", "read_handbook", { id: handbooks.H2 });
    assert.notEqual(after.out.updated_at, r.out.updated_at);
    assert.ok(failed.text.includes(after.out.updated_at), "the new token is in the answer");
    assert.equal(after.out.sections[0].title, "Renamed midway");
    const b1 = await pool().query("SELECT find_mode FROM documents WHERE id = $1", [docs.pB1]);
    assert.equal(b1.rows[0].find_mode, "space");
  });
});

describe("create_handbook: groups and a failed first save", () => {
  test("a groups value that is not a list is refused as POST /api/handbooks refuses it; a name two groups share needs the id; digits are an id", async () => {
    const notList = await tool("wsAdmin", "create_handbook", { title: `${STAMP} G1`, audience: "groups", groups: `${STAMP} GA` });
    assert.equal(notList.text, hb.HANDBOOK_GROUPS_INVALID);
    const t1 = (await createGroup({ name: `${STAMP} Twin` })).id;
    const t2 = (await createGroup({ name: `${STAMP} twin` })).id;
    extraGroups.push(t1, t2);
    const shared = await tool("wsAdmin", "create_handbook", { title: `${STAMP} G2`, audience: "groups", groups: [`${STAMP} TWIN`] });
    assert.equal(shared.isError, true);
    assert.match(shared.text, /More than one group is named/);
    assert.ok(shared.text.includes(String(t1)) && shared.text.includes(String(t2)));
    assert.deepEqual(await handbookIdsTitled(`${STAMP} G`), [], "nothing created");
    const byId = await tool("wsAdmin", "create_handbook", { title: `${STAMP} Gok`, audience: "groups", groups: [String(t2), t1] });
    assert.equal(byId.isError, false, byId.text);
    assert.deepEqual([...byId.out.groups].sort(), [`${STAMP} Twin`, `${STAMP} twin`].sort());
    const unknown = await tool("wsAdmin", "create_handbook", { title: `${STAMP} G3`, audience: "groups", groups: ["999999999"] });
    assert.match(unknown.text, /No group with id 999999999/);
  });

  test("when the contents fail to save after the draft is made, the draft is removed again (audited as a delete) and the error returned", async () => {
    const title = `${STAMP} Fails midway`;
    const r = await failingWhen(/INSERT INTO handbook_items/, () =>
      tool("wsAdmin", "create_handbook", { title, sections: [{ title: "One", documents: [docs.pA1] }] })
    );
    assert.equal(r.isError, true);
    assert.match(r.text, /Nothing was created/);
    assert.deepEqual(await handbookIdsTitled(title), []);
    const created = await pool().query<{ target_id: string }>(
      "SELECT target_id FROM audit_log WHERE action = 'handbook.created' AND target_label = $1",
      [title]
    );
    assert.equal(created.rowCount, 1);
    const deleted = await auditRows("handbook.deleted", "handbook", Number(created.rows[0].target_id));
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].details.via, "mcp");
    assert.equal(deleted[0].ip, CLIENT_IP);
  });
});

describe("the reads cost the same whatever a handbook list or a handbook holds", () => {
  test("list_handbooks makes no query per handbook, and your progress is unchanged", async () => {
    const admin = as("wsAdmin");
    const extra: number[] = [];
    await tool("carol", "list_handbooks"); // warm
    const before = await queriesOf(() => tool("carol", "list_handbooks"));
    for (const n of [1, 2, 3]) {
      const h = await hb.createHandbook(admin, {
        title: `${STAMP} Extra ${n}`,
        space_id: null,
        introduction: "",
        audience: "groups",
        group_ids: [gR],
        confirm_whole: true,
        require_signature: false,
      });
      await hb.setHandbookContents(admin, h.id, { sections: [{ id: h.sections[0].id, title: "One", doc_ids: [docs.pA1, docs.pB1] }] });
      await hb.publishHandbook(admin, h.id, true);
      extra.push(h.id);
    }
    const after = await queriesOf(() => tool("carol", "list_handbooks"));
    const listed = after.result.out.handbooks.filter((h: any) => extra.includes(h.id));
    assert.equal(listed.length, 3);
    assert.ok(after.texts.length <= before.texts.length, `${after.texts.length} queries for 3 more handbooks, ${before.texts.length} before`);
    // carol confirmed pA1 earlier (handbook_status): her progress is over the reader view's documents.
    for (const h of listed) assert.deepEqual(h.your_progress, { confirmed: 1, of: 1 });
  });

  test("read_handbook reads the documents in one query, and an outline never selects their text", async () => {
    const admin = as("wsAdmin");
    const h = await hb.createHandbook(admin, {
      title: `${STAMP} One doc`,
      space_id: null,
      introduction: "",
      audience: "groups",
      group_ids: [gR],
      confirm_whole: false,
      require_signature: false,
    });
    await hb.setHandbookContents(admin, h.id, { sections: [{ id: h.sections[0].id, title: "One", doc_ids: [docs.pB1] }] });
    await hb.publishHandbook(admin, h.id, true);
    await tool("carol", "read_handbook", { id: h.id }); // warm
    const one = await queriesOf(() => tool("carol", "read_handbook", { id: h.id }));
    const three = await queriesOf(() => tool("carol", "read_handbook", { id: handbooks.H1 }));
    assert.equal(three.result.out.sections.flatMap((x: any) => x.policies).length, 3);
    assert.equal(three.texts.length, one.texts.length, "three documents cost what one does");
    const docReads = (texts: string[], re: RegExp) => texts.filter((t) => re.test(t)).length;
    assert.equal(docReads(three.texts, /SELECT id, status, review_due_at, content\s+FROM documents/), 1);
    const outline = await queriesOf(() => tool("carol", "read_handbook", { id: handbooks.H1, include_text: false }));
    assert.equal(docReads(outline.texts, /SELECT id, status, review_due_at\s+FROM documents/), 1);
    assert.equal(docReads(outline.texts, /review_due_at, content/), 0, "an outline selects no text");
    const p = outline.result.out.sections.flatMap((x: any) => x.policies);
    assert.ok(p.every((x: any) => x.text === undefined && "next_review" in x.facts));
  });
});
