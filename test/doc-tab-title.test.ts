// /doc/[id]'s browser-tab title (1.19.0): generateMetadata names the
// document only for a reader who may open it (lib/page-data
// documentTabTitle), by the page's own checks: a private space's document
// and a draft are not named to someone who tries the id; they get the same
// neutral title as an id with no document behind it.
//
// Parallel-safe: this file's own spaces, group, people and documents
// (stamped), removed after.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/doc-tab-title.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { pool, getSetting, createDocument, createGroup, setGroupMembers, setSpaceGroups } from "../src/lib/db";
import { documentTabTitle } from "../src/lib/page-data";
import { fixtureQuery } from "./support/retry";
import type { Role } from "../src/lib/types";

const STAMP = `doctab-${Date.now()}-${randomBytes(3).toString("hex")}`;
const ids: { privateSpace: number; openSpace: number; group: number; privateDoc: number; draftDoc: number; openDoc: number } = {
  privateSpace: 0,
  openSpace: 0,
  group: 0,
  privateDoc: 0,
  draftDoc: 0,
  openDoc: 0,
};
const people: Record<"member" | "outsider" | "editor", { id: number; role: Role }> = {
  member: { id: 0, role: "viewer" },
  outsider: { id: 0, role: "viewer" },
  editor: { id: 0, role: "editor" },
};

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private'), ($3, $4, '📁', '', 'internal') RETURNING id`,
    [`Doc tab private ${STAMP}`, `${STAMP}-p`, `Doc tab open ${STAMP}`, `${STAMP}-o`]
  );
  ids.privateSpace = sp.rows[0].id;
  ids.openSpace = sp.rows[1].id;
  const u = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Member', $2, 'viewer', 'active'), ($3, 'Outsider', $4, 'viewer', 'active'), ($5, 'Editor', $6, 'editor', 'active')
     RETURNING id`,
    [`${STAMP}-m`, `${STAMP}-m@example.test`, `${STAMP}-x`, `${STAMP}-x@example.test`, `${STAMP}-e`, `${STAMP}-e@example.test`]
  );
  people.member.id = u.rows[0].id;
  people.outsider.id = u.rows[1].id;
  people.editor.id = u.rows[2].id;
  ids.group = (await createGroup({ name: `${STAMP} members` })).id;
  await setGroupMembers(ids.group, [people.member.id]);
  await setSpaceGroups(ids.privateSpace, [ids.group]);
  const doc = (space_id: number, title: string, status: "published" | "draft") =>
    createDocument({ space_id, title, type: "doc" as never, status, content: "Body", summary: "", tags: [], author: "Test" });
  ids.privateDoc = (await doc(ids.privateSpace, `Secret plans ${STAMP}`, "published")).id;
  ids.draftDoc = (await doc(ids.openSpace, `Unannounced draft ${STAMP}`, "draft")).id;
  ids.openDoc = (await doc(ids.openSpace, `Open guide ${STAMP}`, "published")).id;
});

after(async () => {
  await pool().query("DELETE FROM documents WHERE space_id = ANY($1)", [[ids.privateSpace, ids.openSpace]]);
  await pool().query("DELETE FROM groups WHERE id = $1", [ids.group]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [Object.values(people).map((p) => p.id)]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [[ids.privateSpace, ids.openSpace]]);
});

test("a private space's document is named only to its members", async () => {
  assert.equal(await documentTabTitle(ids.privateDoc, people.member), `Secret plans ${STAMP}`);
  assert.equal(await documentTabTitle(ids.privateDoc, people.outsider), null);
});

test("a draft is named only to those who see drafts", async () => {
  assert.equal(await documentTabTitle(ids.draftDoc, people.outsider), null);
  assert.equal(await documentTabTitle(ids.draftDoc, people.editor), `Unannounced draft ${STAMP}`);
});

test("a published document in an open space is named; no reader, a missing id or garbage is not", async () => {
  assert.equal(await documentTabTitle(ids.openDoc, people.outsider), `Open guide ${STAMP}`);
  assert.equal(await documentTabTitle(ids.openDoc, null), null);
  assert.equal(await documentTabTitle(2 ** 30, people.member), null);
  assert.equal(await documentTabTitle(Number("abc"), people.member), null);
});
