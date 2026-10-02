// The Trash is paged and searched by the server (1.8.2): limit, offset and
// total must agree, and the filter must match title or space name.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, listTrashedDocuments } from "../src/lib/db";

const STAMP = `trash-paging-${Date.now()}`;
let spaceId = 0;
const ids: number[] = [];

describe("trash paging", () => {
  before(async () => {
    const sp = await pool().query(
      `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
      [`Trash Paging ${STAMP}`, STAMP]
    );
    spaceId = sp.rows[0].id;
    for (let i = 0; i < 7; i++) {
      const r = await pool().query(
        `INSERT INTO documents (space_id, title, slug, type, status, content, author, deleted_at)
         VALUES ($1, $2, $3, 'knowledge', 'published', 'body', 'test', NOW() - ($4 || ' minutes')::interval) RETURNING id`,
        [spaceId, `${STAMP} doc ${i}`, `${STAMP}-${i}`, String(i)]
      );
      ids.push(r.rows[0].id);
    }
  });

  after(async () => {
    await pool().query(`DELETE FROM documents WHERE id = ANY($1)`, [ids]);
    await pool().query(`DELETE FROM spaces WHERE id = $1`, [spaceId]);
  });

  test("limit and offset page through the matches and total counts them all", async () => {
    const first = await listTrashedDocuments({ q: STAMP, limit: 3, offset: 0 });
    assert.equal(first.total, 7);
    assert.equal(first.rows.length, 3);
    assert.equal(first.rows[0].title, `${STAMP} doc 0`, "newest deletion first");
    const last = await listTrashedDocuments({ q: STAMP, limit: 3, offset: 6 });
    assert.equal(last.rows.length, 1);
    assert.equal(last.rows[0].title, `${STAMP} doc 6`);
  });

  test("the filter matches the space name too, and rows carry no body", async () => {
    const bySpace = await listTrashedDocuments({ q: `Trash Paging ${STAMP}`, limit: 50 });
    assert.equal(bySpace.total, 7);
    assert.ok(!("content" in bySpace.rows[0]), "no document body is loaded for the list");
    const none = await listTrashedDocuments({ q: `${STAMP}-nothing`, limit: 50 });
    assert.equal(none.total, 0);
    assert.equal(none.rows.length, 0);
  });
});
