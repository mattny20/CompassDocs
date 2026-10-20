// The needs-attention queue and the Overview's new numbers (F1, 1.14.0):
// policyNeedsAttention names one reason per open, unconfirmed row of a live
// policy (overdue, escalated, never opened, opened but not confirmed), the
// standing exemptions and the two policy-level rows from the decisions
// ledger (drifted, kept against the suggestion); a snoozed row leaves the
// list and nothing else; complianceKpiExtras counts the rows due inside
// seven days, the escalated and the snoozed; complianceDocs carries the
// stacked bar's four numbers, the last reminder, the owner, the edit default
// and the set names; complianceUserSummary the exempt count; the matrix CSV
// gains status and set. Every query is scoped to this file's own policies
// (the documentIds option), so the other files' rows never move a number
// here while the suite runs in parallel.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-attention.test.ts

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
  policyNeedsAttention,
  complianceKpiExtras,
  createGroup,
  setGroupMembers,
  setSpaceGroups,
  ATTENTION_STALE_DAYS,
  ATTENTION_EXEMPTION_MONTHS,
  ATTENTION_KEPT_MIN,
  editDefaultOf,
} from "../src/lib/db";
import type { PolicyAttentionRow } from "../src/lib/db";
import { RESET_MIN_PCT } from "../src/lib/diff";
import { MATRIX_CSV_HEADER, EXEMPTION_CSV_COLUMNS, STANDING_CSV_COLUMNS, matrixStatus } from "../src/lib/read-evidence";
import { fixtureQuery } from "./support/retry";

const STAMP = `ackattn-${Date.now()}`;
const DAY = 86_400_000;

let spaceId = 0;
let groupId = 0;
let anaId = 0;
let benId = 0;
let calId = 0;
const docIds: number[] = [];

const TEXT = Array.from({ length: 8 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");

/**
 * A published policy in the fixture space. setAckRequired's reconcile (D1)
 * enrols everyone active who can see the space (the three fixture people
 * and any account holding read-all globally, with no due date and asked just
 * now, so never in the queue); the INSERT keeps the fixture valid without
 * the reconcile. The space is private and granted to a group holding only
 * the three, so another file's accounts never land on these policies.
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
    [doc.id, [anaId, benId, calId]]
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

/** The queue over the named policies only (every branch scoped), with no limit in the way. */
const queue = (ids: number[]) => policyNeedsAttention(5000, { documentIds: ids });
const extras = (ids: number[]) => complianceKpiExtras({ documentIds: ids });

const rowOf = (rows: PolicyAttentionRow[], docId: number, userId: number | null) =>
  rows.find((r) => r.document_id === docId && r.user_id === userId);

/** Two instants within two seconds of each other (a SQL now() against a JS Date). */
const near = (a: string | null, b: number | Date, what: string) => {
  assert.ok(a, `${what}: an instant`);
  const t = typeof b === "number" ? b : b.getTime();
  assert.ok(Math.abs(new Date(a).getTime() - t) < 2000, `${what}: ${a} is within 2s of ${new Date(t).toISOString()}`);
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

/** A kept decision row as the ledger writes one (C1), dated as asked: clock_timestamp() by default, so rows inserted in sequence are ordered and all follow the marker a policy got seconds ago. */
const keptRow = (docId: number, pct: number, overrode: boolean, decidedAt = "clock_timestamp()") =>
  pool().query(
    `INSERT INTO ack_decisions (document_id, document_title, outcome, source, decided_by_name, reason, change_pct, overrode_suggestion, decided_at)
     VALUES ($1, 'attention', 'kept', 'edit', 'Ed Itor', 'typo', $2, $3, ${decidedAt})`,
    [docId, pct, overrode ? 1 : 0]
  );

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id`,
    [`Ack Attention ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Ana Attention', $2, 'viewer', 'active'),
       ($3, 'Ben Attention', $4, 'viewer', 'active'),
       ($5, 'Cal Attention', $6, 'viewer', 'active')
     RETURNING id`,
    [
      `${STAMP}-ana`,
      `${STAMP}-ana@example.test`,
      `${STAMP}-ben`,
      `${STAMP}-ben@example.test`,
      `${STAMP}-cal`,
      `${STAMP}-cal@example.test`,
    ]
  );
  anaId = users.rows[0].id;
  benId = users.rows[1].id;
  calId = users.rows[2].id;
  groupId = (await createGroup({ name: `${STAMP} readers` })).id;
  await setGroupMembers(groupId, [anaId, benId, calId]);
  await setSpaceGroups(spaceId, [groupId]);
});

after(async () => {
  const userIds = [anaId, benId, calId];
  await pool().query("DELETE FROM doc_views WHERE document_id = ANY($1)", [docIds]);
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
  await pool().query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("the needs-attention queue (F1)", () => {
  test("a fresh policy names nobody: asked a moment ago, no deadline, nothing kept", async () => {
    const { id } = await policy(`${STAMP} fresh`);
    const q = await queue([id]);
    assert.deepEqual(q, { rows: [], total: 0, snoozed: 0 });
    assert.deepEqual(await extras([id]), { due_7d: 0, escalated: 0, snoozed: 0 });
  });

  test("a snoozed overdue row stays in the overdue counts and leaves attention.rows, counted in snoozed; the snooze over, it is back with the due date as its detail", async () => {
    const { id } = await policy(`${STAMP} snooze`);
    await setSpaceDefaults({});
    const grace = await workspaceGrace();
    const past = new Date(Date.now() - (grace + 2) * DAY);
    await setRow(id, anaId, "due_at = $3", [past]);

    const open = await queue([id]);
    assert.equal(open.total, 1);
    assert.equal(open.snoozed, 0);
    const row = rowOf(open.rows, id, anaId);
    assert.ok(row, "Ana is in the queue");
    assert.equal(row.reason, "overdue");
    assert.equal(row.user_name, "Ana Attention");
    assert.equal(row.title, `${STAMP} snooze`);
    assert.equal(row.space_id, spaceId);
    assert.ok(row.assignment_id, "the assignment id travels with the row");
    near(row.due_at, past, "due_at");
    assert.equal(row.detail, row.due_at, "an overdue row details its due date");
    near(row.since, past.getTime() + grace * DAY, "since = the due date plus the grace");

    // Snoozed: off the list, on the count, and nowhere else.
    await setRow(id, anaId, "snoozed_until = now() + interval '7 days'");
    const hidden = await queue([id]);
    assert.equal(rowOf(hidden.rows, id, anaId), undefined, "a snoozed row leaves the queue");
    assert.equal(hidden.total, 0, "and is not in the total");
    assert.equal(hidden.snoozed, 1, "it is counted as snoozed");
    assert.equal((await docRow(id)).overdue, 1, "the policy's overdue count ignores the snooze");
    assert.equal((await personRow(anaId)).overdue, 1, "so does the person's");
    assert.equal((await extras([id])).snoozed, 1, "kpis.snoozed counts it");

    // The snooze ran out: back in the queue.
    await setRow(id, anaId, "snoozed_until = now() - interval '1 hour'");
    const back = await queue([id]);
    assert.equal(rowOf(back.rows, id, anaId)?.reason, "overdue");
    assert.equal(back.snoozed, 0);
    assert.equal((await extras([id])).snoozed, 0);
  });

  test("'never_opened' for a person asked over 14 days ago with no view since the ask; 'opened_not_confirmed' once a view follows the ask; a view before the ask does not count; a confirmation clears the row", async () => {
    const { id, v1 } = await policy(`${STAMP} opened`);
    const stale = ATTENTION_STALE_DAYS + 1;
    // The ask is the later of the document marker and the row's cycle:
    // both go back 15 days for Ana and Ben; Cal was asked again 5 days ago.
    await pool().query("UPDATE documents SET ack_revision_at = now() - make_interval(days => $2) WHERE id = $1", [id, stale]);
    await setRow(id, anaId, "assigned_at = now() - make_interval(days => $3), cycle_started_at = now() - make_interval(days => $3)", [stale]);
    await setRow(id, benId, "assigned_at = now() - make_interval(days => $3), cycle_started_at = now() - make_interval(days => $3)", [stale]);
    await setRow(id, calId, "assigned_at = now() - make_interval(days => $3), cycle_started_at = now() - interval '5 days'", [stale]);

    const first = await queue([id]);
    assert.equal(first.total, 2, "Ana and Ben; Cal was asked again five days ago");
    const ana = rowOf(first.rows, id, anaId);
    assert.equal(ana?.reason, "never_opened");
    assert.equal(ana?.detail, null);
    // The switch-on's reconcile dated the row (14 days ahead): the date
    // travels with the row and does not decide the reason.
    near(ana?.since ?? null, Date.now() - stale * DAY, "since = when Ana was asked");
    assert.equal(rowOf(first.rows, id, benId)?.reason, "never_opened");
    assert.equal(rowOf(first.rows, id, calId), undefined);

    // Ben opened the document three weeks ago, before this ask: still never opened.
    await pool().query(
      "INSERT INTO doc_views (document_id, user_id, source, viewed_at) VALUES ($1, $2, 'app', now() - interval '21 days')",
      [id, benId]
    );
    assert.equal(rowOf((await queue([id])).rows, id, benId)?.reason, "never_opened", "a view from before the ask does not count");

    // Ben opened it yesterday: opened, not confirmed, since that view.
    const viewed = new Date(Date.now() - DAY);
    await pool().query("INSERT INTO doc_views (document_id, user_id, source, viewed_at) VALUES ($1, $2, 'app', $3)", [id, benId, viewed]);
    const opened = rowOf((await queue([id])).rows, id, benId);
    assert.equal(opened?.reason, "opened_not_confirmed");
    near(opened?.since ?? null, viewed, "since = the latest view");

    // Ben confirmed: out of the queue; Ana stays.
    await recordAcknowledgement(id, benId, "", v1);
    const after = await queue([id]);
    assert.equal(after.total, 1);
    assert.equal(rowOf(after.rows, id, benId), undefined, "a current confirmation leaves the queue");
    assert.equal(rowOf(after.rows, id, anaId)?.reason, "never_opened");
  });

  test("'escalated' when the escalation stands on a row that is not overdue (the grace widened after it fired); an overdue escalated row reads 'overdue'; kpis.escalated counts both", async () => {
    const { id } = await policy(`${STAMP} escalated`);
    const grace = await workspaceGrace();
    const escalatedAt = new Date(Date.now() - 3600_000);
    await setRow(id, anaId, "due_at = now() - interval '1 day', escalated_at = $3", [escalatedAt]);
    await setSpaceDefaults({ overdue_grace_days: Math.min(90, grace + 30) });
    const standing = rowOf((await queue([id])).rows, id, anaId);
    assert.equal(standing?.reason, "escalated", "inside the widened grace: escalated, not overdue");
    near(standing?.since ?? null, escalatedAt, "since = the escalation");
    assert.equal((await extras([id])).escalated, 1);

    await setSpaceDefaults({});
    await setRow(id, anaId, "due_at = $3", [new Date(Date.now() - (grace + 2) * DAY)]);
    assert.equal(rowOf((await queue([id])).rows, id, anaId)?.reason, "overdue", "past the grace: overdue outranks escalated");
    assert.equal((await extras([id])).escalated, 1, "still escalated for the tile");
  });

  test("a standing exemption older than a year appears once with its reason; a dated or a recent one does not; the exempt rows are off the denominator and on the exempt counts", async () => {
    const { id } = await policy(`${STAMP} exemption`);
    const anaBefore = (await personRow(anaId)).exempt;
    const months = ATTENTION_EXEMPTION_MONTHS + 1;
    await setRow(id, anaId, "exempt_at = now() - make_interval(months => $3), exempt_by_name = 'Mia', exempt_reason = 'Contractor'", [months]);
    await setRow(id, benId, "exempt_at = now() - make_interval(months => $3), exempt_until = now() + interval '1 month', exempt_by_name = 'Mia', exempt_reason = 'On leave'", [months]);
    await setRow(id, calId, "exempt_at = now() - interval '1 month', exempt_by_name = 'Mia', exempt_reason = 'Sabbatical'");

    const q = await queue([id]);
    assert.equal(q.total, 1, "one standing exemption to review");
    const row = rowOf(q.rows, id, anaId);
    assert.equal(row?.reason, "standing_exemption");
    assert.equal(row?.detail, "Contractor", "the reason as the detail");
    assert.equal(row?.due_at, null);
    const exemptedAt = (await pool().query("SELECT (now() - make_interval(months => $1)) AS t", [months])).rows[0].t as string;
    near(row?.since ?? null, new Date(exemptedAt), "since = the exemption");
    assert.equal(rowOf(q.rows, id, benId), undefined, "a dated exemption is not a standing one");
    assert.equal(rowOf(q.rows, id, calId), undefined, "a recent one is not up for review");

    const doc = await docRow(id);
    assert.equal(doc.exempt, 3, "the bar's exempt number: every exempt row of an active account");
    assert.equal(doc.confirmed + doc.pending, doc.required, "confirmed and pending partition the denominator");
    assert.equal((await personRow(anaId)).exempt, anaBefore + 1, "the person's exempt count");
  });

  test("a drifted policy appears once ('{pct}% since v{N}'), a policy kept against the suggestion three times appears once; both are policy-level rows; a kept edit before the marker and a drift under the threshold count for nothing", async () => {
    const { id } = await policy(`${STAMP} drifted`);
    const doc = await docRow(id);
    const since = doc.ack_revision_at;
    const v = doc.ack_rev != null ? `v${doc.ack_rev}` : "the last ask";

    // A big kept edit from before the marker: everyone was asked after it.
    await keptRow(id, 50, true, "(SELECT ack_revision_at - interval '1 day' FROM documents WHERE id = $1)");
    assert.equal((await queue([id])).total, 0, "a kept edit before the marker is not drift");

    // Under the threshold: no row.
    await keptRow(id, RESET_MIN_PCT - 2, false);
    assert.equal((await queue([id])).total, 0, "a drift under RESET_MIN_PCT names nothing");

    // The newest kept row measures the whole drift against the marker (C1).
    await keptRow(id, 7.5, false);
    const drifted = await queue([id]);
    assert.equal(drifted.total, 1);
    const row = rowOf(drifted.rows, id, null);
    assert.ok(row, "one policy-level row");
    assert.equal(row.reason, "drifted");
    assert.equal(row.detail, `7.5% since ${v}`);
    assert.equal(row.assignment_id, null);
    assert.equal(row.user_name, null);
    assert.equal(row.title, `${STAMP} drifted`);
    assert.equal(row.since, since, "since = the marker");
    assert.equal((await docRow(id)).drift_pct, 7.5, "the same number the Policies row and the Drifted tile read");

    // Three keeps against the suggestion: a second row for the policy.
    for (let i = 0; i < ATTENTION_KEPT_MIN; i++) {
      await keptRow(id, 8 + i * 0.5, true);
    }
    const kept = await queue([id]);
    assert.equal(kept.total, 2, "drifted and kept_n, once each");
    const mine = kept.rows.filter((r) => r.document_id === id);
    assert.deepEqual(
      mine.map((r) => r.reason),
      ["drifted", "kept_n"]
    );
    assert.equal(mine[0].detail, `${8 + (ATTENTION_KEPT_MIN - 1) * 0.5}% since ${v}`, "the drift is the newest kept row's");
    assert.equal(mine[1].detail, `Kept against the suggestion ${ATTENTION_KEPT_MIN} times`);
    assert.equal(mine[1].since, since);
  });

  test("the limit cuts the list, total counts before it, and the policy-level rows come first", async () => {
    const all = await queue(docIds);
    assert.ok(all.total >= 4, `the fixtures above left at least four rows (${all.total})`);
    assert.equal(all.rows.length, all.total, "no limit in the way: every row");
    const policyLevel = all.rows.filter((r) => r.assignment_id === null).length;
    assert.ok(policyLevel >= 2);
    assert.ok(
      all.rows.slice(0, policyLevel).every((r) => r.assignment_id === null),
      "the policy-level rows lead, so the limit never hides them behind the people"
    );
    const people = all.rows.filter((r) => r.assignment_id !== null);
    const ranks = people.map((r) => ["overdue", "escalated", "never_opened", "opened_not_confirmed", "standing_exemption"].indexOf(r.reason));
    assert.ok(ranks.every((n) => n >= 0), "every person row carries a per-person reason");
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "then the people in the priority order");

    const one = await policyNeedsAttention(1, { documentIds: docIds });
    assert.equal(one.rows.length, 1);
    assert.equal(one.total, all.total, "the total is counted before the limit");
    assert.equal(one.rows[0].reason, all.rows[0].reason);
  });

  test("paused and retired policies are absent from the queue and the numbers", async () => {
    const { id } = await policy(`${STAMP} paused`);
    const grace = await workspaceGrace();
    await setRow(id, anaId, "due_at = $3, escalated_at = now()", [new Date(Date.now() - (grace + 2) * DAY)]);
    await setRow(id, benId, "due_at = now() + interval '2 days'");
    assert.equal((await queue([id])).total, 1);
    assert.deepEqual(await extras([id]), { due_7d: 1, escalated: 1, snoozed: 0 });

    await pool().query("UPDATE documents SET status = 'draft' WHERE id = $1", [id]);
    assert.deepEqual(await queue([id]), { rows: [], total: 0, snoozed: 0 }, "a paused policy asks nobody");
    assert.deepEqual(await extras([id]), { due_7d: 0, escalated: 0, snoozed: 0 });

    await pool().query("UPDATE documents SET status = 'published' WHERE id = $1", [id]);
    assert.equal((await queue([id])).total, 1, "published again: back");

    await pool().query(
      "UPDATE documents SET ack_required = 0, ack_retired_at = now(), ack_retired_by_name = 'Mia', ack_retired_reason = 'Superseded by the new handbook' WHERE id = $1",
      [id]
    );
    assert.deepEqual(await queue([id]), { rows: [], total: 0, snoozed: 0 }, "a retired policy asks nobody");
    assert.deepEqual(await extras([id]), { due_7d: 0, escalated: 0, snoozed: 0 });
  });
});

describe("the KPI extras (F1)", () => {
  test("due_7d counts a deadline inside the next seven days: not one beyond, not one past, not a confirmed row; escalated and snoozed are the open rows so marked", async () => {
    const { id, v1 } = await policy(`${STAMP} extras`);
    await setRow(id, anaId, "due_at = now() + interval '3 days'");
    assert.equal((await extras([id])).due_7d, 1);
    await setRow(id, benId, "due_at = now() + interval '10 days'");
    assert.equal((await extras([id])).due_7d, 1, "ten days out is not inside the week");
    await setRow(id, calId, "due_at = now() - interval '1 day'");
    assert.equal((await extras([id])).due_7d, 1, "a passed deadline is overdue or in its grace, not due in seven days");
    await recordAcknowledgement(id, anaId, "", v1);
    assert.equal((await extras([id])).due_7d, 0, "a confirmed row is not due");

    await setRow(id, benId, "escalated_at = now()");
    await setRow(id, calId, "snoozed_until = now() + interval '2 days'");
    assert.deepEqual(await extras([id]), { due_7d: 0, escalated: 1, snoozed: 1 });
    await setRow(id, benId, "exempt_at = now(), exempt_by_name = 'Mia', exempt_reason = 'On leave'");
    assert.equal((await extras([id])).escalated, 0, "an exempt row is out of every number");
  });
});

describe("the portal rows (F1)", () => {
  test("a docs row carries the four bar numbers, the last reminder, the owner through the cascade, the edit default and the set names; a users row the exempt count", async () => {
    const { id, v1 } = await policy(`${STAMP} rows`);
    await recordAcknowledgement(id, benId, "", v1);
    await setRow(id, calId, "exempt_at = now(), exempt_by_name = 'Mia', exempt_reason = 'On leave'");
    const calBefore = (await personRow(calId)).exempt;

    const row = await docRow(id);
    assert.equal(row.confirmed, row.acked, "confirmed is the bar's name for acked");
    assert.equal(row.pending, row.required - row.acked);
    assert.equal(row.overdue, 0);
    assert.equal(row.exempt, 1);
    assert.ok(row.confirmed >= 1 && row.pending >= 1, "Ben confirmed, Ana is pending");
    assert.equal(row.edit_default, editDefaultOf(row), "the policy's own column, resolved");
    assert.ok(["ask", "material", "reset"].includes(row.edit_default));
    assert.deepEqual(row.set_names, [], "no policy set names it");
    assert.ok(Number.isInteger(row.overdue_grace_days) && row.overdue_grace_days >= 0, "the grace the overdue count applied");
    assert.equal(row.last_reminded_at, null, "nobody reminded yet");
    assert.equal(row.owner_name, null, "no owner anywhere in the cascade");
    assert.equal(row.owner_user_id, null);
    assert.equal((await personRow(calId)).exempt, calBefore, "Cal's exempt count already included this row");
    assert.ok((await personRow(calId)).exempt >= 1);

    // The owner: the policy's own, else the space's, else whoever switched the requirement on.
    await pool().query(
      `INSERT INTO policy_settings (document_id, requested_by) VALUES ($1, $2)
       ON CONFLICT (document_id) DO UPDATE SET requested_by = EXCLUDED.requested_by`,
      [id, calId]
    );
    assert.equal((await docRow(id)).owner_name, "Cal Attention", "the requester when nobody else owns it");
    await setSpaceDefaults({ owner_user_id: benId });
    assert.equal((await docRow(id)).owner_name, "Ben Attention", "the space's policy owner outranks the requester");
    await pool().query("UPDATE policy_settings SET owner_user_id = $2 WHERE document_id = $1", [id, anaId]);
    const owned = await docRow(id);
    assert.equal(owned.owner_name, "Ana Attention", "the policy's own owner outranks both");
    assert.equal(owned.owner_user_id, anaId);
    await setSpaceDefaults({});
    await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [anaId]);
    assert.equal((await docRow(id)).owner_name, "Cal Attention", "a disabled owner is passed over");
    await pool().query("UPDATE users SET status = 'active' WHERE id = $1", [anaId]);
    await pool().query("UPDATE policy_settings SET owner_user_id = NULL, requested_by = NULL WHERE document_id = $1", [id]);

    // The last reminder: the newest row stamp or the manual Remind, whichever is later.
    const stamped = new Date(Date.now() - 2 * DAY);
    await setRow(id, anaId, "reminded_at = $3", [stamped]);
    near((await docRow(id)).last_reminded_at, stamped, "the sweep's stamp");
    const manual = new Date(Date.now() - DAY);
    await pool().query("UPDATE documents SET ack_last_reminded_at = $2 WHERE id = $1", [id, manual]);
    near((await docRow(id)).last_reminded_at, manual, "the manual Remind, being later");
  });
});

describe("the matrix CSV (F1), pure", () => {
  test("the header appends status and set after the 1.13.0 columns", () => {
    assert.ok(MATRIX_CSV_HEADER.endsWith(`,${EXEMPTION_CSV_COLUMNS},${STANDING_CSV_COLUMNS}`));
    assert.equal(STANDING_CSV_COLUMNS, "status,set");
    assert.equal(MATRIX_CSV_HEADER.split(",").filter((c) => c === "due_at").length, 1, "no column is named twice");
  });

  test("matrixStatus: exempt outranks everything, then confirmed, then overdue past the grace, else pending; a former-staff row is confirmed", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const past = new Date(now.getTime() - 3 * DAY).toISOString();
    assert.equal(matrixStatus({ acknowledged_at: past, exempt: true, due_at: past }, 0, now), "exempt");
    assert.equal(matrixStatus({ acknowledged_at: past, due_at: past }, 0, now), "confirmed");
    assert.equal(matrixStatus({ acknowledged_at: null, due_at: past }, 0, now), "overdue");
    assert.equal(matrixStatus({ acknowledged_at: null, due_at: past }, 5, now), "pending", "inside a five-day grace");
    assert.equal(matrixStatus({ acknowledged_at: null, due_at: past }, 2, now), "overdue", "past a two-day grace");
    assert.equal(matrixStatus({ acknowledged_at: null, due_at: null }, 0, now), "pending", "no deadline is never overdue");
    assert.equal(matrixStatus({ acknowledged_at: null }, 0, now), "pending");
    assert.equal(matrixStatus({ acknowledged_at: past }, 0, now), "confirmed", "a former-staff row");
  });
});
