// Exemptions, extensions and snooze (D2, 1.13.0): an exempt row leaves every
// denominator and stays on the roster as 'exempt' with its reason; a manager
// cannot exempt their own row; removing an exemption re-arms the deadline
// from the cascade; extend counts from today or the current date, whichever
// is later, and keeps the move in due_history (the last 10); undo is its
// inverse; snooze is capped at 30 days and changes nothing but the snooze;
// the hourly expiry clears dated exemptions; the space-scoped twin's bound
// skips ids of another document; the request rules the routes answer 400
// with; and the per-person re-ask through the assignments route.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-exempt.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { asScope } from "../src/lib/space-scope";
import {
  pool,
  getSetting,
  createDocument,
  setAckRequired,
  recordAcknowledgement,
  getCurrentAck,
  listVersions,
  ackStatusForDocument,
  ackSummary,
  complianceDocs,
  compliancePendingUsers,
  complianceUserSummary,
  listPendingAcksFor,
  countPendingAcksFor,
  listMyPolicies,
  listAssignmentsForDocument,
  exemptAssignments,
  unexemptAssignments,
  extendAssignments,
  undoExtension,
  snoozeAssignments,
  unsnoozeAssignments,
  expireExemptions,
  reaskableAssignments,
  createGroup,
  setGroupMembers,
  setSpaceGroups,
  EXEMPT_REASON_MAX,
  SNOOZE_DAYS_MAX,
  EXTEND_DAYS_MAX,
  DUE_HISTORY_KEEP,
  ACK_REASON_MIN,
} from "../src/lib/db";
import type { PolicyAssignmentRow } from "../src/lib/db";
import { endOfDayIn } from "../src/lib/ack-due";
import { runAssignmentAction } from "../src/lib/ack-assignment-actions";
import {
  parseAssignmentRequest,
  ASSIGNMENT_IDS_MAX,
  SELF_EXEMPTION_ERROR,
  REASK_REASON_MIN,
  SNOOZE_DAYS_DEFAULT,
  EXTEND_DAYS_DEFAULT,
  EXEMPT_REASON_MAX as PURE_EXEMPT_REASON_MAX,
  SNOOZE_DAYS_MAX as PURE_SNOOZE_DAYS_MAX,
  EXTEND_DAYS_MAX as PURE_EXTEND_DAYS_MAX,
  exemptionText,
  snoozeText,
} from "../src/lib/ack-assignments";
import { rosterStatus, exemptionCsvCells } from "../src/lib/read-evidence";
import { fixtureQuery } from "./support/retry";

const STAMP = `ackexempt-${Date.now()}`;
const DAY = 86_400_000;
const HOUR = 3_600_000;

let spaceId = 0;
let groupId = 0;
let anaId = 0;
let benId = 0;
let miaId = 0;
const docIds: number[] = [];

const TEXT = Array.from({ length: 12 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");
const manager = () => ({ id: miaId, name: "Mia Manager" });
const scope = () => asScope([spaceId]);
const fmt = (iso: string) => iso.slice(0, 10);

/**
 * A published policy the three fixture people owe. The assignment rows are
 * inserted here with ON CONFLICT DO NOTHING: on the production path
 * setAckRequired's reconcile (D1) writes them, and the fixture stays valid
 * either way. `benConfirms` records Ben's confirmation of v1.
 */
async function policy(title: string, opts: { benConfirms?: boolean } = {}): Promise<{ id: number; v1: number }> {
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
  // Both null: leave the edit default and the interval alone rather than
  // read the workspace settings row another test file may be writing.
  await setAckRequired(doc.id, true, { editDefault: null, recertMonths: null });
  const v1 = (await listVersions(doc.id))[0].id;
  await fixtureQuery(
    `INSERT INTO policy_assignments (document_id, user_id, source, cycle_started_at)
     SELECT d.id, u.id, 'space', d.ack_revision_at FROM documents d, users u
     WHERE d.id = $1 AND u.id = ANY($2::int[])
     ON CONFLICT (document_id, user_id) DO NOTHING`,
    [doc.id, [anaId, benId, miaId]]
  );
  if (opts.benConfirms) await recordAcknowledgement(doc.id, benId, "", v1);
  return { id: doc.id, v1 };
}

async function rowOf(docId: number, userId: number): Promise<PolicyAssignmentRow> {
  const r = await pool().query<PolicyAssignmentRow>(
    `SELECT id, document_id, user_id, source, assigned_at, cycle_started_at, due_at, due_history,
            reminded_at, reminder_count, escalated_at, snoozed_until, snoozed_by,
            exempt_at, exempt_by, exempt_by_name, exempt_reason, exempt_until
     FROM policy_assignments WHERE document_id = $1 AND user_id = $2`,
    [docId, userId]
  );
  assert.ok(r.rows[0], `an assignment row for user ${userId} on document ${docId}`);
  return r.rows[0];
}

const setRow = (id: number, sql: string, params: unknown[] = []) =>
  pool().query(`UPDATE policy_assignments SET ${sql} WHERE id = $1`, [id, ...params]);

/** |a - b| within `ms`. */
function assertNear(actual: string | null, expected: Date, ms: number, label: string) {
  assert.ok(actual, `${label}: a date is set`);
  const diff = Math.abs(new Date(actual!).getTime() - expected.getTime());
  assert.ok(diff <= ms, `${label}: ${actual} is within ${ms}ms of ${expected.toISOString()} (off by ${diff}ms)`);
}

/** The workspace's zone as the cascade reads it (settings.timezone, else UTC): a fixed day, and an exemption's end, end in it. */
async function workspaceZone(): Promise<string> {
  return (await getSetting("timezone"))?.trim() || "UTC";
}

/** The workspace's default deadline as the cascade reads it (ack_defaults.due_days, else the built-in 14). */
async function workspaceDueDaysOrBuiltIn(): Promise<number> {
  const raw = await getSetting("ack_defaults");
  try {
    const v = raw ? (JSON.parse(raw) as { due_days?: unknown }).due_days : undefined;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 365 ? v : 14;
  } catch {
    return 14;
  }
}

const auditRows = async (action: string, docId: number) =>
  (
    await pool().query<{ actor_name: string; details: Record<string, unknown> }>(
      "SELECT actor_name, details FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
      [action, String(docId)]
    )
  ).rows;

before(async () => {
  await getSetting("__schema_bootstrap__");
  // A private space granted to one group holding only this file's people:
  // another file's account hooks (a new account, a re-enabled one) cannot
  // enrol anyone into these policies while the suite runs files in
  // parallel, so the exact counts below hold.
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id`,
    [`Ack Exempt ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Ana Ruiz', $2, 'viewer', 'active'),
       ($3, 'Ben Okoro', $4, 'viewer', 'active'),
       ($5, 'Mia Manager', $6, 'approver', 'active')
     RETURNING id`,
    [
      `${STAMP}-ana`,
      `${STAMP}-ana@example.test`,
      `${STAMP}-ben`,
      `${STAMP}-ben@example.test`,
      `${STAMP}-mia`,
      `${STAMP}-mia@example.test`,
    ]
  );
  anaId = users.rows[0].id;
  benId = users.rows[1].id;
  miaId = users.rows[2].id;
  groupId = (await createGroup({ name: `${STAMP} readers` })).id;
  await setGroupMembers(groupId, [anaId, benId, miaId]);
  await setSpaceGroups(spaceId, [groupId]);
});

after(async () => {
  const userIds = [anaId, benId, miaId];
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

describe("exemptions", () => {
  test("exempting a person takes them out of every denominator; the roster keeps the row as 'exempt' with the reason, who recorded it and until when; the ledger is untouched", async () => {
    const { id, v1 } = await policy(`${STAMP} exempt`, { benConfirms: true });
    const ana = await rowOf(id, anaId);

    const before = {
      summary: await ackSummary(id),
      doc: (await complianceDocs()).find((d) => d.id === id)!,
      pendingUsers: await compliancePendingUsers(id),
      pendingDocs: await listPendingAcksFor(anaId, scope()),
      pendingCount: await countPendingAcksFor(anaId, scope()),
      mine: await listMyPolicies(anaId, scope()),
      user: (await complianceUserSummary()).find((u) => u.id === anaId),
    };
    assert.ok(before.pendingUsers.some((u) => u.id === anaId), "before: Ana is pending");
    assert.ok(before.pendingDocs.some((d) => d.id === id), "before: the policy is on Ana's pending list");
    assert.ok(before.mine.some((d) => d.id === id), "before: and on her My policies");
    assert.ok(before.user && before.user.required >= 1, "before: she owes at least this policy");

    const r = await exemptAssignments(null, [ana.id], manager(), { reason: "On leave", until: "2099-12-01" });
    assert.deepEqual(r.self, []);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.changed.length, 1);
    assert.equal(r.changed[0].id, ana.id);
    assert.equal(r.changed[0].document_id, id);
    assert.equal(r.changed[0].user_id, anaId);
    assert.equal(r.changed[0].title, `${STAMP} exempt`);

    // Every denominator drops by one person, and every pending list loses her.
    const summary = await ackSummary(id);
    assert.equal(summary.eligible, before.summary.eligible - 1, "ackSummary.eligible");
    assert.equal(summary.current, before.summary.current, "Ben's confirmation still counts");
    assert.equal(summary.pending, before.summary.pending - 1, "ackSummary.pending");
    const doc = (await complianceDocs()).find((d) => d.id === id)!;
    assert.equal(doc.required, before.doc.required - 1, "complianceDocs.required");
    assert.equal(doc.acked, before.doc.acked, "complianceDocs.acked");
    assert.ok(!(await compliancePendingUsers(id)).some((u) => u.id === anaId), "compliancePendingUsers");
    assert.ok(!(await listPendingAcksFor(anaId, scope())).some((d) => d.id === id), "listPendingAcksFor");
    assert.equal(await countPendingAcksFor(anaId, scope()), before.pendingCount - 1, "countPendingAcksFor");
    assert.ok(!(await listMyPolicies(anaId, scope())).some((d) => d.id === id), "listMyPolicies");
    const user = (await complianceUserSummary()).find((u) => u.id === anaId);
    assert.equal(user?.required ?? 0, before.user!.required - 1, "complianceUserSummary.required");

    // The roster keeps the row, last, as 'exempt', in plain text.
    const rows = await ackStatusForDocument(id);
    const row = rows.find((x) => x.id === anaId)!;
    assert.ok(row, "the exempt row is on the roster");
    assert.equal(row.assignment_id, ana.id);
    assert.equal(row.exempt, true);
    assert.equal(row.exempt_reason, "On leave");
    assert.equal(row.exempt_by_name, "Mia Manager");
    assert.ok(row.exempt_at);
    // The day the manager typed is stored as its last instant in the
    // workspace zone (the rule a fixed deadline follows), so the roster and
    // the CSV, which format it in that zone, name 1 Dec and the sweep clears
    // it once 1 Dec has ended there.
    assert.equal(row.exempt_until, endOfDayIn("2099-12-01", await workspaceZone())!.toISOString(), "exempt_until: the day's end in the workspace zone");
    assert.equal(row.snoozed_until, null, "a snooze is moot while exempt");
    assert.equal(row.asked_again_at, null, "a row assigned after the marker was not asked again: its cycle simply began then");
    assert.equal(rows.indexOf(row), rows.length - 1, "exempt rows sort last");
    assert.equal(rows.find((x) => x.id === benId)!.exempt, false);
    assert.equal(rosterStatus(row), "exempt");
    assert.equal(rosterStatus(rows.find((x) => x.id === benId)!), "acknowledged");
    assert.equal(rosterStatus(rows.find((x) => x.id === miaId)!), "pending");
    const cells = exemptionCsvCells(row);
    assert.equal(cells[0], "On leave");
    assert.equal(cells[1], "Mia Manager");
    assert.equal(cells[2], row.exempt_until);
    assert.equal(cells[3], "");
    assert.equal(cells[4], row.due_at ?? "");
    assert.deepEqual(exemptionCsvCells(rows.find((x) => x.id === benId)!).slice(0, 3), ["", "", ""], "the three exemption cells are blank on a row that is not exempt");
    assert.equal(exemptionText(row, fmt), `On leave until ${fmt(row.exempt_until!)} · Mia Manager · ${fmt(row.exempt_at!)}`);

    const listed = (await listAssignmentsForDocument(id)).find((a) => a.user_id === anaId)!;
    assert.equal(listed.exempt_by, miaId);
    assert.equal(listed.exempt_reason, "On leave");
    assert.equal(listed.escalated_at, null);

    // Exempting again changes nothing; the first reason stands.
    const again = await exemptAssignments(null, [ana.id], manager(), { reason: "Other reason", until: null });
    assert.deepEqual(again.changed, []);
    assert.deepEqual(again.skipped, [ana.id]);
    assert.equal((await rowOf(id, anaId)).exempt_reason, "On leave");

    // The ledger: Ben's confirmation is as recorded, nothing else was written.
    assert.ok(await getCurrentAck(id, benId));
    const acks = await pool().query("SELECT COUNT(*)::int AS n FROM acknowledgements WHERE document_id = $1", [id]);
    assert.equal(acks.rows[0].n, 1);
    assert.equal((await getCurrentAck(id, benId))!.version_id, v1);
  });

  test("a manager cannot exempt their own row: nothing is written, and the route's sentence is the documented one", async () => {
    const { id } = await policy(`${STAMP} self`);
    const mia = await rowOf(id, miaId);
    const ana = await rowOf(id, anaId);
    const r = await exemptAssignments(null, [mia.id, ana.id], manager(), { reason: "Author of the policy", until: null });
    assert.deepEqual(r.self, [mia.id]);
    assert.deepEqual(r.changed, [], "the whole call is refused");
    assert.deepEqual(r.skipped, [mia.id, ana.id]);
    assert.equal((await rowOf(id, miaId)).exempt_at, null);
    assert.equal((await rowOf(id, anaId)).exempt_at, null, "the other row in the same request is not written either");
    assert.equal(SELF_EXEMPTION_ERROR, "Ask another compliance manager to record your exemption.");
    // Another manager records it.
    const other = await exemptAssignments(null, [mia.id], { id: anaId, name: "Ana Ruiz" }, { reason: "Author of the policy", until: null });
    assert.equal(other.changed.length, 1);
    assert.equal((await rowOf(id, miaId)).exempt_by_name, "Ana Ruiz");
  });

  test("the reason is bounded to 300 characters and the actor's name to 200", async () => {
    const { id } = await policy(`${STAMP} bounds`);
    const ana = await rowOf(id, anaId);
    const long = "x".repeat(EXEMPT_REASON_MAX + 50);
    const r = await exemptAssignments(null, [ana.id], { id: miaId, name: "M".repeat(250) }, { reason: `  ${long}  `, until: null });
    assert.equal(r.changed.length, 1);
    const row = await rowOf(id, anaId);
    assert.equal(row.exempt_reason.length, EXEMPT_REASON_MAX);
    assert.equal(row.exempt_by_name.length, 200);
    assert.equal(EXEMPT_REASON_MAX, PURE_EXEMPT_REASON_MAX, "the pure module and the database agree on the bound");
  });

  test("removing an exemption returns the person to pending with a fresh deadline from the cascade: the policy's days, else the space's, else the workspace's, else 14; a fixed date still ahead wins", async () => {
    const { id } = await policy(`${STAMP} unexempt`);
    const ana = await rowOf(id, anaId);
    await setRow(ana.id, "reminded_at = now(), escalated_at = now(), reminder_count = 2");
    const eligibleBefore = (await ackSummary(id)).eligible;
    assert.equal((await exemptAssignments(null, [ana.id], manager(), { reason: "Contractor", until: null })).changed.length, 1);
    assert.equal((await ackSummary(id)).eligible, eligibleBefore - 1);

    // The policy's own days.
    await pool().query(
      `INSERT INTO policy_settings (document_id, due_days) VALUES ($1, 5)
       ON CONFLICT (document_id) DO UPDATE SET due_days = 5, due_at = NULL`,
      [id]
    );
    const r = await unexemptAssignments(null, [ana.id]);
    assert.equal(r.changed.length, 1);
    assert.equal(r.changed[0].from_at, null);
    assertNear(r.changed[0].to_at, new Date(Date.now() + 5 * DAY), HOUR, "due_at = now + the policy's 5 days");
    let row = await rowOf(id, anaId);
    assert.equal(row.exempt_at, null);
    assert.equal(row.exempt_by, null);
    assert.equal(row.exempt_by_name, "");
    assert.equal(row.exempt_reason, "");
    assert.equal(row.exempt_until, null);
    assert.equal(row.reminded_at, null, "the new deadline gets its own reminders");
    assert.equal(row.escalated_at, null);
    assert.equal(row.reminder_count, 2, "the count is history and stays");
    assert.equal(row.due_at, r.changed[0].to_at);
    assert.equal((await ackSummary(id)).eligible, eligibleBefore, "back in the denominator");
    assert.ok((await compliancePendingUsers(id)).some((u) => u.id === anaId), "and pending again");
    assert.equal(rosterStatus((await ackStatusForDocument(id)).find((x) => x.id === anaId)!), "pending");
    assert.deepEqual(await unexemptAssignments(null, [ana.id]), { changed: [], skipped: [ana.id] }, "not exempt: skipped");

    // The space's days, when the policy sets none.
    await pool().query("UPDATE policy_settings SET due_days = NULL WHERE document_id = $1", [id]);
    await pool().query(`UPDATE spaces SET policy_defaults = '{"due_days": 3}'::jsonb WHERE id = $1`, [spaceId]);
    assert.equal((await exemptAssignments(null, [ana.id], manager(), { reason: "Contractor", until: null })).changed.length, 1);
    assertNear((await unexemptAssignments(null, [ana.id])).changed[0].to_at, new Date(Date.now() + 3 * DAY), HOUR, "now + the space's 3 days");

    // The workspace's days (or the built-in 14) when neither sets one.
    await pool().query(`UPDATE spaces SET policy_defaults = '{}'::jsonb WHERE id = $1`, [spaceId]);
    const fallback = await workspaceDueDaysOrBuiltIn();
    assert.equal((await exemptAssignments(null, [ana.id], manager(), { reason: "Contractor", until: null })).changed.length, 1);
    assertNear((await unexemptAssignments(null, [ana.id])).changed[0].to_at, new Date(Date.now() + fallback * DAY), HOUR, `now + ${fallback} days`);

    // A fixed date still ahead wins over every days rule; one that passed falls back to it.
    await pool().query("UPDATE policy_settings SET due_days = 5, due_at = CURRENT_DATE + 20 WHERE document_id = $1", [id]);
    const fixedDay = (await pool().query<{ day: string }>("SELECT due_at::text AS day FROM policy_settings WHERE document_id = $1", [id])).rows[0].day;
    assert.equal((await exemptAssignments(null, [ana.id], manager(), { reason: "Contractor", until: null })).changed.length, 1);
    const fixed = (await unexemptAssignments(null, [ana.id])).changed[0].to_at!;
    // The one re-arm fragment (dueRearmSql): the fixed day's last instant in
    // the workspace zone, to the millisecond, as the reconcile, the
    // re-confirmation cycle and a moved deadline write it.
    assert.equal(fixed, endOfDayIn(fixedDay, await workspaceZone())!.toISOString(), "the fixed date: its last instant in the workspace zone");
    await pool().query("UPDATE policy_settings SET due_at = CURRENT_DATE - 1 WHERE document_id = $1", [id]);
    assert.equal((await exemptAssignments(null, [ana.id], manager(), { reason: "Contractor", until: null })).changed.length, 1);
    assertNear((await unexemptAssignments(null, [ana.id])).changed[0].to_at, new Date(Date.now() + 5 * DAY), HOUR, "a fixed date in the past: the policy's days");
  });

  test("an exemption with an end date expires in the hourly sweep and the row is re-armed; standing and future exemptions are left alone; a second sweep finds nothing", async () => {
    const { id } = await policy(`${STAMP} expiry`);
    const ana = await rowOf(id, anaId);
    const ben = await rowOf(id, benId);
    const mia = await rowOf(id, miaId);
    await pool().query(
      `INSERT INTO policy_settings (document_id, due_days) VALUES ($1, 4) ON CONFLICT (document_id) DO UPDATE SET due_days = 4, due_at = NULL`,
      [id]
    );
    // The parser refuses a past date on the way in; the sweep's own test sets one directly.
    assert.equal((await exemptAssignments(null, [ana.id], manager(), { reason: "Was on leave", until: "2000-01-01" })).changed.length, 1);
    assert.equal((await exemptAssignments(null, [ben.id], manager(), { reason: "Standing", until: null })).changed.length, 1);
    assert.equal((await exemptAssignments(null, [mia.id], { id: anaId, name: "Ana Ruiz" }, { reason: "Future", until: "2099-01-01" })).changed.length, 1);
    const eligible = (await ackSummary(id)).eligible;

    // The sweep is bounded to this file's policies (complianceHourly passes
    // nothing and sweeps every policy); bounded to another id it clears nothing.
    assert.deepEqual(await expireExemptions({ documentIds: [-1] }), [], "a bound that names no policy here clears nothing");
    assert.ok((await rowOf(id, anaId)).exempt_at, "Ana's dated exemption still stands");
    const expired = await expireExemptions({ documentIds: docIds });
    const mine = expired.filter((e) => e.document_id === id);
    assert.deepEqual(mine.map((e) => e.id), [ana.id], "only the dated exemption that passed");
    assert.equal(mine[0].title, `${STAMP} expiry`);
    assert.equal(mine[0].user_id, anaId);
    assertNear(mine[0].to_at, new Date(Date.now() + 4 * DAY), HOUR, "re-armed from the cascade");
    const row = await rowOf(id, anaId);
    assert.equal(row.exempt_at, null);
    assert.equal(row.exempt_reason, "");
    assert.equal(row.exempt_until, null);
    assert.equal(row.due_at, mine[0].to_at);
    assert.ok((await rowOf(id, benId)).exempt_at, "the standing exemption stays");
    assert.ok((await rowOf(id, miaId)).exempt_at, "the future one stays");
    assert.equal((await ackSummary(id)).eligible, eligible + 1, "Ana is counted again");
    assert.equal((await expireExemptions({ documentIds: docIds })).filter((e) => e.document_id === id).length, 0, "nothing left to expire");
  });
});

describe("extensions", () => {
  test("extend pushes the deadline out from today or the current date, whichever is later; clears the escalation and the snooze; keeps the move in due_history, the last 10", async () => {
    const { id } = await policy(`${STAMP} extend`);
    const ana = await rowOf(id, anaId);
    const ben = await rowOf(id, benId);
    const mia = await rowOf(id, miaId);
    const anaDue = new Date(Date.now() - 3 * DAY);
    const benDue = new Date(Date.now() + 3 * DAY);
    await setRow(ana.id, "due_at = $2, escalated_at = now(), snoozed_until = now() + interval '2 days', snoozed_by = $3", [anaDue.toISOString(), miaId]);
    await setRow(ben.id, "due_at = $2", [benDue.toISOString()]);
    // The reconcile gives every row the cascade's deadline; this row stands for a policy with none.
    await setRow(mia.id, "due_at = NULL");

    const r = await extendAssignments(null, [ana.id, ben.id, mia.id], 7, "  Travelling  ", manager());
    assert.deepEqual(r.skipped, []);
    assert.equal(r.changed.length, 3);
    const byId = new Map(r.changed.map((c) => [c.id, c]));
    assertNear(byId.get(ana.id)!.to_at, new Date(Date.now() + 7 * DAY), HOUR, "overdue: from today");
    assertNear(byId.get(ana.id)!.from_at, anaDue, 1000, "from: the date it had");
    assertNear(byId.get(ben.id)!.to_at, new Date(Date.now() + 10 * DAY), HOUR, "still ahead: from its date");
    assertNear(byId.get(mia.id)!.to_at, new Date(Date.now() + 7 * DAY), HOUR, "no deadline: from today");
    assert.equal(byId.get(mia.id)!.from_at, null);

    const row = await rowOf(id, anaId);
    assert.equal(row.due_at, byId.get(ana.id)!.to_at);
    assert.equal(row.escalated_at, null, "the escalation is re-armed");
    assert.equal(row.snoozed_until, null, "the snooze is cleared");
    assert.equal(row.snoozed_by, null);
    assert.equal(row.due_history.length, 1);
    const entry = row.due_history[0];
    assert.equal(entry.kind, "extend");
    assertNear(entry.from, anaDue, 1000, "due_history.from");
    assert.equal(new Date(entry.to!).getTime(), new Date(row.due_at!).getTime(), "due_history.to is the new date");
    assert.equal(entry.by_name, "Mia Manager", "one shape for every writer: by_id and by_name");
    assert.equal(entry.by_id, miaId);
    assert.deepEqual(Object.keys(entry).sort(), ["at", "by_id", "by_name", "from", "kind", "reason", "to"]);
    assert.equal(entry.reason, "Travelling");
    assertNear(entry.at, new Date(), HOUR, "due_history.at");
    assert.deepEqual((await rowOf(id, miaId)).due_history[0].from, null);

    // The record keeps the last DUE_HISTORY_KEEP moves.
    for (let i = 0; i < DUE_HISTORY_KEEP + 1; i++) {
      assert.equal((await extendAssignments(null, [ben.id], 1, "", manager())).changed.length, 1);
    }
    const history = (await rowOf(id, benId)).due_history;
    assert.equal(history.length, DUE_HISTORY_KEEP);
    assert.equal(new Date(history[history.length - 1].to!).getTime(), new Date((await rowOf(id, benId)).due_at!).getTime(), "the newest move is last");
    assert.ok(history.every((h) => h.kind === "extend"));

    // Bounds and the exempt rule.
    assert.equal(EXTEND_DAYS_MAX, PURE_EXTEND_DAYS_MAX);
    const capped = await extendAssignments(null, [mia.id], 10_000, "", manager());
    assertNear(capped.changed[0].to_at, new Date(new Date(byId.get(mia.id)!.to_at!).getTime() + EXTEND_DAYS_MAX * DAY), HOUR, "clamped to the cap");
    assert.equal((await exemptAssignments(null, [ana.id], manager(), { reason: "Leave", until: null })).changed.length, 1);
    assert.deepEqual(await extendAssignments(null, [ana.id], 7, "", manager()), { changed: [], skipped: [ana.id] }, "an exempt row has no deadline to move");
    assert.deepEqual(await extendAssignments(null, [], 7, "", manager()), { changed: [], skipped: [] });
  });

  test("undo restores the date the extension replaced and pops the entry; a row with nothing of its own to undo is skipped", async () => {
    const { id } = await policy(`${STAMP} undo`);
    const ben = await rowOf(id, benId);
    const mia = await rowOf(id, miaId);
    const benDue = new Date(Date.now() + 3 * DAY);
    await setRow(ben.id, "due_at = $2", [benDue.toISOString()]);
    await setRow(mia.id, "due_at = NULL");
    const extended = (await extendAssignments(null, [ben.id, mia.id], 7, "Conference", manager())).changed;
    const benTo = extended.find((c) => c.id === ben.id)!.to_at!;

    const r = await undoExtension(null, [ben.id, mia.id]);
    assert.deepEqual(r.skipped, []);
    const b = r.changed.find((c) => c.id === ben.id)!;
    assert.equal(new Date(b.from_at!).getTime(), new Date(benTo).getTime(), "from: the date undone");
    assertNear(b.to_at, benDue, 1000, "to: the date restored");
    const row = await rowOf(id, benId);
    assertNear(row.due_at, benDue, 1000, "due_at restored");
    assert.deepEqual(row.due_history, [], "the entry is popped");
    const m = r.changed.find((c) => c.id === mia.id)!;
    assert.equal(m.to_at, null, "a row that had no deadline has none again");
    assert.equal((await rowOf(id, miaId)).due_at, null);

    assert.deepEqual(await undoExtension(null, [ben.id]), { changed: [], skipped: [ben.id] }, "nothing left to undo");
    // A move recorded by another rule (the policy's deadline moved, E1) is not an extension: left alone.
    await setRow(ben.id, `due_history = '[{"kind": "move", "from": null, "to": "2030-01-01T00:00:00Z", "by": "Rule", "at": "2029-01-01T00:00:00Z", "reason": ""}]'::jsonb, due_at = '2030-01-01T00:00:00Z'`);
    assert.deepEqual(await undoExtension(null, [ben.id]), { changed: [], skipped: [ben.id] });
    assert.equal((await rowOf(id, benId)).due_history.length, 1);
  });
});

describe("snooze", () => {
  test("snooze is capped at 30 days and changes nothing but the snooze: the status, the counts, the roster and the CSV cells read exactly as before", async () => {
    const { id } = await policy(`${STAMP} snooze`, { benConfirms: true });
    const ana = await rowOf(id, anaId);
    await setRow(ana.id, "due_at = now() - interval '2 days'");
    const snapshot = async () => {
      const rows = await ackStatusForDocument(id);
      const row = rows.find((x) => x.id === anaId)!;
      const cells = exemptionCsvCells(row);
      return {
        summary: await ackSummary(id),
        doc: (() => {
          const d = snapshotDocs.find((x) => x.id === id)!;
          return { acked: d.acked, required: d.required };
        })(),
        order: rows.map((x) => x.id),
        status: rosterStatus(row),
        row: { ...row, snoozed_until: null },
        cells: [cells[0], cells[1], cells[2], cells[4]],
        pending: (await listPendingAcksFor(anaId, scope())).some((d) => d.id === id),
        count: await countPendingAcksFor(anaId, scope()),
        mine: (await listMyPolicies(anaId, scope())).find((d) => d.id === id)?.state ?? null,
      };
    };
    let snapshotDocs = await complianceDocs();
    const before = await snapshot();
    assert.equal(before.status, "pending");
    assert.equal(before.pending, true);

    assert.equal(SNOOZE_DAYS_MAX, PURE_SNOOZE_DAYS_MAX);
    const r = await snoozeAssignments(null, [ana.id], 45, manager());
    assert.equal(r.changed.length, 1);
    assertNear(r.changed[0].snoozed_until, new Date(Date.now() + SNOOZE_DAYS_MAX * DAY), HOUR, "clamped to 30 days as a last line (the route refuses 45)");
    const row = await rowOf(id, anaId);
    assert.equal(row.snoozed_until, r.changed[0].snoozed_until);
    assert.equal(row.snoozed_by, miaId);

    snapshotDocs = await complianceDocs();
    const after = await snapshot();
    assert.deepEqual(after, before, "nothing but snoozed_until changed");
    const status = (await ackStatusForDocument(id)).find((x) => x.id === anaId)!;
    assert.equal(status.snoozed_until, row.snoozed_until);
    assert.equal(exemptionCsvCells(status)[3], row.snoozed_until, "the CSV's snoozed_until cell");
    assert.equal(snoozeText(status, fmt), `Snoozed until ${fmt(row.snoozed_until!)}`);
    assert.equal(snoozeText(status, fmt, "Mia Manager"), `Snoozed until ${fmt(row.snoozed_until!)} by Mia Manager`);
    assert.equal(snoozeText({ snoozed_until: null }, fmt), "");

    const seven = await snoozeAssignments(null, [ana.id], SNOOZE_DAYS_DEFAULT, manager());
    assertNear(seven.changed[0].snoozed_until, new Date(Date.now() + 7 * DAY), HOUR, "snoozing again replaces the date");

    const un = await unsnoozeAssignments(null, [ana.id]);
    assert.equal(un.changed.length, 1);
    assert.equal((await rowOf(id, anaId)).snoozed_until, null);
    assert.equal((await rowOf(id, anaId)).snoozed_by, null);
    assert.deepEqual(await unsnoozeAssignments(null, [ana.id]), { changed: [], skipped: [ana.id] }, "not snoozed: skipped");

    const ben = await rowOf(id, benId);
    assert.equal((await exemptAssignments(null, [ben.id], manager(), { reason: "Leave", until: null })).changed.length, 1);
    assert.deepEqual(await snoozeAssignments(null, [ben.id], 7, manager()), { changed: [], skipped: [ben.id] }, "an exempt row gets no reminders to pause");
  });
});

describe("the document bound and the request rules", () => {
  test("the twin route's bound: ids of another document are skipped by every lever, and nothing of theirs changes", async () => {
    const a = await policy(`${STAMP} bound A`);
    const b = await policy(`${STAMP} bound B`);
    const benOnB = await rowOf(b.id, benId);
    await setRow(benOnB.id, "due_at = now() + interval '3 days'");
    const before = await rowOf(b.id, benId);

    assert.deepEqual(await exemptAssignments(a.id, [benOnB.id], manager(), { reason: "Leave", until: null }), { changed: [], skipped: [benOnB.id], self: [] });
    assert.deepEqual(await unexemptAssignments(a.id, [benOnB.id]), { changed: [], skipped: [benOnB.id] });
    assert.deepEqual(await extendAssignments(a.id, [benOnB.id], 7, "", manager()), { changed: [], skipped: [benOnB.id] });
    assert.deepEqual(await undoExtension(a.id, [benOnB.id]), { changed: [], skipped: [benOnB.id] });
    assert.deepEqual(await snoozeAssignments(a.id, [benOnB.id], 7, manager()), { changed: [], skipped: [benOnB.id] });
    assert.deepEqual(await unsnoozeAssignments(a.id, [benOnB.id]), { changed: [], skipped: [benOnB.id] });
    assert.deepEqual(await reaskableAssignments(a.id, [benOnB.id]), []);
    assert.deepEqual(await rowOf(b.id, benId), before, "the row on B is untouched");
    // The self rule is bounded the same way: Mia's row on B is not "her own" from A's route; it is simply not A's.
    const miaOnB = await rowOf(b.id, miaId);
    assert.deepEqual(await exemptAssignments(a.id, [miaOnB.id], manager(), { reason: "Leave", until: null }), { changed: [], skipped: [miaOnB.id], self: [] });

    // Bound to its own document, the same id answers.
    const r = await exemptAssignments(b.id, [benOnB.id], manager(), { reason: "Leave", until: null });
    assert.equal(r.changed.length, 1);
    assert.equal(r.changed[0].document_id, b.id);
    assert.equal((await unexemptAssignments(b.id, [benOnB.id])).changed.length, 1);
    assert.equal((await reaskableAssignments(b.id, [benOnB.id])).length, 1);
    // And the twin's answer lists the mix: one of its own, one of another document's.
    const anaOnA = await rowOf(a.id, anaId);
    const mixed = await snoozeAssignments(a.id, [anaOnA.id, benOnB.id], 7, manager());
    assert.deepEqual(mixed.changed.map((c) => c.id), [anaOnA.id]);
    assert.deepEqual(mixed.skipped, [benOnB.id]);
  });

  test("a policy that no longer asks (stopped or retired: ack_required = 0) takes no lever: its ids come back as skipped and nothing of theirs changes", async () => {
    const { id } = await policy(`${STAMP} stopped`);
    const ana = await rowOf(id, anaId);
    const ben = await rowOf(id, benId);
    // Rows in every state a lever could act on: an extension to undo, a
    // snooze to lift, an exemption to remove.
    assert.equal((await extendAssignments(null, [ana.id], 2, "", manager())).changed.length, 1);
    assert.equal((await snoozeAssignments(null, [ana.id], 3, manager())).changed.length, 1);
    assert.equal((await exemptAssignments(null, [ben.id], manager(), { reason: "Leave", until: null })).changed.length, 1);
    await setAckRequired(id, false);
    const anaBefore = await rowOf(id, anaId);
    const benBefore = await rowOf(id, benId);

    assert.deepEqual(await exemptAssignments(null, [ana.id], manager(), { reason: "Leave", until: null }), { changed: [], skipped: [ana.id], self: [] });
    assert.deepEqual(await unexemptAssignments(null, [ben.id]), { changed: [], skipped: [ben.id] });
    assert.deepEqual(await extendAssignments(null, [ana.id], 7, "", manager()), { changed: [], skipped: [ana.id] });
    assert.deepEqual(await undoExtension(null, [ana.id]), { changed: [], skipped: [ana.id] });
    assert.deepEqual(await snoozeAssignments(null, [ana.id], 7, manager()), { changed: [], skipped: [ana.id] });
    assert.deepEqual(await unsnoozeAssignments(null, [ana.id]), { changed: [], skipped: [ana.id] });
    assert.deepEqual(await reaskableAssignments(null, [ana.id]), [], "a re-ask is bounded the same way");
    assert.deepEqual(await rowOf(id, anaId), anaBefore, "Ana's row is untouched");
    assert.deepEqual(await rowOf(id, benId), benBefore, "Ben's exemption stands");

    // Asked again, the same ids answer.
    await pool().query("UPDATE documents SET ack_required = 1 WHERE id = $1", [id]);
    assert.deepEqual((await unsnoozeAssignments(null, [ana.id])).changed.map((c) => c.id), [ana.id]);
    assert.deepEqual((await unexemptAssignments(null, [ben.id])).changed.map((c) => c.id), [ben.id]);
  });

  test("the request rules the routes answer 400 with: the action, the 200-id cap, the days bounds, the exemption reason and date, the re-ask reason", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    const err = (body: unknown) => {
      const p = parseAssignmentRequest(body, now);
      return p.ok ? null : p.error;
    };
    assert.equal(err(null), "Send a JSON object.");
    assert.equal(err([]), "Send a JSON object.");
    assert.equal(err({ action: "waive", assignment_ids: [1] }), "Unknown action.");
    assert.equal(err({ action: "snooze" }), `Send assignment_ids: 1 to ${ASSIGNMENT_IDS_MAX} ids.`);
    assert.equal(err({ action: "snooze", assignment_ids: [] }), `Send assignment_ids: 1 to ${ASSIGNMENT_IDS_MAX} ids.`);
    assert.equal(err({ action: "snooze", assignment_ids: ids(201) }), `Send assignment_ids: 1 to ${ASSIGNMENT_IDS_MAX} ids.`);
    assert.equal(err({ action: "snooze", assignment_ids: ids(200) }), null, "200 is the cap");
    assert.equal(err({ action: "snooze", assignment_ids: [1, "2"] }), "assignment_ids must be positive integers.");
    assert.equal(err({ action: "snooze", assignment_ids: [0] }), "assignment_ids must be positive integers.");
    assert.equal(err({ action: "snooze", assignment_ids: [1.5] }), "assignment_ids must be positive integers.");
    assert.equal(ASSIGNMENT_IDS_MAX, 200);

    const dedup = parseAssignmentRequest({ action: "unsnooze", assignment_ids: [3, 1, 3, 2, 1] }, now);
    assert.ok(dedup.ok);
    assert.deepEqual(dedup.req.ids, [3, 1, 2], "deduped, in the order given");
    assert.equal(dedup.req.days, 0);
    assert.equal(dedup.req.reason, "");
    assert.equal(dedup.req.until, null);

    // exempt: the reason is required and bounded; the date is optional, a calendar date after today.
    assert.equal(err({ action: "exempt", assignment_ids: [1] }), "Enter a reason for the exemption.");
    assert.equal(err({ action: "exempt", assignment_ids: [1], reason: "   " }), "Enter a reason for the exemption.");
    assert.equal(err({ action: "exempt", assignment_ids: [1], reason: "x".repeat(301) }), "Keep the reason under 300 characters.");
    assert.equal(err({ action: "exempt", assignment_ids: [1], reason: "On leave", until: "2026-10-20" }), "Pick a date after today.");
    assert.equal(err({ action: "exempt", assignment_ids: [1], reason: "On leave", until: "2026-02-30" }), "Pick a date after today.");
    assert.equal(err({ action: "exempt", assignment_ids: [1], reason: "On leave", until: "tomorrow" }), "Pick a date after today.");
    assert.equal(err({ action: "exempt", assignment_ids: [1], reason: "On leave", until: 20261201 }), "Pick a date after today.");
    const exempt = parseAssignmentRequest({ action: "exempt", assignment_ids: [1], reason: "  On leave  ", until: "2026-10-21" }, now);
    assert.ok(exempt.ok);
    assert.equal(exempt.req.reason, "On leave");
    assert.equal(exempt.req.until, "2026-10-21");
    const standing = parseAssignmentRequest({ action: "exempt", assignment_ids: [1], reason: "Contractor", until: "" }, now);
    assert.ok(standing.ok && standing.req.until === null, "blank is a standing exemption");

    // extend: 1..365 days, 7 when absent; the reason is optional and cut at 500.
    assert.equal(err({ action: "extend", assignment_ids: [1], days: 0 }), `Extend by 1 to ${PURE_EXTEND_DAYS_MAX} days.`);
    assert.equal(err({ action: "extend", assignment_ids: [1], days: 366 }), `Extend by 1 to ${PURE_EXTEND_DAYS_MAX} days.`);
    assert.equal(err({ action: "extend", assignment_ids: [1], days: 2.5 }), `Extend by 1 to ${PURE_EXTEND_DAYS_MAX} days.`);
    const extend = parseAssignmentRequest({ action: "extend", assignment_ids: [1], days: "14", reason: "x".repeat(600) }, now);
    assert.ok(extend.ok);
    assert.equal(extend.req.days, 14, "a numeric string from a form is accepted");
    assert.equal(extend.req.reason.length, 500);
    const extendDefault = parseAssignmentRequest({ action: "extend", assignment_ids: [1] }, now);
    assert.ok(extendDefault.ok && extendDefault.req.days === EXTEND_DAYS_DEFAULT);

    // snooze: 1..30 days, 7 when absent.
    assert.equal(err({ action: "snooze", assignment_ids: [1], days: 31 }), `Snooze for 1 to ${PURE_SNOOZE_DAYS_MAX} days.`);
    assert.equal(err({ action: "snooze", assignment_ids: [1], days: 45 }), `Snooze for 1 to ${PURE_SNOOZE_DAYS_MAX} days.`);
    assert.equal(err({ action: "snooze", assignment_ids: [1], days: -1 }), `Snooze for 1 to ${PURE_SNOOZE_DAYS_MAX} days.`);
    const snooze = parseAssignmentRequest({ action: "snooze", assignment_ids: [1] }, now);
    assert.ok(snooze.ok && snooze.req.days === SNOOZE_DAYS_DEFAULT);
    assert.ok(parseAssignmentRequest({ action: "snooze", assignment_ids: [1], days: 30 }, now).ok, "30 is the cap");

    // reask: the same reason rule as the whole-audience re-ask.
    assert.equal(REASK_REASON_MIN, ACK_REASON_MIN, "the pure module and the database agree");
    assert.equal(err({ action: "reask", assignment_ids: [1], reason: "short" }), `A reason of at least ${ACK_REASON_MIN} characters is required.`);
    assert.equal(err({ action: "reask", assignment_ids: [1] }), `A reason of at least ${ACK_REASON_MIN} characters is required.`);
    const reask = parseAssignmentRequest({ action: "reask", assignment_ids: [1], reason: "Please read the new travel section" }, now);
    assert.ok(reask.ok && reask.req.reason === "Please read the new travel section");
  });
});

describe("the per-person re-ask through the assignments route (D4)", () => {
  test("rows are grouped by policy; each group restarts only those people's cycle, with the document marker and everyone else untouched; exempt rows are skipped; one audit row per policy", async () => {
    const p = await policy(`${STAMP} reask P`, { benConfirms: true });
    const q = await policy(`${STAMP} reask Q`);
    await recordAcknowledgement(p.id, anaId, "", p.v1);
    await recordAcknowledgement(q.id, anaId, "", q.v1);
    const anaOnP = await rowOf(p.id, anaId);
    const benOnP = await rowOf(p.id, benId);
    const miaOnP = await rowOf(p.id, miaId);
    const anaOnQ = await rowOf(q.id, anaId);
    assert.equal((await exemptAssignments(null, [miaOnP.id], { id: anaId, name: "Ana Ruiz" }, { reason: "Author", until: null })).changed.length, 1);
    const markerP = (await pool().query("SELECT ack_revision_at FROM documents WHERE id = $1", [p.id])).rows[0].ack_revision_at;

    const parsed = parseAssignmentRequest({
      action: "reask",
      assignment_ids: [anaOnP.id, miaOnP.id, anaOnQ.id],
      reason: "Please read the new travel section",
    });
    assert.ok(parsed.ok);
    const outcome = await runAssignmentAction(parsed.req, {
      doc: null,
      actor: manager(),
      audit: { actor: { id: miaId, name: "Mia Manager", role: "approver" }, ip: "203.0.113.9" },
      origin: "https://docs.example.test",
    });
    assert.equal(outcome.status, 200);
    assert.ok(outcome.body && "changed" in outcome.body);
    const body = outcome.body as { changed: number[]; skipped: number[] };
    assert.deepEqual([...body.changed].sort((a, b) => a - b), [anaOnP.id, anaOnQ.id].sort((a, b) => a - b), "Ana's rows on both policies");
    assert.deepEqual(body.skipped, [miaOnP.id], "the exempt row is reported, not re-asked");

    const after = (await pool().query("SELECT ack_revision_at FROM documents WHERE id = $1", [p.id])).rows[0].ack_revision_at;
    assert.equal(after, markerP, "the document marker stays");
    const anaRow = await rowOf(p.id, anaId);
    assert.ok(new Date(anaRow.cycle_started_at).getTime() > new Date(markerP).getTime(), "Ana's cycle restarted");
    assert.equal(anaRow.reminded_at, null);
    assert.equal(new Date((await rowOf(p.id, benId)).cycle_started_at).getTime(), new Date(benOnP.cycle_started_at).getTime(), "Ben's did not");
    const status = await ackStatusForDocument(p.id);
    const ana = status.find((x) => x.id === anaId)!;
    assert.equal(ana.acknowledged_at, null, "her confirmation is stale against her own cycle");
    assert.equal(ana.asked_again_at, anaRow.cycle_started_at);
    assert.equal(rosterStatus(ana), "pending");
    const ben = status.find((x) => x.id === benId)!;
    assert.ok(ben.acknowledged_at, "Ben's confirmation is still current");
    assert.equal(ben.asked_again_at, null);
    assert.ok(await getCurrentAck(p.id, benId));

    const audits = await auditRows("ack.reconfirmation_requested", p.id);
    const mine = audits.filter((a) => a.details.scope === "users");
    assert.equal(mine.length, 1, "one audit row for P");
    assert.deepEqual(mine[0].details.user_ids, [anaId]);
    assert.equal(mine[0].details.reason, "Please read the new travel section");
    assert.equal(mine[0].actor_name, "Mia Manager");
    assert.equal((await auditRows("ack.reconfirmation_requested", q.id)).filter((a) => a.details.scope === "users").length, 1, "and one for Q");

    // The dispatcher's other actions write their rows too: one per row changed, plus the bulk summary.
    const ext = parseAssignmentRequest({ action: "extend", assignment_ids: [anaOnP.id, benOnP.id], days: 3, reason: "Audit week" });
    assert.ok(ext.ok);
    const extended = await runAssignmentAction(ext.req, {
      doc: { id: p.id, title: `${STAMP} reask P` },
      actor: manager(),
      audit: { actor: { id: miaId, name: "Mia Manager", role: "approver" }, ip: null },
      origin: "",
    });
    assert.equal(extended.status, 200);
    const perRow = await auditRows("ack.due_extended", p.id);
    assert.equal(perRow.length, 2);
    assert.equal(perRow[0].details.days, 3);
    assert.equal(perRow[0].details.reason, "Audit week");
    const bulk = await auditRows("ack.bulk_extended", p.id);
    assert.equal(bulk.length, 1);
    assert.equal(bulk[0].details.n, 2);
    assert.equal(bulk[0].details.days, 3);
    const self = parseAssignmentRequest({ action: "exempt", assignment_ids: [miaOnP.id], reason: "Author" });
    assert.ok(self.ok);
    assert.equal((await unexemptAssignments(null, [miaOnP.id])).changed.length, 1);
    const refused = await runAssignmentAction(self.req, {
      doc: null,
      actor: manager(),
      audit: { actor: { id: miaId, name: "Mia Manager", role: "approver" }, ip: null },
      origin: "",
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { error: SELF_EXEMPTION_ERROR });
    assert.equal((await rowOf(p.id, miaId)).exempt_at, null, "and nothing was written");
  });
});

// --- The space-scoped twin on a paused or retired policy ----------------------
// The twin (POST /api/documents/{id}/acknowledgements/actions) answers 400 with
// the sibling reconfirm route's sentence when the policy is paused
// (ack_required = 0) or retired (ack_retired_at set) and writes nothing; live,
// the same request is 200. The handler is called directly, the way
// test/ack-reask.test.ts does it: next/headers resolves to a stub serving the
// request under test (Mia's session cookie; an approver holds
// document.ack_require through the ladder's Approver role) and lib/ee to a
// stub that grants policy_ack. Both are installed in `before`, before the
// route is imported, so nothing above this line is touched.

describe("the space-scoped twin refuses a paused or retired policy", () => {
  const SENTENCE = "This document doesn't ask for a read confirmation.";
  let currentRequest: Request | null = null;
  let route: typeof import("../src/app/api/documents/[id]/acknowledgements/actions/route");
  let session = "";

  before(async () => {
    const Module = (await import("node:module")).default;
    const path = (await import("node:path")).default;
    const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.ack-exempt.virtual.js");
    const EE_STUB = path.join(__dirname, "stubs", "ee.ack-exempt.virtual.js");
    const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
    const jar = () => {
      const out = new Map<string, string>();
      for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
      }
      return out;
    };
    const headers = new Module(HEADERS_STUB);
    headers.filename = HEADERS_STUB;
    headers.loaded = true;
    headers.exports = {
      headers: async () => new Headers(currentRequest?.headers ?? {}),
      cookies: async () => {
        const c = jar();
        return {
          get: (name: string) => (c.has(name) ? { name, value: c.get(name) } : undefined),
          getAll: () => [...c].map(([name, value]) => ({ name, value })),
          has: (name: string) => c.has(name),
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
      if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) return EE_STUB;
      return resolveFilename.call(this, request, parent, ...rest);
    };
    route = await import("../src/app/api/documents/[id]/acknowledgements/actions/route");
    const { createSession } = await import("../src/lib/db");
    const { newToken } = await import("../src/lib/password");
    session = newToken();
    await createSession(session, miaId, new Date(Date.now() + HOUR).toISOString());
  });

  after(async () => {
    await pool().query("DELETE FROM sessions WHERE user_id = $1", [miaId]);
  });

  async function post(docId: number, body: unknown): Promise<{ status: number; body: any }> {
    const req = new Request(`http://localhost/api/documents/${docId}/acknowledgements/actions`, {
      method: "POST",
      headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    });
    currentRequest = req;
    try {
      const res = await route.POST(req, { params: Promise.resolve({ id: String(docId) }) });
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
      currentRequest = null;
    }
  }

  test("every lever answers 400 with the sibling's sentence on a paused policy and on a retired one, and nothing is written; live, the same request is 200", async () => {
    const p = await policy(`${STAMP} twin paused`);
    const ana = await rowOf(p.id, anaId);
    const levers: Record<string, unknown>[] = [
      { action: "exempt", assignment_ids: [ana.id], reason: "On leave" },
      { action: "unexempt", assignment_ids: [ana.id] },
      { action: "extend", assignment_ids: [ana.id], days: 3 },
      { action: "undo_extend", assignment_ids: [ana.id] },
      { action: "snooze", assignment_ids: [ana.id], days: 2 },
      { action: "unsnooze", assignment_ids: [ana.id] },
      { action: "reask", assignment_ids: [ana.id], reason: "Please read the new travel section" },
    ];
    const snapshot = async () => {
      const r = await rowOf(p.id, anaId);
      return { exempt_at: r.exempt_at, due_at: r.due_at, snoozed_until: r.snoozed_until, cycle: r.cycle_started_at, history: JSON.stringify(r.due_history) };
    };

    // Paused: the requirement switched off.
    await setAckRequired(p.id, false, { editDefault: null, recertMonths: null });
    const before = await snapshot();
    for (const body of levers) {
      const r = await post(p.id, body);
      assert.equal(r.status, 400, `${body.action} on a paused policy: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, { error: SENTENCE });
    }
    assert.deepEqual(await snapshot(), before, "nothing was written");
    for (const action of ["ack.exempted", "ack.due_extended", "ack.snoozed", "ack.reconfirmation_requested"]) {
      assert.equal((await auditRows(action, p.id)).length, 0, `no ${action} row`);
    }

    // Retired: the stamp alone refuses, whatever ack_required says.
    await setAckRequired(p.id, true, { editDefault: null, recertMonths: null });
    await pool().query("UPDATE documents SET ack_retired_at = now() WHERE id = $1", [p.id]);
    const retired = await post(p.id, levers[4]);
    assert.equal(retired.status, 400, JSON.stringify(retired.body));
    assert.deepEqual(retired.body, { error: SENTENCE });
    assert.equal((await rowOf(p.id, anaId)).snoozed_until, null);

    // Live again: the same request works.
    await pool().query("UPDATE documents SET ack_retired_at = NULL WHERE id = $1", [p.id]);
    const live = await post(p.id, levers[4]);
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.deepEqual(live.body.changed, [ana.id]);
    assert.ok((await rowOf(p.id, anaId)).snoozed_until, "the snooze was recorded");
    assert.equal((await unsnoozeAssignments(null, [ana.id])).changed.length, 1);
  });
});
