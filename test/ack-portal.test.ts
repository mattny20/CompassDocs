// The compliance portal's numbers (1.13.0): complianceDocs carries the
// overdue count (E1: an open row past its due date and the grace with no
// current confirmation), the policy's deadline rule with the days the
// cascade settles on, and the people enrolled this week (D1: open rows
// assigned in the last seven days); complianceUserSummary the overdue count
// per person. The grace comes from the space's policy_defaults (the
// workspace layer is shared with other test files and left alone here).
// An overdue row needs a backdated deadline, which no route offers, so the
// rows are moved by SQL the way the exemptions tests move them.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-portal.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  getSetting,
  createDocument,
  setAckRequired,
  recordAcknowledgement,
  listVersions,
  complianceDocs,
  complianceUserSummary,
} from "../src/lib/db";
import { fixtureQuery } from "./support/retry";

const STAMP = `ackportal-${Date.now()}`;
const DAY = 86_400_000;

let spaceId = 0;
let anaId = 0;
let benId = 0;
const docIds: number[] = [];

const TEXT = Array.from({ length: 8 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");

/**
 * A published policy in the fixture space. setAckRequired's reconcile (D1)
 * enrols everyone active who can see the internal space, the two fixture
 * people among them; the INSERT keeps the fixture valid without it.
 */
async function policy(title: string): Promise<{ id: number; v1: number }> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content: TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  await setAckRequired(doc.id, true, { editDefault: null, recertMonths: null });
  const v1 = (await listVersions(doc.id))[0].id;
  await fixtureQuery(
    `INSERT INTO policy_assignments (document_id, user_id, source, cycle_started_at)
     SELECT d.id, u.id, 'space', d.ack_revision_at FROM documents d, users u
     WHERE d.id = $1 AND u.id = ANY($2::int[])
     ON CONFLICT (document_id, user_id) DO NOTHING`,
    [doc.id, [anaId, benId]]
  );
  return { id: doc.id, v1 };
}

const setRow = (docId: number, userId: number, sql: string, params: unknown[] = []) =>
  pool().query(`UPDATE policy_assignments SET ${sql} WHERE document_id = $1 AND user_id = $2`, [docId, userId, ...params]);

const setSpaceDefaults = (defaults: Record<string, number>) =>
  pool().query("UPDATE spaces SET policy_defaults = $2::jsonb WHERE id = $1", [spaceId, JSON.stringify(defaults)]);

const docRow = async (id: number) => {
  const row = (await complianceDocs()).find((d) => d.id === id);
  assert.ok(row, `policy ${id} in complianceDocs`);
  return row;
};

const personRow = async (userId: number) => {
  const row = (await complianceUserSummary()).find((u) => u.id === userId);
  assert.ok(row, `user ${userId} in complianceUserSummary`);
  return row;
};

/** The workspace's grace as the cascade reads it (ack_defaults.overdue_grace_days, else the built-in 0): read, never written here. */
async function workspaceGrace(): Promise<number> {
  try {
    const raw = await getSetting("ack_defaults");
    const v = raw ? (JSON.parse(raw) as { overdue_grace_days?: unknown }).overdue_grace_days : undefined;
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 90 ? v : 0;
  } catch {
    return 0;
  }
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Portal ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Ana Portal', $2, 'viewer', 'active'),
       ($3, 'Ben Portal', $4, 'viewer', 'active')
     RETURNING id`,
    [`${STAMP}-ana`, `${STAMP}-ana@example.test`, `${STAMP}-ben`, `${STAMP}-ben@example.test`]
  );
  anaId = users.rows[0].id;
  benId = users.rows[1].id;
});

after(async () => {
  const userIds = [anaId, benId];
  await pool().query("DELETE FROM policy_assignments WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM policy_settings WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2) OR document_title LIKE $3", [
    docIds,
    userIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1)", [docIds]).catch(() => {});
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("the portal's overdue counts (E1)", () => {
  test("a row past its due date with no confirmation is overdue on the policy and on the person; a confirmed row never is; the required and acked counts do not move", async () => {
    const { id, v1 } = await policy(`${STAMP} overdue`);
    await setSpaceDefaults({});
    const grace = await workspaceGrace();
    const before = await docRow(id);
    assert.equal(before.overdue, 0, "a deadline set a moment ago is not overdue");
    assert.equal((await personRow(anaId)).overdue, 0);

    // Ana's deadline passed (grace + 2) days ago; Ben's too, but Ben confirmed.
    const past = new Date(Date.now() - (grace + 2) * DAY);
    await setRow(id, anaId, "due_at = $3", [past]);
    await setRow(id, benId, "due_at = $3", [past]);
    await recordAcknowledgement(id, benId, "", v1);

    const row = await docRow(id);
    assert.equal(row.overdue, 1, "Ana is overdue, Ben is not");
    assert.equal(row.required, before.required, "the denominator is unchanged");
    assert.equal(row.acked, before.acked + 1, "Ben's confirmation counts");
    assert.equal((await personRow(anaId)).overdue, 1, "Ana's row on the People page");
    assert.equal((await personRow(benId)).overdue, 0, "Ben's row on the People page");
    const ana = await personRow(anaId);
    assert.ok(ana.required >= 1 && ana.acked === 0, "Ana still owes the policy");

    // A row without a due date is never overdue, however old the policy.
    await setRow(id, anaId, "due_at = NULL");
    assert.equal((await docRow(id)).overdue, 0, "no due date, nothing overdue");
    assert.equal((await personRow(anaId)).overdue, 0);
  });

  test("the space's grace delays overdue on both counts; an exempt or removed row is never overdue", async () => {
    const { id } = await policy(`${STAMP} grace`);
    const grace = await workspaceGrace();
    // Two days past the due date (plus whatever the workspace allows).
    await setRow(id, anaId, "due_at = $3", [new Date(Date.now() - (grace + 2) * DAY)]);
    assert.equal((await docRow(id)).overdue, 1, "overdue with the space's grace unset");

    await setSpaceDefaults({ overdue_grace_days: grace + 5 });
    assert.equal((await docRow(id)).overdue, 0, "within the space's grace: not yet overdue");
    assert.equal((await personRow(anaId)).overdue, 0, "the person's count agrees");

    await setSpaceDefaults({ overdue_grace_days: 1 });
    assert.equal((await docRow(id)).overdue, grace + 2 > 1 ? 1 : 0, "a shorter grace: overdue again");
    await setSpaceDefaults({});
    assert.equal((await docRow(id)).overdue, 1);

    // Exempt: out of every count, the overdue one included; removed likewise.
    await setRow(id, anaId, "exempt_at = now(), exempt_by_name = 'Mia', exempt_reason = 'On leave'");
    assert.equal((await docRow(id)).overdue, 0, "an exempt row is not overdue");
    assert.equal((await personRow(anaId)).overdue, 0);
    await setRow(id, anaId, "exempt_at = NULL, exempt_by_name = '', exempt_reason = '', removed_at = now(), removed_reason = 'left_group'");
    assert.equal((await docRow(id)).overdue, 0, "a removed row is not overdue");
    await setRow(id, anaId, "removed_at = NULL, removed_reason = ''");
    assert.equal((await docRow(id)).overdue, 1, "back in the audience: overdue again");
  });

  test("the policy's deadline rule travels with the row: its own days or fixed date, and the days the cascade resolves", async () => {
    const { id } = await policy(`${STAMP} rule`);
    await setSpaceDefaults({});
    const inherited = await docRow(id);
    assert.equal(inherited.due_days, null, "no rule of its own");
    assert.equal(inherited.due_at, null);
    assert.ok(inherited.due_days_resolved >= 1 && inherited.due_days_resolved <= 365, "the workspace's days or the built-in 14");

    await setSpaceDefaults({ due_days: 30 });
    assert.equal((await docRow(id)).due_days_resolved, 30, "the space's days when the policy has none");
    assert.equal((await docRow(id)).due_days, null, "still not the policy's own");

    await pool().query(
      `INSERT INTO policy_settings (document_id, due_days) VALUES ($1, 7)
       ON CONFLICT (document_id) DO UPDATE SET due_days = 7`,
      [id]
    );
    const own = await docRow(id);
    assert.equal(own.due_days, 7, "the policy's own days");
    assert.equal(own.due_days_resolved, 7, "which the cascade resolves to");

    await pool().query("UPDATE policy_settings SET due_days = NULL, due_at = '2031-06-30' WHERE document_id = $1", [id]);
    const fixed = await docRow(id);
    assert.equal(fixed.due_at, "2031-06-30", "a fixed date as 'YYYY-MM-DD'");
    assert.equal(fixed.due_days, null);
    assert.equal(fixed.due_days_resolved, 30, "the space's days stand behind the fixed date");
    await setSpaceDefaults({});
  });
});

describe("the portal's enrolled-this-week count (D1)", () => {
  test("open rows assigned in the last seven days count; an older row, a removed row and a returning person do not", async () => {
    const { id } = await policy(`${STAMP} enrolled`);
    const fresh = await docRow(id);
    assert.ok(fresh.enrolled_week >= 2, "everyone the switch-on enrolled joined this week");
    assert.equal(fresh.enrolled_week, fresh.required, "including every exempt-free open row of an active account");

    // Ana joined eight days ago.
    await setRow(id, anaId, "assigned_at = now() - interval '8 days'");
    assert.equal((await docRow(id)).enrolled_week, fresh.enrolled_week - 1, "an older enrolment is not this week's");

    // Ben left the audience: his row is closed, not deleted, and not counted.
    await setRow(id, benId, "removed_at = now(), removed_reason = 'left_group'");
    assert.equal((await docRow(id)).enrolled_week, fresh.enrolled_week - 2, "a closed row does not count");

    // Ben returns: the same row re-opens with its original assigned_at, so
    // a return is not an enrolment (the reconcile keeps assigned_at too).
    await setRow(id, benId, "removed_at = NULL, removed_reason = '', assigned_at = now() - interval '20 days', cycle_started_at = now()");
    assert.equal((await docRow(id)).enrolled_week, fresh.enrolled_week - 2, "a returning person is not newly enrolled");

    // An exempt row opened this week still counts: the person joined the
    // audience, whatever they owe today.
    await setRow(id, anaId, "assigned_at = now(), exempt_at = now(), exempt_by_name = 'Mia', exempt_reason = 'On leave'");
    const withExempt = await docRow(id);
    assert.equal(withExempt.enrolled_week, fresh.enrolled_week - 1, "an exempt row enrolled this week counts");
    assert.equal(withExempt.required, fresh.required - 1, "while it is out of the denominator");
  });
});
