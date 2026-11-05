// "Where people find it" (Handbooks 1.18.0, H6): a handbook-only document
// stays out of every listing an ordinary reader sees, stays in for the
// people who look after its space, and is treated as 'space' everywhere
// while no PUBLISHED handbook holds it (no orphans). The filter is one SQL
// fragment (lib/handbook-visibility); these pin it at each listing that
// applies it, plus the policy page's facts (lib/policy-facts). Every
// negative check has its positive twin (an editor of the space, or a
// caller that sees everything, finds the document there), so none passes
// just because the document was never in the list.
//
// No administrator account: one would join every private-space policy
// audience in the shared database and disturb other files' exact counts.
// The person who sees everything is a "steward", a viewer holding a custom
// role with space.author_all alone (what makes findScopeFor answer "all"
// for an administrator), which reads no private space.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/handbook-visibility.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  getSetting,
  listDocumentsBySpace,
  listDocumentsV1,
  listRecentDocuments,
  listPopularDocuments,
  listRecentlyViewedBy,
  listDocumentsByAuthor,
  searchDocuments,
  retrieveForAnswer,
  listSpaces,
  listPublicSpaces,
  allTags,
  createRole,
  assignRole,
  deleteRole,
} from "../src/lib/db";
import { listLatestDocuments, listPopularThisWeek } from "../src/lib/dashboard-data";
import { backlinksFor } from "../src/lib/backlinks";
import { relationsFor, addRelation } from "../src/lib/relations";
import { childrenOf } from "../src/lib/doc-tree";
import { asScope } from "../src/lib/space-scope";
import {
  FIND_ANONYMOUS,
  FIND_EVERYTHING,
  findScopeAllows,
  findScopeFor,
  handbookFilterSql,
  handbookOnlyMarks,
  isEffectivelyHandbookOnly,
  keepWhoFind,
} from "../src/lib/handbook-visibility";
import type { FindScope } from "../src/lib/handbook-visibility";
import { getPolicyFacts, policyFactsChanges, setPolicyFacts } from "../src/lib/policy-facts";
import { fixtureQuery } from "./support/retry";

const STAMP = `hbvis${Date.now()}`;
// A word only these fixtures contain, so search hits are ours alone.
const WORD = `zq${STAMP}`;
const AUTHOR = `Author ${STAMP}`;

let spaceId = 0;
let otherSpaceId = 0;
let published = 0; // a published handbook holding `hidden`
let draftBook = 0; // a draft handbook holding `orphan`
const doc = { hidden: 0, orphan: 0, listed: 0 };
const users = { reader: 0, editor: 0, steward: 0 };
const userIds: number[] = [];
let stewardRole = 0;
/** lib/dashboard-data's POPULAR_POOL: how many of the week's most-read documents the shared Popular cache keeps. */
const POPULAR_POOL = 500;

/** The reader's find scope (no space they look after), and an editor's of our space, minted as the resolver would. */
const READER = FIND_ANONYMOUS;
const mint = (s: "all" | number[]) => s as FindScope;

async function newDoc(title: string, findMode: "space" | "handbook_only", space = spaceId): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO documents (space_id, title, slug, type, status, content, summary, author, find_mode)
     VALUES ($1, $2, $3, 'policy', 'published', $4, '', $5, $6) RETURNING id`,
    [space, `${STAMP} ${title}`, `${STAMP}-${title.toLowerCase().replace(/\W+/g, "-")}`, `${WORD} body of ${title}`, AUTHOR, findMode]
  );
  return r.rows[0].id;
}

async function newHandbook(title: string, status: "draft" | "published", docIds: number[]): Promise<number> {
  const hb = await fixtureQuery(`INSERT INTO handbooks (title, status) VALUES ($1, $2) RETURNING id`, [`${STAMP} ${title}`, status]);
  const id = hb.rows[0].id;
  const sec = await fixtureQuery(`INSERT INTO handbook_sections (handbook_id, title) VALUES ($1, 'Section') RETURNING id`, [id]);
  for (const [i, d] of docIds.entries()) {
    await fixtureQuery(
      `INSERT INTO handbook_items (handbook_id, section_id, document_id, position) VALUES ($1, $2, $3, $4)`,
      [id, sec.rows[0].id, d, i]
    );
  }
  return id;
}

async function newUser(tag: keyof typeof users, role: string): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [`${STAMP}-${tag}`, `${tag} ${STAMP}`, `${STAMP}-${tag}@example.test`, role]
  );
  users[tag] = r.rows[0].id;
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

const ids = (rows: { id: number }[]) => new Set(rows.map((r) => r.id));
const ours = (rows: { id: number }[]) => [...ids(rows)].filter((id) => Object.values(doc).includes(id)).sort((a, b) => a - b);
const sorted = (...xs: number[]) => [...xs].sort((a, b) => a - b);

describe("handbook visibility", () => {
  before(async () => {
    await getSetting("__schema_bootstrap__"); // boots the schema, Handbooks block included
    const sp = await fixtureQuery(
      `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
      [`HB Vis ${STAMP}`, STAMP]
    );
    spaceId = sp.rows[0].id;
    const sp2 = await fixtureQuery(
      `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
      [`HB Vis Other ${STAMP}`, `${STAMP}-other`]
    );
    otherSpaceId = sp2.rows[0].id;
    doc.hidden = await newDoc("Paid Time Off", "handbook_only");
    doc.orphan = await newDoc("Remote Work", "handbook_only");
    doc.listed = await newDoc("Code of Conduct", "space");
    published = await newHandbook("Employee Handbook", "published", [doc.hidden, doc.listed]);
    draftBook = await newHandbook("Draft Handbook", "draft", [doc.orphan]);
    await newUser("reader", "viewer");
    await newUser("editor", "editor");
    await newUser("steward", "viewer");
    const role = await createRole({ name: `${STAMP} Steward`, permissions: ["space.author_all"] });
    assert.ok("id" in role, "custom role created");
    stewardRole = role.id;
    await assignRole({ roleId: stewardRole, userId: users.steward });
    // Views for Popular and Continue: the reader opened all three.
    for (const d of Object.values(doc)) {
      await fixtureQuery(`INSERT INTO doc_views (document_id, user_id) VALUES ($1, $2)`, [d, users.reader]);
    }
  });

  after(async () => {
    const docIds = Object.values(doc).filter(Boolean);
    await pool().query(`DELETE FROM handbooks WHERE id = ANY($1::int[])`, [[published, draftBook]]);
    await pool().query(`DELETE FROM doc_views WHERE document_id = ANY($1::int[])`, [docIds]);
    await pool().query(`DELETE FROM documents WHERE id = ANY($1::int[])`, [docIds]);
    await pool().query(`DELETE FROM spaces WHERE id = ANY($1::int[])`, [[spaceId, otherSpaceId]]);
    await pool().query(`DELETE FROM role_assignments WHERE role_id = $1`, [stewardRole]);
    if (stewardRole) await deleteRole(stewardRole);
    await pool().query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  });

  test("the fragment: no clause without a find scope or for one that sees everything", () => {
    const params: unknown[] = [];
    assert.equal(handbookFilterSql("d", undefined, params), "");
    assert.equal(handbookFilterSql("d", FIND_EVERYTHING, params), "");
    assert.equal(params.length, 0, "nothing bound when nothing can be hidden");
    const clause = handbookFilterSql("d", READER, params);
    assert.match(clause, /^ AND NOT /);
    assert.match(clause, /\$1::int\[\]/);
    assert.deepEqual(params, [[]]);
    assert.equal(findScopeAllows(mint([spaceId]), spaceId), true);
    assert.equal(findScopeAllows(READER, spaceId), false);
  });

  test("the space page: a reader misses the handbook-only document, an editor of the space and an unfiltered caller see all three", async () => {
    assert.deepEqual(ours(await listDocumentsBySpace(spaceId, false, READER)), sorted(doc.orphan, doc.listed));
    assert.deepEqual(ours(await listDocumentsBySpace(spaceId, false, mint([spaceId]))), sorted(...Object.values(doc)));
    assert.deepEqual(ours(await listDocumentsBySpace(spaceId, false)), sorted(...Object.values(doc)));
    // Looking after ANOTHER space does not reveal this one's.
    assert.deepEqual(ours(await listDocumentsBySpace(spaceId, false, mint([otherSpaceId]))), sorted(doc.orphan, doc.listed));
  });

  test("no orphans: the document comes back the moment no published handbook holds it, and goes again on republish", async () => {
    assert.equal(await isEffectivelyHandbookOnly(doc.hidden), true);
    assert.equal(await isEffectivelyHandbookOnly(doc.orphan), false, "only a draft handbook holds it");
    assert.equal(await isEffectivelyHandbookOnly(doc.listed), false, "stored 'space'");
    await pool().query(`UPDATE handbooks SET status = 'draft' WHERE id = $1`, [published]);
    try {
      assert.equal(await isEffectivelyHandbookOnly(doc.hidden), false);
      assert.ok(ids(await listDocumentsBySpace(spaceId, false, READER)).has(doc.hidden));
    } finally {
      await pool().query(`UPDATE handbooks SET status = 'published' WHERE id = $1`, [published]);
    }
    assert.ok(!ids(await listDocumentsBySpace(spaceId, false, READER)).has(doc.hidden));
    // Publishing the draft handbook makes the orphan handbook-only too.
    await pool().query(`UPDATE handbooks SET status = 'published' WHERE id = $1`, [draftBook]);
    try {
      assert.deepEqual(ours(await listDocumentsBySpace(spaceId, false, READER)), [doc.listed]);
    } finally {
      await pool().query(`UPDATE handbooks SET status = 'draft' WHERE id = $1`, [draftBook]);
    }
  });

  test("dashboard and palette lists: Latest, Popular and Continue leave it out for a reader", async () => {
    const scope = asScope([spaceId]);
    assert.deepEqual(ours(await listRecentDocuments(50, false, scope, READER)), sorted(doc.orphan, doc.listed));
    assert.deepEqual(ours(await listRecentDocuments(50, false, scope, mint([spaceId]))), sorted(...Object.values(doc)));
    assert.deepEqual(ours(await listPopularDocuments(scope, false, 50, READER)), sorted(doc.orphan, doc.listed));
    assert.deepEqual(ours(await listRecentlyViewedBy(users.reader, scope, false, 50, READER)), sorted(doc.orphan, doc.listed));
    assert.deepEqual(ours(await listRecentlyViewedBy(users.reader, scope, false, 50)), sorted(...Object.values(doc)));
    // Unscoped ("all") callers bind the find parameter at the next position.
    assert.ok(!ids(await listRecentDocuments(500, false, asScope("all"), READER)).has(doc.hidden));
    assert.ok(ids(await listRecentDocuments(500, false, asScope("all"), mint([spaceId]))).has(doc.hidden), "the space's editor finds it there");
    assert.ok(ids(await listRecentDocuments(500, false, asScope("all"), FIND_EVERYTHING)).has(doc.hidden), "so does a caller that sees everything");
  });

  test("the 1.17.0 dashboard tiles: Latest and Popular this week leave it out for a reader, keep it for an editor", async () => {
    const scope = asScope([spaceId]);
    const reader = await findScopeFor({ id: users.reader, role: "viewer" });
    const editor = await findScopeFor({ id: users.editor, role: "editor" });
    // Latest in your spaces.
    assert.deepEqual(ours(await listLatestDocuments({ scope, includeDrafts: false, limit: 50, find: reader })), sorted(doc.orphan, doc.listed));
    assert.deepEqual(ours(await listLatestDocuments({ scope, includeDrafts: false, limit: 50, find: editor })), sorted(...Object.values(doc)));
    assert.deepEqual(ours(await listLatestDocuments({ scope, includeDrafts: false, limit: 50 })), sorted(...Object.values(doc)));
    // The find parameter binds after the Following and exclude lists, before the limit.
    assert.deepEqual(
      ours(await listLatestDocuments({ scope: asScope("all"), includeDrafts: false, spaceIds: [spaceId], excludeIds: [doc.listed], limit: 50, find: reader })),
      [doc.orphan]
    );
    // Popular this week: the cache keeps the week's POPULAR_POOL most-read
    // documents, everyone's, and the filter is the viewer's, so one cached
    // copy serves every call below. Our three need to be in it, and no more
    // than that: each already has one view (before), which is enough while
    // the pool is not full; on a database with a full pool they get just
    // past its last document's count. Never a fixed pile of views, which
    // would push other files' documents (test/dashboard-data.test.ts's)
    // out of the pool their own processes cache.
    const cutoff = await pool().query<{ views: number }>(
      `SELECT COUNT(*)::int AS views FROM doc_views WHERE viewed_at > now() - interval '7 days'
        GROUP BY document_id ORDER BY COUNT(*) DESC OFFSET $1 LIMIT 1`,
      [POPULAR_POOL - 1]
    );
    const extra = cutoff.rows[0] ? cutoff.rows[0].views : 0; // one view each already; reach cutoff + 1
    if (extra > 0) {
      await pool().query(
        `INSERT INTO doc_views (document_id, user_id) SELECT d, $2 FROM unnest($1::int[]) AS d, generate_series(1, $3::int)`,
        [Object.values(doc), users.reader, extra]
      );
    }
    assert.deepEqual(ours(await listPopularThisWeek(scope, false, 50, reader)), sorted(doc.orphan, doc.listed));
    assert.deepEqual(ours(await listPopularThisWeek(scope, false, 50, editor)), sorted(...Object.values(doc)));
    assert.deepEqual(ours(await listPopularThisWeek(scope, false, 50)), sorted(...Object.values(doc)));
    assert.ok(!ids(await listPopularThisWeek(asScope("all"), false, POPULAR_POOL, READER)).has(doc.hidden));
    assert.ok(ids(await listPopularThisWeek(asScope("all"), false, POPULAR_POOL, mint([spaceId]))).has(doc.hidden), "the space's editor finds it there");
    assert.ok(ids(await listPopularThisWeek(asScope("all"), false, POPULAR_POOL, FIND_EVERYTHING)).has(doc.hidden), "so does a caller that sees everything");
  });

  test("the API listing: total and the page agree with the filter", async () => {
    const reader = await listDocumentsV1({ scope: asScope([spaceId]), includeDrafts: false, limit: 1, offset: 0, find: READER });
    assert.equal(reader.total, 2);
    assert.equal(reader.items.length, 1);
    const editor = await listDocumentsV1({ scope: asScope([spaceId]), includeDrafts: false, limit: 10, offset: 0, find: mint([spaceId]) });
    assert.equal(editor.total, 3);
  });

  test("search: keyword, operator-only browse and Ask retrieval", async () => {
    const scope = asScope([spaceId]);
    assert.deepEqual(ours(await searchDocuments(WORD, 50, false, scope, undefined, undefined, READER)), sorted(doc.orphan, doc.listed));
    assert.deepEqual(ours(await searchDocuments(WORD, 50, false, scope, undefined, undefined, mint("all"))), sorted(...Object.values(doc)));
    // "type:policy" with no words browses by recency through the same filter.
    assert.deepEqual(
      ours(await searchDocuments("", 50, false, scope, spaceId, { type: "policy" }, READER)),
      sorted(doc.orphan, doc.listed)
    );
    assert.deepEqual(ours(await retrieveForAnswer(WORD, 50, false, scope, READER)), sorted(doc.orphan, doc.listed));
    assert.deepEqual(ours(await retrieveForAnswer(WORD, 50, false, scope)), sorted(...Object.values(doc)));
  });

  test("a person's documents in the directory", async () => {
    assert.deepEqual(ours(await listDocumentsByAuthor(AUTHOR, false, asScope([spaceId]), READER)), sorted(doc.orphan, doc.listed));
  });

  test("the resolver: readers hide, editors of the space and whoever authors everywhere see", async () => {
    const reader = await findScopeFor({ id: users.reader, role: "viewer" });
    const editor = await findScopeFor({ id: users.editor, role: "editor" });
    const steward = await findScopeFor({ id: users.steward, role: "viewer" });
    assert.equal(findScopeAllows(reader, spaceId), false);
    assert.equal(findScopeAllows(editor, spaceId), true, "editors author in every internal space by default");
    assert.equal(findScopeAllows(editor, otherSpaceId), true);
    assert.equal(steward, "all", "space.author_all (the Administrator preset's bypass) sees everything");
  });

  test("the space page's marks: the handbook-only document with the published handbook it is read in", async () => {
    const marks = await handbookOnlyMarks(Object.values(doc));
    assert.deepEqual([...marks.keys()], [doc.hidden]);
    assert.deepEqual(marks.get(doc.hidden)?.handbooks, [{ id: published, title: `${STAMP} Employee Handbook` }]);
  });

  test("space subscribers: only those who still see a handbook-only document hear about it", async () => {
    const all = [{ id: users.reader }, { id: users.editor }, { id: users.steward }];
    assert.deepEqual(
      (await keepWhoFind(doc.hidden, spaceId, all)).map((p) => p.id),
      [users.editor, users.steward]
    );
    assert.deepEqual(await keepWhoFind(doc.listed, spaceId, all), all);
    assert.deepEqual(await keepWhoFind(doc.orphan, spaceId, all), all, "an orphan is news to everyone");
  });

  test("policy facts: changes are detected field by field and round-trip", async () => {
    const current = { summary_points: ["a", "b"], applies_to: "All staff" };
    assert.deepEqual(policyFactsChanges(current, { summary_points: ["a", "b"], applies_to: "All staff" }), {});
    assert.deepEqual(policyFactsChanges(current, { summary_points: ["b", "a"] }), { summary_points: ["b", "a"] });
    assert.deepEqual(policyFactsChanges(current, { applies_to: "Managers" }), { applies_to: "Managers" });
    await setPolicyFacts(doc.listed, { summary_points: ["You get 25 days", "Ask two weeks ahead"], applies_to: "All employees" });
    assert.deepEqual(await getPolicyFacts(doc.listed), {
      summary_points: ["You get 25 days", "Ask two weeks ahead"],
      applies_to: "All employees",
    });
    await setPolicyFacts(doc.listed, { summary_points: [] });
    assert.deepEqual(await getPolicyFacts(doc.listed), { summary_points: [], applies_to: "All employees" });
  });

  // --- Leftovers (1.18.0 integration): counts and the document page's own lists ---

  test("space counts: listSpaces and the public landing leave the handbook-only document out of doc_count", async () => {
    const count = async (find?: FindScope) => (await listSpaces(asScope([spaceId]), find)).find((x) => x.id === spaceId)!.doc_count;
    assert.equal(await count(), 3, "unfiltered: all three");
    assert.equal(await count(READER), 2, "a reader's count: the space page's two");
    assert.equal(await count(mint([spaceId])), 3, "an editor of the space counts it");
    // The public landing counts as the anonymous reader sees.
    await pool().query(`UPDATE spaces SET visibility = 'public' WHERE id = $1`, [spaceId]);
    try {
      assert.equal((await listPublicSpaces()).find((x) => x.id === spaceId)?.doc_count, 2);
    } finally {
      await pool().query(`UPDATE spaces SET visibility = 'internal' WHERE id = $1`, [spaceId]);
    }
    // No orphans: once no published handbook holds it, it counts again.
    await pool().query(`UPDATE handbooks SET status = 'draft' WHERE id = $1`, [published]);
    try {
      assert.equal(await count(READER), 3);
    } finally {
      await pool().query(`UPDATE handbooks SET status = 'published' WHERE id = $1`, [published]);
    }
  });

  test("tag counts leave it out for a reader", async () => {
    const TAG = `tag-${STAMP}`;
    await pool().query(`UPDATE documents SET tags = $2 WHERE id = ANY($1::int[])`, [[doc.hidden, doc.listed], TAG]);
    try {
      const n = async (find?: FindScope) => (await allTags(find)).find((t) => t.tag === TAG)?.count ?? 0;
      assert.equal(await n(), 2);
      assert.equal(await n(READER), 1);
      assert.equal(await n(mint([spaceId])), 2);
    } finally {
      await pool().query(`UPDATE documents SET tags = '' WHERE id = ANY($1::int[])`, [[doc.hidden, doc.listed]]);
    }
  });

  test("the document page's lists: related documents, sub-pages and \"Linked from\" leave it out for a reader", async () => {
    const scope = asScope([spaceId]);
    await addRelation(doc.listed, doc.hidden, "related", users.editor);
    await addRelation(doc.listed, doc.orphan, "related", users.editor);
    await pool().query(`INSERT INTO doc_links (from_id, to_id) VALUES ($1, $3), ($2, $3) ON CONFLICT DO NOTHING`, [doc.hidden, doc.orphan, doc.listed]);
    await pool().query(`UPDATE documents SET parent_id = $1 WHERE id = ANY($2::int[])`, [doc.listed, [doc.hidden, doc.orphan]]);
    try {
      assert.deepEqual(ours(await relationsFor(doc.listed, scope, false, READER)), [doc.orphan]);
      assert.deepEqual(ours(await relationsFor(doc.listed, scope, false, mint([spaceId]))), sorted(doc.hidden, doc.orphan));
      assert.deepEqual(ours(await relationsFor(doc.listed, scope, false)), sorted(doc.hidden, doc.orphan));
      assert.deepEqual(ours(await backlinksFor(doc.listed, [spaceId], false, READER)), [doc.orphan]);
      assert.deepEqual(ours(await backlinksFor(doc.listed, [spaceId], false, mint([spaceId]))), sorted(doc.hidden, doc.orphan));
      assert.deepEqual(ours(await childrenOf(doc.listed, { includeDrafts: false, find: READER })), [doc.orphan]);
      assert.deepEqual(ours(await childrenOf(doc.listed, { includeDrafts: false })), sorted(doc.hidden, doc.orphan));
    } finally {
      await pool().query(`UPDATE documents SET parent_id = NULL WHERE id = ANY($1::int[])`, [[doc.hidden, doc.orphan]]);
      await pool().query(`DELETE FROM doc_links WHERE to_id = $1`, [doc.listed]);
      await pool().query(`DELETE FROM doc_relations WHERE doc_id = $1 OR target_id = $1`, [doc.listed]);
    }
  });
});
