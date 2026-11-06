// A policy's audience reconcile must not fail when an account is removed
// while it runs. The INSERT ... SELECT reads its audience from a snapshot
// taken before the removal commits; without a key-share lock on the users
// it picks, the foreign key check then fails with 23503 and the whole
// switch-on (or group sync, or space change) throws. With the lock the
// insert waits for the removal and skips the removed account.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-reconcile-race.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, createDocument, setAckRequired, reconcilePoliciesForUser } from "../src/lib/db";

const STAMP = `ackrace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let spaceId = 0;
const docIds: number[] = [];
const userIds: number[] = [];

async function member(tag: string): Promise<number> {
  const u = await pool().query<{ id: number }>(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP}-${tag}`, `Race ${tag}`, `${STAMP}-${tag}@example.test`]
  );
  const id = u.rows[0].id;
  userIds.push(id);
  await pool().query(
    `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
     SELECT r.id, $1, 'space', $2 FROM roles r WHERE r.key = 'space-member'`,
    [id, spaceId]
  );
  return id;
}

async function policy(title: string): Promise<number> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content: `${title}: staff must follow the procedure described here.`,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  return doc.id;
}

/** Hold an uncommitted removal of `userId` while `run` starts, then commit it. */
async function removeWhile<T>(userId: number, run: () => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    await c.query("DELETE FROM users WHERE id = $1", [userId]);
    const pending = run();
    // Let the reconcile reach its insert and wait on the removed row.
    await new Promise((r) => setTimeout(r, 400));
    await c.query("COMMIT");
    return await pending;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

before(async () => {
  const s = await pool().query<{ id: number }>(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id`,
    [`Ack race ${STAMP}`, STAMP]
  );
  spaceId = s.rows[0].id;
});

after(async () => {
  if (docIds.length) await pool().query("DELETE FROM documents WHERE id = ANY($1::int[])", [docIds]);
  if (userIds.length) await pool().query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]);
  if (spaceId) await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
  await pool().end();
});

test("switching a policy on while a member's account is removed enrols the others and skips the removed one", async () => {
  const stays = await member("stays");
  const leaves = await member("leaves");
  const docId = await policy(`Race policy ${STAMP}`);

  await removeWhile(leaves, () => setAckRequired(docId, true, { editDefault: null, recertMonths: null }));

  const rows = await pool().query<{ user_id: number }>(
    "SELECT user_id FROM policy_assignments WHERE document_id = $1 AND removed_at IS NULL ORDER BY user_id",
    [docId]
  );
  const ids = rows.rows.map((r) => Number(r.user_id));
  assert.ok(ids.includes(stays), "the member who stays is enrolled");
  assert.ok(!ids.includes(leaves), "the removed account has no row");
});

test("enrolling one account that is removed at the same moment does not throw", async () => {
  const leaves = await member("joiner");
  await policy(`Race joiner policy ${STAMP}`);
  // The policy is on, so the joiner path would enrol them.
  await setAckRequired(docIds[docIds.length - 1], true, { editDefault: null, recertMonths: null });
  await pool().query("DELETE FROM policy_assignments WHERE user_id = $1", [leaves]);

  await removeWhile(leaves, () => reconcilePoliciesForUser(leaves));

  const rows = await pool().query("SELECT 1 FROM policy_assignments WHERE user_id = $1", [leaves]);
  assert.equal(rows.rowCount, 0, "nothing is written for an account that no longer exists");
});
