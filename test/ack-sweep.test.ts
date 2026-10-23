// Periodic re-confirmation (G1, 1.12.0): the sweep's one-statement claim
// fires each due cycle once across parallel instances, writes one ledger
// row and one notice, and leaves unpublished, retired and not-yet-due
// policies alone; the first cycle of a newly set interval lands 14 days out
// when the marker is older than the interval; every reset moves the next
// date and a keep leaves it; a switch-on after a stop moves a next date
// that passed meanwhile, as un-retire does; the workspace default interval
// lands on the first switch-on; and the pure rules and copy in
// lib/ack-recert.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-sweep.test.ts

// lib/ee as a licensed build sees it, installed before lib/compliance loads
// (imports run in source order): complianceHourly is gated on the licence.
import "./support/ee-stub";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { edition } from "./support/ee-stub";
import {
  pool,
  getSetting,
  setSetting,
  createDocument,
  setAckRequired,
  setSpaceGroups,
  canSeeSpace,
  recordAcknowledgement,
  getCurrentAck,
  listVersions,
  listAckDecisions,
  pendingAckOutboxFor,
  claimDueRecertifications,
  claimReconfirmation,
  resetAcknowledgements,
  keepAcknowledgements,
  getAckRecert,
  setAckRecert,
  recertAfterResume,
  unretirePolicy,
  RECERT_ACTOR,
} from "../src/lib/db";
import { recertifyDueAcks } from "../src/lib/compliance";
import {
  RECERT_OPTIONS,
  RECERT_GRACE_DAYS,
  RECERT_LEDGER_REASON,
  addMonths,
  nextRecertDate,
  validateRecertPatch,
  recertCadence,
  recertOptionLabel,
  recertStatusLine,
  recertMetaLine,
  recertPortalLine,
  recertCycleSubtitle,
  recertDueWithin,
  recertNoticeSentence,
  isRecertDefault,
} from "../src/lib/ack-recert";
import { fixtureQuery } from "./support/retry";
// E2 (1.13.0): the reminder and escalation sweeps.
import {
  claimAckReminders,
  claimAckEscalations,
  escalationRecipients,
  stampAckReminded,
  ackReminderSummary,
  listApproverIdsForSpace,
  pendingAckOutboxFor as pendingOutboxE2,
} from "../src/lib/db";
import { remindDueAcks, escalateOverdueAcks, sweepDefaults, requestAcknowledgement, complianceHourly } from "../src/lib/compliance";
import {
  nextReminderAt,
  reminderSubtitle,
  daysAgoLabel,
  dueStatusLabel,
  dueNoticeTitle,
  dueNoticeBody,
  dueLine,
  bundleTitle,
  bundleBody,
  bundleList,
  escalationTitle,
  escalationBody,
  escalationList,
} from "../src/lib/ack-remind";
import { switchOn } from "./support/assign";

const STAMP = `acksweep-${Date.now()}`;
const DAY = 86_400_000;

let spaceId = 0;
let readerId = 0;
const docIds: number[] = [];

const TEXT = Array.from({ length: 12 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");

/** A published policy that requires confirmation (no cycle yet) with the reader's confirmation on v1. */
async function confirmedPolicy(title: string): Promise<{ id: number; v1: number }> {
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
  // editDefault null and recertMonths null: leave both columns alone rather
  // than read the workspace settings another test file may be writing.
  await switchOn(doc.id, { editDefault: null, recertMonths: null });
  docIds.push(doc.id);
  const v1 = (await listVersions(doc.id))[0].id;
  await recordAcknowledgement(doc.id, readerId, "", v1);
  return { id: doc.id, v1 };
}

interface RecertRow {
  ack_recert_months: number | null;
  ack_next_recert_at: string | null;
  ack_effective_at: string | null;
  ack_revision_at: string;
  ack_version_id: number | null;
  ack_last_reminded_at: string | null;
}

const recertRow = (id: number) =>
  pool()
    .query<RecertRow>(
      `SELECT ack_recert_months, ack_next_recert_at, ack_effective_at, ack_revision_at, ack_version_id, ack_last_reminded_at
       FROM documents WHERE id = $1`,
      [id]
    )
    .then((r) => r.rows[0]);

/** Give the policy a cycle whose next date has just passed. */
const makeDue = (id: number, months = 12) =>
  pool().query("UPDATE documents SET ack_recert_months = $2, ack_next_recert_at = now() - interval '1 minute' WHERE id = $1", [
    id,
    months,
  ]);

const auditRows = async (id: number) =>
  (
    await pool().query<{ actor_name: string; actor_id: number | null; details: Record<string, unknown> }>(
      "SELECT actor_name, actor_id, details FROM audit_log WHERE action = 'ack.recert' AND target_id = $1 ORDER BY id",
      [String(id)]
    )
  ).rows;

/** |a - b| within `ms`. */
function assertNear(actual: string | null, expected: Date, ms: number, label: string) {
  assert.ok(actual, `${label}: a date is set`);
  const diff = Math.abs(new Date(actual!).getTime() - expected.getTime());
  assert.ok(diff <= ms, `${label}: ${actual} is within ${ms}ms of ${expected.toISOString()} (off by ${diff}ms)`);
}

const manager = () => ({ id: null, name: "Sweep Manager" });

/**
 * Hold the document's row FOR UPDATE on a connection of its own while `run`
 * starts, so every UPDATE `run` issues against the row queues on the lock;
 * release it 300ms later and answer what `run` resolved to. `run` must
 * still be pending when the lock goes: that is what proves the overlap.
 */
async function withRowHeld<T>(id: number, run: () => Promise<T>, label: string): Promise<T> {
  const holder = await pool().connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM documents WHERE id = $1 FOR UPDATE", [id]);
    let settled = false;
    const pending = run();
    pending.then(
      () => void (settled = true),
      () => void (settled = true)
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, `${label}: still queued on the row lock when it is released`);
    await holder.query("COMMIT");
    return await pending;
  } catch (e) {
    await holder.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    holder.release();
  }
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Sweep ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Sweep Reader', $2, 'viewer', 'active') RETURNING id`,
    [`${STAMP}-reader`, `${STAMP}-reader@example.test`]
  );
  readerId = users.rows[0].id;
});

after(async () => {
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = $2", [docIds, readerId]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM audit_log WHERE action = 'ack.recert' AND target_id = ANY($1)", [docIds.map(String)]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = $1", [readerId]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("the re-confirmation sweep", () => {
  test("two sweeps in parallel fire one cycle, one ledger row and one notice; the marker, next date and stamp move; the audit echo is the system's", async () => {
    const title = `${STAMP} parallel`;
    const { id, v1 } = await confirmedPolicy(title);
    await makeDue(id, 12);
    const before = await recertRow(id);
    assert.ok(await getCurrentAck(id, readerId), "the reader is current before the cycle");

    // Two instances' hourly ticks at once, each in its own transaction on
    // the shared pool. A third connection holds the row until both have
    // reached their UPDATE, so the two claims really overlap: the first to
    // get the lock moves the next date, the second re-reads the row as
    // updated (READ COMMITTED), re-evaluates RECERT_DUE and matches nothing.
    const [a, b] = await withRowHeld(
      id,
      () => Promise.all([recertifyDueAcks({ documentIds: [id] }), recertifyDueAcks({ documentIds: [id] })]),
      "two sweeps"
    );
    assert.equal(a.cycles + b.cycles, 1, `one cycle between the two sweeps (${a.cycles} + ${b.cycles})`);

    const decisions = await listAckDecisions(id);
    assert.equal(decisions.length, 1, "one ledger row");
    const [row] = decisions;
    assert.equal(row.outcome, "reset");
    assert.equal(row.source, "recurrence");
    assert.equal(row.reason, RECERT_LEDGER_REASON);
    assert.equal(row.decided_by, null);
    assert.equal(row.decided_by_name, RECERT_ACTOR.name);
    assert.equal(row.version_id, v1, "no newer version: the marker stays on v1");
    assert.equal(row.confirmations_affected, 1, "the reader's confirmation, counted before the move");
    assert.ok((row.eligible ?? 0) >= 1, "at least the reader is eligible");

    const outbox = await pendingAckOutboxFor(id);
    assert.equal(outbox.length, 1, "one notice queued");
    assert.equal(outbox[0].mode, "updated");
    assert.equal(outbox[0].source, "recurrence");
    assert.equal(outbox[0].actor_name, RECERT_ACTOR.name);
    assert.equal(outbox[0].reason, recertNoticeSentence(12, title), "people read the months-since sentence");
    assert.ok(new Date(outbox[0].not_before).getTime() <= Date.now() + 1000, "a recurrence notice goes out at once");

    const after = await recertRow(id);
    assert.ok(new Date(after.ack_revision_at).getTime() > new Date(before.ack_revision_at).getTime(), "the marker moved");
    assert.equal(after.ack_version_id, v1);
    assertNear(after.ack_next_recert_at, addMonths(new Date(), 12), 60_000, "the next date is now + 12 months");
    assertNear(after.ack_last_reminded_at, new Date(), 60_000, "the reminder stamp starts the hour's cooldown");
    assert.equal(after.ack_recert_months, 12, "the interval is untouched");
    assert.equal(await getCurrentAck(id, readerId), undefined, "the reader's confirmation went stale");

    const audit = await auditRows(id);
    assert.equal(audit.length, 1, "one ack.recert audit row from the sweep");
    assert.equal(audit[0].actor_name, "system");
    assert.equal(audit[0].actor_id, null);
    assert.equal(audit[0].details.reset, 1);
    assert.ok(Number(audit[0].details.eligible) >= 1);
    assert.equal(audit[0].details.version_id, v1);
    assert.equal(audit[0].details.source, "recurrence");

    // Straight after, nothing is due: the claim moved the column it tests.
    const again = await recertifyDueAcks({ documentIds: [id] });
    assert.equal(again.cycles, 0);
    assert.equal((await listAckDecisions(id)).length, 1, "still one ledger row");
    assert.equal((await pendingAckOutboxFor(id)).length, 1, "still one notice");
  });

  test("a rollback leaves no marker, no row and no notice; a policy without a cycle and one not yet due are left alone", async () => {
    const { id } = await confirmedPolicy(`${STAMP} rollback`);
    await makeDue(id, 6);
    const before = await recertRow(id);
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const cycles = await claimDueRecertifications(client, { documentIds: [id] });
      assert.equal(cycles.length, 1);
      assert.equal(cycles[0].recert_months, 6);
      assert.equal(cycles[0].confirmations_reset, 1);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.deepEqual(await recertRow(id), before, "the row is as it was");
    assert.equal((await listAckDecisions(id)).length, 0);
    assert.equal((await pendingAckOutboxFor(id)).length, 0);
    assert.ok(await getCurrentAck(id, readerId), "the confirmation still counts");

    // Not yet due: nothing happens. No interval: nothing happens.
    await pool().query("UPDATE documents SET ack_next_recert_at = now() + interval '1 day' WHERE id = $1", [id]);
    assert.equal((await recertifyDueAcks({ documentIds: [id] })).cycles, 0, "a cycle due tomorrow waits");
    const { id: plain } = await confirmedPolicy(`${STAMP} no cycle`);
    await pool().query("UPDATE documents SET ack_next_recert_at = now() - interval '1 day' WHERE id = $1", [plain]);
    assert.equal((await recertifyDueAcks({ documentIds: [plain] })).cycles, 0, "a stale next date without an interval fires nothing");
  });

  test("a cycle due while the document is unpublished waits, and fires once it is published again", async () => {
    const { id } = await confirmedPolicy(`${STAMP} unpublished`);
    await makeDue(id, 12);
    await pool().query("UPDATE documents SET status = 'draft' WHERE id = $1", [id]);
    const before = await recertRow(id);
    assert.equal((await recertifyDueAcks({ documentIds: [id] })).cycles, 0, "a paused policy is not asked");
    assert.deepEqual(await recertRow(id), before, "nothing moved");
    assert.equal((await listAckDecisions(id)).length, 0);

    await pool().query("UPDATE documents SET status = 'published' WHERE id = $1", [id]);
    assert.equal((await recertifyDueAcks({ documentIds: [id] })).cycles, 1, "published again: the cycle fires");
    assert.equal((await listAckDecisions(id)).length, 1);
  });

  test("a retired policy waits, with the requirement on or off, cannot be switched on, and un-retire moves a cycle that fell due meanwhile; a trashed or branch document is never asked", async () => {
    const { id } = await confirmedPolicy(`${STAMP} retired`);
    await makeDue(id, 12);
    await pool().query("UPDATE documents SET ack_retired_at = now(), ack_required = 0 WHERE id = $1", [id]);
    assert.equal((await recertifyDueAcks({ documentIds: [id] })).cycles, 0, "retired and off");
    // No path switches a retired policy on: the claim's WHERE refuses it.
    const on = await setAckRequired(id, true, { editDefault: null, recertMonths: null });
    assert.equal(on.switched_on, false, "a retired policy does not switch on");
    assert.equal((await pool().query("SELECT ack_required FROM documents WHERE id = $1", [id])).rows[0].ack_required, 0);
    await pool().query("UPDATE documents SET ack_required = 1 WHERE id = $1", [id]);
    assert.equal((await recertifyDueAcks({ documentIds: [id] })).cycles, 0, "retired with the requirement still on");
    await pool().query("UPDATE documents SET ack_required = 0 WHERE id = $1", [id]);

    // Un-retire: the cycle that fell due while retired is pushed out a whole
    // interval instead of firing the day the policy comes back.
    const resumed = await unretirePolicy(id);
    assert.ok(resumed, "un-retired");
    const back = await recertRow(id);
    assertNear(back.ack_next_recert_at, addMonths(new Date(), 12), 60_000, "the next date is now + interval");
    assert.equal(back.ack_recert_months, 12);
    assert.equal((await recertifyDueAcks({ documentIds: [id] })).cycles, 0, "nothing fires on resume");
    assert.equal((await listAckDecisions(id)).length, 0, "no ledger row either");

    // recertAfterResume on its own: a date still ahead and a policy without a cycle are untouched.
    const ahead = new Date(Date.now() + 10 * DAY).toISOString();
    await pool().query("UPDATE documents SET ack_next_recert_at = $2 WHERE id = $1", [id, ahead]);
    assert.equal(await recertAfterResume(id), ahead, "a future date stands");
    const { id: plainResume } = await confirmedPolicy(`${STAMP} resume no cycle`);
    assert.equal(await recertAfterResume(plainResume), null, "no cycle: nothing to move");
    assert.equal(await recertAfterResume(-1), null, "a document that is gone");

    // A stale date left by hand still fires once the policy is live again.
    await makeDue(id, 12);
    assert.equal((await recertifyDueAcks({ documentIds: [id] })).cycles, 1, "live with a due date: the cycle fires");

    const { id: trashed } = await confirmedPolicy(`${STAMP} trashed`);
    await makeDue(trashed, 12);
    await pool().query("UPDATE documents SET deleted_at = now() WHERE id = $1", [trashed]);
    assert.equal((await recertifyDueAcks({ documentIds: [trashed] })).cycles, 0, "a trashed policy waits");
    await pool().query("UPDATE documents SET deleted_at = NULL, branch_of = $2 WHERE id = $1", [trashed, id]);
    assert.equal((await recertifyDueAcks({ documentIds: [trashed] })).cycles, 0, "a branch is never asked");
    await pool().query("UPDATE documents SET branch_of = NULL WHERE id = $1", [trashed]);
  });
});

describe("the stored next date", () => {
  test("setting an interval on a policy whose marker is older than the interval schedules the first cycle 14 days out, not at the next tick", async () => {
    const { id } = await confirmedPolicy(`${STAMP} stale marker`);
    await pool().query("UPDATE documents SET ack_revision_at = now() - interval '7 months' WHERE id = $1", [id]);
    const r = await setAckRecert(id, { recert_months: 6 });
    assert.ok(r);
    assert.equal(r!.ack_recert_months, 6);
    assertNear(r!.ack_next_recert_at, new Date(Date.now() + RECERT_GRACE_DAYS * DAY), 60_000, "the first cycle is 14 days out");
    assert.equal((await recertifyDueAcks({ documentIds: [id] })).cycles, 0, "nothing fires at the next tick");
    assert.equal((await listAckDecisions(id)).length, 0);
  });

  test("a fresh marker dates the first cycle marker + N months; an explicit next date is kept; clearing the interval clears the date; the effective date is its own field", async () => {
    const { id } = await confirmedPolicy(`${STAMP} fresh marker`);
    const before = await getAckRecert(id);
    assert.ok(before);
    assert.deepEqual(
      [before!.ack_recert_months, before!.ack_next_recert_at],
      [null, null],
      "a policy switched on with recertMonths null has no cycle"
    );

    const twelve = await setAckRecert(id, { recert_months: 12 });
    assertNear(twelve!.ack_next_recert_at, addMonths(new Date(before!.ack_revision_at), 12), 1000, "marker + 12 months");

    // The interval changes without a date: rescheduled from the marker.
    const six = await setAckRecert(id, { recert_months: 6 });
    assertNear(six!.ack_next_recert_at, addMonths(new Date(before!.ack_revision_at), 6), 1000, "marker + 6 months");

    // A date sent with the interval is stored as sent.
    const chosen = new Date(Date.now() + 45 * DAY).toISOString();
    const dated = await setAckRecert(id, { recert_months: 6, next_recert_at: chosen });
    assert.equal(dated!.ack_next_recert_at, chosen);
    // The same interval saved again without a date keeps the chosen one.
    const kept = await setAckRecert(id, { recert_months: 6 });
    assert.equal(kept!.ack_next_recert_at, chosen);
    // Clearing the date while the interval stands reschedules from the marker.
    const cleared = await setAckRecert(id, { next_recert_at: null });
    assertNear(cleared!.ack_next_recert_at, addMonths(new Date(before!.ack_revision_at), 6), 1000, "cleared: marker + 6 months again");

    // Never: no next date, whatever was sent with it.
    const never = await setAckRecert(id, { recert_months: null, next_recert_at: chosen });
    assert.deepEqual([never!.ack_recert_months, never!.ack_next_recert_at], [null, null]);
    // A date on a policy with no interval is not stored.
    const dateless = await setAckRecert(id, { next_recert_at: chosen });
    assert.equal(dateless!.ack_next_recert_at, null);

    const effective = await setAckRecert(id, { effective_at: "2026-01-01" });
    assert.equal(effective!.ack_effective_at, "2026-01-01", "a date column reads back as its text");
    const stillThere = await setAckRecert(id, { recert_months: 12 });
    assert.equal(stillThere!.ack_effective_at, "2026-01-01", "untouched by a patch that does not name it");
    assert.equal((await setAckRecert(id, { effective_at: null }))!.ack_effective_at, null);
    assert.equal(await setAckRecert(-1, { recert_months: 12 }), undefined, "a document that is gone");
    assert.equal((await recertRow(id)).ack_effective_at, null, "the Document row reads the same text, not a Date object");
  });

  test("every reset moves the next date to now + interval, a manual re-ask too, a keep leaves it, and a policy without a cycle stays without one", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} reset moves next`);
    await setAckRecert(id, { recert_months: 12 });
    const soon = () => pool().query("UPDATE documents SET ack_next_recert_at = now() + interval '1 month' WHERE id = $1", [id]);
    const decision = (source: "edit" | "manual", reason: string) => ({ versionId: v1, actor: manager(), source, reason });

    await soon();
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await resetAcknowledgements(client, id, decision("edit", "Material change: the scope grew"));
      await client.query("COMMIT");
      assertNear((await recertRow(id)).ack_next_recert_at, addMonths(new Date(), 12), 60_000, "a reset restarts the interval");

      await soon();
      await client.query("BEGIN");
      await keepAcknowledgements(client, id, decision("edit", "Editorial fix: a typo"));
      await client.query("COMMIT");
      assertNear((await recertRow(id)).ack_next_recert_at, addMonths(new Date(), 1), 60_000, "a keep leaves the next date alone");
    } finally {
      client.release();
    }

    await soon();
    const claim = await claimReconfirmation(null, id, { source: "manual", reason: "Out-of-band event: re-read it", actor: manager() });
    assert.equal(claim.claimed, true);
    assertNear((await recertRow(id)).ack_next_recert_at, addMonths(new Date(), 12), 60_000, "a manual re-ask restarts the interval");

    const { id: plain, v1: plainV1 } = await confirmedPolicy(`${STAMP} no cycle reset`);
    const own = await pool().connect();
    try {
      await own.query("BEGIN");
      await resetAcknowledgements(own, plain, { versionId: plainV1, actor: manager(), source: "edit", reason: "Material change" });
      await own.query("COMMIT");
    } finally {
      own.release();
    }
    assert.deepEqual([(await recertRow(plain)).ack_recert_months, (await recertRow(plain)).ack_next_recert_at], [null, null]);
  });

  test("a switch-on after a stop moves a next date that passed meanwhile to now + interval (un-retire's rule), so no cycle fires on top of the request; a date still ahead stands", async () => {
    const { id } = await confirmedPolicy(`${STAMP} stop and request`);
    await setAckRecert(id, { recert_months: 12 });
    await setAckRequired(id, false);
    // The cycle fell due while the requirement was off: the sweep leaves a
    // stopped policy alone, so the date is simply stale when it comes back.
    await pool().query("UPDATE documents SET ack_next_recert_at = now() - interval '1 minute' WHERE id = $1", [id]);
    assert.equal((await recertifyDueAcks({ documentIds: [id] })).cycles, 0, "stopped: the sweep waits");
    const on = await setAckRequired(id, true, { editDefault: null, recertMonths: null });
    assert.equal(on.switched_on, true);
    const row = await recertRow(id);
    assert.equal(row.ack_recert_months, 12, "the policy's own interval stands");
    assertNear(row.ack_next_recert_at, addMonths(new Date(), 12), 60_000, "the stale date moved out a whole interval");
    assert.equal((await recertifyDueAcks({ documentIds: [id] })).cycles, 0, "nothing fires at the next tick");
    assert.equal((await listAckDecisions(id)).length, 0, "no ledger row");
    assert.equal((await pendingAckOutboxFor(id)).length, 0, "no notice");

    // Off and on with a date still ahead: untouched.
    const ahead = new Date(Date.now() + 10 * DAY).toISOString();
    await pool().query("UPDATE documents SET ack_next_recert_at = $2 WHERE id = $1", [id, ahead]);
    await setAckRequired(id, false);
    assert.equal((await setAckRequired(id, true, { editDefault: null, recertMonths: null })).switched_on, true);
    assert.equal((await recertRow(id)).ack_next_recert_at, ahead, "a future date stands");
  });
});

describe("the workspace default interval on the first switch-on", () => {
  /** The advisory lock the settings-touching describes share with test/compliance-settings.test.ts. */
  const SETTINGS_LOCK = 728342;
  let lockClient: PoolClient | null = null;
  let savedDefaults: string | undefined;

  before(async () => {
    const client = await pool().connect();
    await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
    lockClient = client;
    savedDefaults = await getSetting("ack_defaults");
  });
  after(async () => {
    if (savedDefaults === undefined) await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");
    else await setSetting("ack_defaults", savedDefaults);
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
      lockClient.release();
    }
  });

  async function newPolicy(title: string): Promise<number> {
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
    return doc.id;
  }

  function assertToday(eff: string | null, label: string) {
    assert.ok(eff && /^\d{4}-\d{2}-\d{2}$/.test(eff), `${label}: a date as text (${eff})`);
    assert.ok(Math.abs(Date.parse(eff!) - Date.now()) < 36 * 3_600_000, `${label}: today (${eff})`);
  }

  test("a policy receives the default interval and today's effective date when first switched on; its own choice survives an off-and-on; never means no cycle", async () => {
    await setSetting("ack_defaults", JSON.stringify({ edit_default: "ask", recert_months: 12 }));
    const id = await newPolicy(`${STAMP} default twelve`);
    const on = await setAckRequired(id, true, { editDefault: null });
    assert.equal(on.switched_on, true);
    const row = await recertRow(id);
    assert.equal(row.ack_recert_months, 12, "the workspace interval");
    assertNear(row.ack_next_recert_at, addMonths(new Date(), 12), 60_000, "the first cycle is now + 12 months");
    assertToday(row.ack_effective_at, "the effective date");

    // Off and on again: the policy's own interval, date and effective date stand.
    await setAckRecert(id, { recert_months: 6, next_recert_at: new Date(Date.now() + 30 * DAY).toISOString(), effective_at: "2025-06-01" });
    const own = await recertRow(id);
    await setAckRequired(id, false);
    await setSetting("ack_defaults", JSON.stringify({ recert_months: 24 }));
    assert.equal((await setAckRequired(id, true, { editDefault: null })).switched_on, true);
    const back = await recertRow(id);
    assert.equal(back.ack_recert_months, 6, "the policy's own interval, not the new default");
    assert.equal(back.ack_next_recert_at, own.ack_next_recert_at, "its next date");
    assert.equal(back.ack_effective_at, "2025-06-01", "its effective date, set once");

    // Never: no cycle, still dated.
    await setSetting("ack_defaults", JSON.stringify({ recert_months: null }));
    const quiet = await newPolicy(`${STAMP} default never`);
    await switchOn(quiet, { editDefault: null });
    const q = await recertRow(quiet);
    assert.deepEqual([q.ack_recert_months, q.ack_next_recert_at], [null, null]);
    assertToday(q.ack_effective_at, "dated even without a cycle");

    // A value the build does not offer reads as never; an explicit option applies instead of the workspace's; null leaves the columns alone.
    await setSetting("ack_defaults", JSON.stringify({ recert_months: 7 }));
    const seven = await newPolicy(`${STAMP} default seven`);
    await switchOn(seven, { editDefault: null });
    assert.equal((await recertRow(seven)).ack_recert_months, null, "7 is not an option: no cycle");
    await setSetting("ack_defaults", JSON.stringify({ recert_months: 24 }));
    const explicit = await newPolicy(`${STAMP} explicit six`);
    await switchOn(explicit, { editDefault: null, recertMonths: 6 });
    assert.equal((await recertRow(explicit)).ack_recert_months, 6);
    const alone = await newPolicy(`${STAMP} left alone`);
    await switchOn(alone, { editDefault: null, recertMonths: null });
    assert.equal((await recertRow(alone)).ack_recert_months, null, "recertMonths null never reads the workspace");
    assertToday((await recertRow(alone)).ack_effective_at, "but the switch-on still dates it");
  });
});

describe("lib/ack-recert (pure)", () => {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

  test("the options, the default check and the cadence words", () => {
    assert.deepEqual(
      RECERT_OPTIONS.map((o) => [o.months, o.label]),
      [
        [null, "Never"],
        [6, "6 months"],
        [12, "12 months"],
        [24, "24 months"],
      ]
    );
    assert.ok(isRecertDefault(null) && isRecertDefault(6) && isRecertDefault(12) && isRecertDefault(24));
    assert.ok(!isRecertDefault(7) && !isRecertDefault("12") && !isRecertDefault(undefined));
    assert.equal(recertCadence(12), "yearly");
    assert.equal(recertCadence(6), "every 6 months");
    assert.equal(recertCadence(24), "every 2 years");
    assert.equal(recertCadence(1), "every month");
    assert.equal(recertCadence(18), "every 18 months");
    assert.equal(recertOptionLabel(null), "Never");
    assert.equal(recertOptionLabel(12), "12 months");
    assert.equal(recertOptionLabel(18), "18 months");
    assert.equal(recertOptionLabel(1), "1 month");
  });

  test("addMonths clamps the day like make_interval; nextRecertDate is marker + N months, or now + 14 days when that is past", () => {
    assert.equal(addMonths(new Date("2026-01-31T09:00:00Z"), 1).toISOString(), "2026-02-28T09:00:00.000Z");
    assert.equal(addMonths(new Date("2024-01-31T09:00:00Z"), 1).toISOString(), "2024-02-29T09:00:00.000Z");
    assert.equal(addMonths(new Date("2026-03-15T09:00:00Z"), 12).toISOString(), "2027-03-15T09:00:00.000Z");
    assert.equal(addMonths(new Date("2026-11-30T09:00:00Z"), 3).toISOString(), "2027-02-28T09:00:00.000Z");

    const now = new Date("2026-10-19T12:00:00Z");
    assert.equal(nextRecertDate(new Date("2026-03-01T08:00:00Z"), 12, now).toISOString(), "2027-03-01T08:00:00.000Z");
    assert.equal(nextRecertDate(new Date("2025-03-01T08:00:00Z"), 12, now).toISOString(), "2026-11-02T12:00:00.000Z", "already past: 14 days out");
    assert.equal(nextRecertDate(new Date("2026-04-19T12:00:00Z"), 6, now).toISOString(), "2026-11-02T12:00:00.000Z", "exactly now counts as past");
  });

  test("validateRecertPatch: months 1..60 or null, a next date not in the past, an effective date; the first problem is named", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    const ok = (body: unknown) => {
      const r = validateRecertPatch(body, now);
      assert.equal(r.ok, true, JSON.stringify(body));
      return r.ok ? r.patch : {};
    };
    const refused = (body: unknown, fragment: string) => {
      const r = validateRecertPatch(body, now);
      assert.equal(r.ok, false, `${JSON.stringify(body)} should be refused`);
      if (!r.ok) assert.match(r.error, new RegExp(fragment), `${JSON.stringify(body)}: ${r.error}`);
    };

    assert.deepEqual(ok({}), {}, "nothing named, nothing changed");
    assert.deepEqual(ok({ statement: "ignored here" }), {}, "other fields are another validator's");
    assert.deepEqual(ok({ recert_months: 12 }), { recert_months: 12 });
    assert.deepEqual(ok({ recert_months: 7 }), { recert_months: 7 }, "a policy may choose any whole number of months");
    assert.deepEqual(ok({ recert_months: 1 }), { recert_months: 1 });
    assert.deepEqual(ok({ recert_months: 60 }), { recert_months: 60 });
    assert.deepEqual(ok({ recert_months: null }), { recert_months: null });
    refused({ recert_months: 0 }, "1 to 60 months");
    refused({ recert_months: 61 }, "1 to 60 months");
    refused({ recert_months: 12.5 }, "1 to 60 months");
    refused({ recert_months: "12" }, "1 to 60 months");
    refused({ recert_months: undefined }, "1 to 60 months");

    assert.deepEqual(ok({ next_recert_at: "2027-01-01" }), { next_recert_at: "2027-01-01T00:00:00.000Z" }, "a date input is midnight UTC");
    assert.deepEqual(ok({ next_recert_at: "2026-10-19" }), { next_recert_at: "2026-10-19T00:00:00.000Z" }, "today is not in the past");
    assert.deepEqual(ok({ next_recert_at: "2026-10-19T12:30:00.000Z" }), { next_recert_at: "2026-10-19T12:30:00.000Z" });
    assert.deepEqual(ok({ next_recert_at: null }), { next_recert_at: null });
    assert.deepEqual(ok({ next_recert_at: "" }), { next_recert_at: null }, "a cleared input");
    refused({ next_recert_at: "2026-10-18" }, "cannot be in the past");
    refused({ next_recert_at: "2026-10-19T10:00:00Z" }, "cannot be in the past");
    refused({ next_recert_at: "2026-02-31" }, "as a date");
    refused({ next_recert_at: "soon" }, "as a date");
    refused({ next_recert_at: 20270101 }, "as a date");

    assert.deepEqual(ok({ effective_at: "2026-01-01" }), { effective_at: "2026-01-01" });
    assert.deepEqual(ok({ effective_at: "2026-01-01T15:00:00Z" }), { effective_at: "2026-01-01" }, "a timestamp keeps its date");
    assert.deepEqual(ok({ effective_at: "2020-01-01" }), { effective_at: "2020-01-01" }, "the past is fine for an effective date");
    assert.deepEqual(ok({ effective_at: null }), { effective_at: null });
    refused({ effective_at: "January" }, "effective date as a date");
    refused({ effective_at: "2026-13-01" }, "effective date as a date");

    assert.deepEqual(ok({ recert_months: 6, next_recert_at: "2027-04-01", effective_at: "2026-01-01" }), {
      recert_months: 6,
      next_recert_at: "2027-04-01T00:00:00.000Z",
      effective_at: "2026-01-01",
    });
    refused({ recert_months: 6, next_recert_at: "2020-01-01" }, "cannot be in the past");
    refused(null, "JSON object");
    refused([], "JSON object");
  });

  test("the copy: the popover status line, the AckCard meta line, the portal row, the KPI window and the notice sentence", () => {
    const doc = { ack_recert_months: 12, ack_next_recert_at: "2027-01-01T00:00:00.000Z", ack_effective_at: "2026-01-01" };
    assert.equal(recertStatusLine(doc, fmt), "Re-confirm yearly · next 1 Jan 2027");
    assert.equal(recertStatusLine({ ...doc, ack_recert_months: 6 }, fmt), "Re-confirm every 6 months · next 1 Jan 2027");
    assert.equal(recertStatusLine({ ...doc, ack_next_recert_at: null }, fmt), "Re-confirm yearly");
    assert.equal(recertStatusLine({ ...doc, ack_recert_months: null }, fmt), null, "no cycle: no line");

    assert.equal(recertMetaLine(doc, fmt), "Effective 1 Jan 2026 · re-confirm yearly");
    assert.equal(recertMetaLine({ ...doc, ack_recert_months: null }, fmt), "Effective 1 Jan 2026");
    assert.equal(recertMetaLine({ ...doc, ack_effective_at: null }, fmt), "re-confirm yearly");
    assert.equal(recertMetaLine({ ack_recert_months: null, ack_next_recert_at: null, ack_effective_at: null }, fmt), null);

    assert.equal(recertPortalLine(doc, fmt), "Next re-confirmation 1 Jan 2027");
    assert.equal(recertPortalLine({ ...doc, ack_recert_months: null }, fmt), null);
    assert.equal(recertCycleSubtitle(4, 12), "Cycle 4 · annual");
    assert.equal(recertCycleSubtitle(2, 6), "Cycle 2 · every 6 months");
    assert.equal(recertCycleSubtitle(1, null), "Cycle 1");

    const now = new Date("2026-12-10T00:00:00Z");
    assert.equal(recertDueWithin(doc, 30, now), true, "22 days out is within 30");
    assert.equal(recertDueWithin(doc, 14, now), false);
    assert.equal(recertDueWithin({ ...doc, ack_recert_months: null }, 365, now), false);

    assert.equal(
      recertNoticeSentence(12, "Expense policy"),
      'Annual re-confirmation: it has been 12 months since you confirmed "Expense policy". Please read it again and confirm.'
    );
    assert.equal(recertNoticeSentence(1, "Expense policy"), 'Annual re-confirmation: it has been 1 month since you confirmed "Expense policy". Please read it again and confirm.');
    for (const s of [recertStatusLine(doc, fmt)!, recertMetaLine(doc, fmt)!, recertNoticeSentence(6, "x")]) {
      assert.ok(!s.includes("—") && !/attest/i.test(s), `glossary: ${s}`);
    }
  });
});

// --- E2 (1.13.0): the reminder and escalation sweeps ------------------------------
//
// The claims are one statement each (FOR UPDATE SKIP LOCKED in the subquery,
// the UPDATE stamping the column its WHERE tests), the cadence is resolved
// per policy (policy_settings -> the space's policy_defaults -> the numbers
// the sweep passes), and the claimed people go to the outbox one row per
// policy. The deliveries themselves are test/ack-outbox.test.ts's.

describe("the reminder sweep (E2)", () => {
  const E2 = `${STAMP}-e2`;
  /** The workspace-resolved numbers every claim here takes (nothing is read from the shared settings row). */
  const D = sweepDefaults({ remind_before_days: 3, remind_every_days: 7, escalate_after_days: 7, nudge_every_days: 0, overdue_grace_days: 0 });
  const people: Record<string, number> = {};
  const userIds: number[] = [];
  const e2Docs: number[] = [];
  let privateSpace = 0;
  let teamGroup = 0;
  /** The group granted on the private space: the owner and the requester can see it; the leads and the overdue people cannot. */
  let scopeGroup = 0;

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const daysFromNow = (d: number) => new Date(Date.now() + d * DAY).toISOString();

  async function person(tag: string, role = "viewer", status = "active"): Promise<number> {
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [`${E2}-${tag}`, `Sweep ${tag}`, `${E2}-${tag}@example.test`, role, status]
    );
    people[tag] = r.rows[0].id;
    userIds.push(r.rows[0].id);
    return r.rows[0].id;
  }

  /** A live policy with no rows yet (the switch-on reconciles everyone who can see the space; each test assigns exactly the rows it needs). */
  async function policy(title: string, space = privateSpace): Promise<number> {
    const doc = await createDocument({
      space_id: space,
      title: `${E2} ${title}`,
      type: "policy",
      status: "published",
      content: TEXT,
      summary: "",
      tags: [],
      author: "test",
    });
    await switchOn(doc.id, { editDefault: null, recertMonths: null });
    await pool().query("DELETE FROM policy_assignments WHERE document_id = $1", [doc.id]);
    docIds.push(doc.id);
    e2Docs.push(doc.id);
    return doc.id;
  }

  interface RowState {
    dueAt?: string | null;
    remindedAt?: string | null;
    escalatedAt?: string | null;
    snoozedUntil?: string | null;
    exempt?: boolean;
    removed?: boolean;
  }

  /** One assignment row as the test needs it (the reconcile may have written one: it is overwritten). */
  async function assign(docId: number, userId: number, s: RowState = {}): Promise<void> {
    await fixtureQuery(
      `INSERT INTO policy_assignments
         (document_id, user_id, source, cycle_started_at, due_at, reminded_at, reminder_count, escalated_at, snoozed_until,
          exempt_at, exempt_by_name, exempt_reason, removed_at, removed_reason)
       SELECT d.id, $2, 'space', d.ack_revision_at, $3::timestamptz, $4::timestamptz,
              CASE WHEN $4::timestamptz IS NULL THEN 0 ELSE 1 END, $5::timestamptz, $6::timestamptz,
              CASE WHEN $7::boolean THEN now() END, CASE WHEN $7::boolean THEN 'Sweep Manager' ELSE '' END,
              CASE WHEN $7::boolean THEN 'On leave' ELSE '' END,
              CASE WHEN $8::boolean THEN now() END, CASE WHEN $8::boolean THEN 'left_group' ELSE '' END
       FROM documents d WHERE d.id = $1
       ON CONFLICT (document_id, user_id) DO UPDATE SET
         cycle_started_at = EXCLUDED.cycle_started_at, due_at = EXCLUDED.due_at,
         reminded_at = EXCLUDED.reminded_at, reminder_count = EXCLUDED.reminder_count, escalated_at = EXCLUDED.escalated_at,
         snoozed_until = EXCLUDED.snoozed_until,
         exempt_at = EXCLUDED.exempt_at, exempt_by_name = EXCLUDED.exempt_by_name, exempt_reason = EXCLUDED.exempt_reason,
         removed_at = EXCLUDED.removed_at, removed_reason = EXCLUDED.removed_reason`,
      [docId, userId, s.dueAt ?? null, s.remindedAt ?? null, s.escalatedAt ?? null, s.snoozedUntil ?? null, s.exempt === true, s.removed === true]
    );
  }

  interface Row {
    reminded_at: string | null;
    reminder_count: number;
    escalated_at: string | null;
  }
  const row = async (docId: number, userId: number): Promise<Row> =>
    (
      await pool().query<Row>(
        "SELECT reminded_at, reminder_count, escalated_at FROM policy_assignments WHERE document_id = $1 AND user_id = $2",
        [docId, userId]
      )
    ).rows[0];

  async function setPolicySettings(docId: number, s: Record<string, number | null>): Promise<void> {
    const keys = Object.keys(s);
    await fixtureQuery(
      `INSERT INTO policy_settings (document_id, ${keys.join(", ")}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")})
       ON CONFLICT (document_id) DO UPDATE SET ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(", ")}`,
      [docId, ...keys.map((k) => s[k])]
    );
  }

  const audits = async (action: string, docId: number) =>
    (
      await pool().query<{ actor_name: string; actor_id: number | null; details: Record<string, unknown> }>(
        "SELECT actor_name, actor_id, details FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
        [action, String(docId)]
      )
    ).rows;

  before(async () => {
    const sp = await fixtureQuery(
      `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id`,
      [`Ack Sweep Private ${STAMP}`, `${STAMP}-private`]
    );
    privateSpace = sp.rows[0].id;
    for (const tag of ["ana", "ben", "cal", "dave", "owner", "requester", "lead", "outsider"]) await person(tag);
    await person("adminlead", "admin");
    await person("gone", "viewer", "disabled");
    const g = await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`Sweep Team ${STAMP}`]);
    teamGroup = g.rows[0].id;
    await fixtureQuery("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)", [teamGroup, people.ana, people.ben]);
    await fixtureQuery("INSERT INTO group_leads (group_id, user_id) VALUES ($1, $2), ($1, $3)", [teamGroup, people.lead, people.adminlead]);
    // An escalation reaches only people who can see the policy's space (E2
    // fix round): the owner and the requester are granted the private space
    // through a group; the viewer lead, the overdue people and the outsider
    // are not. Granted before any policy exists there, so the grant's hook
    // reconciles nothing.
    const sg = await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`Sweep Scope ${STAMP}`]);
    scopeGroup = sg.rows[0].id;
    await fixtureQuery("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)", [scopeGroup, people.owner, people.requester]);
    await setSpaceGroups(privateSpace, [scopeGroup]);
    assert.equal(await canSeeSpace(people.owner, privateSpace), true, "the owner sees the private space");
    assert.equal(await canSeeSpace(people.outsider, privateSpace), false, "the outsider does not");
  });

  after(async () => {
    await pool().query("DELETE FROM audit_log WHERE action IN ('ack.reminder_auto', 'ack.escalated') AND target_id = ANY($1)", [e2Docs.map(String)]);
    await pool().query("DELETE FROM acknowledgements WHERE user_id = ANY($1)", [userIds]);
    await pool().query("DELETE FROM groups WHERE id = ANY($1)", [[teamGroup, scopeGroup]]);
    // The documents (and their rows, outbox rows and notices) go with the file's after().
    await pool().query("DELETE FROM policy_assignments WHERE user_id = ANY($1)", [userIds]);
    await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
    await pool().query("DELETE FROM spaces WHERE id = $1", [privateSpace]);
  });

  test("two sweeps in parallel claim each row once; one 'due' outbox row per policy carries the people and their dates; the audit row is the system's; nothing is claimed twice", async () => {
    const id = await policy("parallel");
    await assign(id, people.ana, { dueAt: daysFromNow(2) });
    await assign(id, people.ben, { dueAt: daysFromNow(-5) });
    await assign(id, people.cal, { dueAt: daysFromNow(10) });

    const [a, b] = await Promise.all([remindDueAcks({ documentIds: [id], defaults: D }), remindDueAcks({ documentIds: [id], defaults: D })]);
    assert.equal(a.claimed + b.claimed, 2, `the two due rows are claimed once between the sweeps (${a.claimed} + ${b.claimed})`);
    const ana = await row(id, people.ana);
    const ben = await row(id, people.ben);
    const cal = await row(id, people.cal);
    assert.equal(ana.reminder_count, 1, "due in 2 days: reminded once");
    assertNear(ana.reminded_at, new Date(), 60_000, "ana's stamp");
    assert.equal(ben.reminder_count, 1, "5 days overdue: reminded once");
    assert.deepEqual([cal.reminder_count, cal.reminded_at], [0, null], "due in 10 days: not yet");

    const outbox = (await pendingOutboxE2(id)).filter((r) => r.mode === "due");
    assert.ok(outbox.length >= 1 && outbox.length <= 2, `one row per policy per sweep that claimed something: ${outbox.length}`);
    const named = outbox.flatMap((r) => r.user_ids ?? []).sort();
    assert.deepEqual(named, [people.ana, people.ben].sort(), "the rows name the claimed people once");
    for (const r of outbox) {
      assert.equal(r.actor_name, "system");
      assert.equal(r.actor_id, null);
      assert.equal(r.source, "");
      assert.ok(new Date(r.not_before).getTime() <= Date.now() + 1000, "a sweep row goes out at once");
      const payload = r.payload as { rows: { user_id: number; due_at: string | null; overdue: boolean }[] };
      assert.ok(Array.isArray(payload?.rows), "the payload carries the rows");
      for (const p of payload.rows) {
        assert.ok(p.due_at, "each row has its date");
        assert.equal(p.overdue, p.user_id === people.ben, `overdue is per person (${p.user_id})`);
      }
    }
    const audit = await audits("ack.reminder_auto", id);
    assert.equal(
      audit.reduce((n, r) => n + Number(r.details.reminded), 0),
      2,
      "ack.reminder_auto counts the people reminded"
    );
    assert.ok(audit.every((r) => r.actor_name === "system" && r.actor_id === null && r.details.policy === id));
    assert.equal(audit.reduce((n, r) => n + Number(r.details.overdue), 0), 1, "and how many of them were overdue");

    const again = await remindDueAcks({ documentIds: [id], defaults: D });
    assert.equal(again.claimed, 0, "straight after, nothing is due: the claim stamped the column it tests");
    assert.equal(again.policies, 0);
  });

  test("the cadence: before the due date, every N days while overdue, a nudge without a deadline only when it is on; the policy's own numbers win over the space's, the space's over the workspace's", async () => {
    const id = await policy("cadence");
    await assign(id, people.ana, { dueAt: daysFromNow(2), remindedAt: hoursAgo(25) });
    await assign(id, people.ben, { dueAt: daysFromNow(-5), remindedAt: daysFromNow(-8) });
    await assign(id, people.cal, { dueAt: null });
    await assign(id, people.dave, { dueAt: null, remindedAt: daysFromNow(-2) });

    // Workspace numbers (every 7, nudge off): ana was reminded yesterday,
    // ben eight days ago, the two without a date are never nudged.
    let claimed = await claimAckReminders(D, { documentIds: [id] });
    assert.deepEqual(claimed.map((r) => r.user_id), [people.ben], "only ben: his last reminder is older than 7 days");
    assert.equal(claimed[0].overdue, true);
    assert.equal(claimed[0].reminder_count, 2, "the count goes up");
    assert.equal(claimed[0].title, `${E2} cadence`);
    assert.equal(claimed[0].email, `${E2}-ben@example.test`);

    // The policy's own cadence: every day. Ana (reminded 25 hours ago) is due again.
    await setPolicySettings(id, { remind_every_days: 1 });
    claimed = await claimAckReminders(D, { documentIds: [id] });
    assert.deepEqual(claimed.map((r) => r.user_id), [people.ana], "the policy's remind_every_days wins over the workspace's 7");
    assert.equal(claimed[0].overdue, false, "due in 2 days: due soon, not overdue");

    // The space's layer: a nudge every day for policies without a deadline
    // that do not say otherwise. Dave (nudged 2 days ago) and cal (never).
    await pool().query("UPDATE spaces SET policy_defaults = $2::jsonb WHERE id = $1", [privateSpace, JSON.stringify({ nudge_every_days: 1 })]);
    claimed = await claimAckReminders(D, { documentIds: [id] });
    assert.deepEqual(claimed.map((r) => r.user_id).sort(), [people.cal, people.dave].sort(), "the space's nudge_every_days applies");
    assert.ok(claimed.every((r) => r.due_at === null && r.overdue === false), "a nudge has no date and is never overdue");
    // The policy switches the nudge off for itself: nobody without a date again, even days later.
    await setPolicySettings(id, { nudge_every_days: 0 });
    await pool().query("UPDATE policy_assignments SET reminded_at = now() - interval '30 days' WHERE document_id = $1 AND due_at IS NULL", [id]);
    claimed = await claimAckReminders(D, { documentIds: [id] });
    assert.deepEqual(claimed.map((r) => r.user_id), [], "nudge 0 on the policy: never");
    await pool().query("UPDATE spaces SET policy_defaults = '{}'::jsonb WHERE id = $1", [privateSpace]);

    // The workspace's nudge, passed in: on, and the pure helper agrees on the next date.
    await setPolicySettings(id, { nudge_every_days: null });
    const nudge = sweepDefaults({ remind_before_days: 3, remind_every_days: 7, escalate_after_days: 7, nudge_every_days: 5, overdue_grace_days: 0 });
    claimed = await claimAckReminders(nudge, { documentIds: [id] });
    assert.deepEqual(claimed.map((r) => r.user_id).sort(), [people.cal, people.dave].sort(), "the workspace nudge applies when neither layer above sets one");
    const next = nextReminderAt({ due_at: null, reminded_at: new Date().toISOString() }, nudge);
    assertNear(next!.toISOString(), new Date(Date.now() + 5 * DAY), 60_000, "the next nudge is five days out");
  });

  test("snoozed, exempt, removed, confirmed and disabled rows are never claimed; a paused or retired policy never reminds; the grace period keeps a row 'due soon'", async () => {
    const id = await policy("skipped");
    await assign(id, people.ana, { dueAt: daysFromNow(-5), snoozedUntil: daysFromNow(3) });
    await assign(id, people.ben, { dueAt: daysFromNow(-5), snoozedUntil: daysFromNow(-1) });
    await assign(id, people.cal, { dueAt: daysFromNow(-5), exempt: true });
    await assign(id, people.dave, { dueAt: daysFromNow(-5), removed: true });
    await assign(id, people.owner, { dueAt: daysFromNow(-5) });
    await recordAcknowledgement(id, people.owner, "", (await listVersions(id))[0].id);
    await assign(id, people.gone, { dueAt: daysFromNow(-5) });

    let claimed = await claimAckReminders(D, { documentIds: [id] });
    assert.deepEqual(claimed.map((r) => r.user_id), [people.ben], "only the row whose snooze has ended");
    for (const [who, tag] of [
      [people.ana, "snoozed"],
      [people.cal, "exempt"],
      [people.dave, "removed"],
      [people.owner, "confirmed"],
      [people.gone, "disabled account"],
    ] as const) {
      assert.equal((await row(id, who)).reminder_count, 0, `${tag}: untouched`);
    }
    // Escalation skips the same rows: ana (snoozed) waits, cal, dave, the
    // confirmed and the disabled never; ben is well past the threshold.
    await pool().query("UPDATE policy_assignments SET due_at = now() - interval '20 days' WHERE document_id = $1", [id]);
    const esc = await claimAckEscalations(D, { documentIds: [id] });
    assert.deepEqual(esc.map((r) => r.user_id), [people.ben], "escalation: only ben");
    assert.equal(esc[0].days, 7);

    // Paused (unpublished) and retired policies never remind or escalate.
    const paused = await policy("paused");
    await assign(paused, people.ana, { dueAt: daysFromNow(-20) });
    await pool().query("UPDATE documents SET status = 'draft' WHERE id = $1", [paused]);
    assert.equal((await remindDueAcks({ documentIds: [paused], defaults: D })).claimed, 0, "paused: no reminder");
    assert.equal((await escalateOverdueAcks({ documentIds: [paused], defaults: D })).claimed, 0, "paused: no escalation");
    await pool().query("UPDATE documents SET status = 'published' WHERE id = $1", [paused]);
    assert.equal((await remindDueAcks({ documentIds: [paused], defaults: D })).claimed, 1, "published again: reminded");
    const retired = await policy("retired");
    await assign(retired, people.ana, { dueAt: daysFromNow(-20) });
    await pool().query("UPDATE documents SET ack_retired_at = now(), ack_required = 0 WHERE id = $1", [retired]);
    assert.equal((await remindDueAcks({ documentIds: [retired], defaults: D })).claimed, 0, "retired: no reminder");
    assert.equal((await escalateOverdueAcks({ documentIds: [retired], defaults: D })).claimed, 0, "retired: no escalation");
    await pool().query("UPDATE documents SET ack_required = 1 WHERE id = $1", [retired]);
    assert.equal((await remindDueAcks({ documentIds: [retired], defaults: D })).claimed, 0, "retired with the requirement on: still nothing");
    // A trashed policy and a draft branch are never claimed by either sweep.
    const trashed = await policy("trashed");
    await assign(trashed, people.ana, { dueAt: daysFromNow(-20) });
    await pool().query("UPDATE documents SET deleted_at = now() WHERE id = $1", [trashed]);
    assert.equal((await remindDueAcks({ documentIds: [trashed], defaults: D })).claimed, 0, "trashed: no reminder");
    assert.equal((await escalateOverdueAcks({ documentIds: [trashed], defaults: D })).claimed, 0, "trashed: no escalation");
    await pool().query("UPDATE documents SET deleted_at = NULL, branch_of = $2 WHERE id = $1", [trashed, paused]);
    assert.equal((await remindDueAcks({ documentIds: [trashed], defaults: D })).claimed, 0, "a branch: no reminder");
    assert.equal((await escalateOverdueAcks({ documentIds: [trashed], defaults: D })).claimed, 0, "a branch: no escalation");
    await pool().query("UPDATE documents SET branch_of = NULL WHERE id = $1", [trashed]);
    assert.equal((await remindDueAcks({ documentIds: [trashed], defaults: D })).claimed, 1, "live again: reminded");

    // The grace period: a row one day past its date is 'due soon' while the
    // grace runs and 'overdue' once it is over.
    const graced = await policy("grace");
    await assign(graced, people.ana, { dueAt: daysFromNow(-1) });
    const G = sweepDefaults({ remind_before_days: 3, remind_every_days: 7, escalate_after_days: 7, nudge_every_days: 0, overdue_grace_days: 3 });
    claimed = await claimAckReminders(G, { documentIds: [graced] });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].overdue, false, "inside the grace: due soon");
    assert.equal(dueStatusLabel(claimed[0].due_at, claimed[0].overdue), "Due soon");
    await assign(graced, people.ana, { dueAt: daysFromNow(-4) });
    claimed = await claimAckReminders(G, { documentIds: [graced] });
    assert.equal(claimed[0].overdue, true, "past the grace: overdue");
    assert.equal(dueStatusLabel(claimed[0].due_at, claimed[0].overdue), "Overdue");
  });

  test("escalation fires once after due + grace + escalate days, across two instances at once, with the recipients resolved per policy (owner, else requested_by, else the approvers, plus the overdue people's leads in scope); extending the due date re-arms it", async () => {
    const id = await policy("escalation");
    await setPolicySettings(id, { owner_user_id: people.owner });
    await assign(id, people.ana, { dueAt: daysFromNow(-8) });
    await assign(id, people.ben, { dueAt: daysFromNow(-5) });
    await assign(id, people.cal, { dueAt: daysFromNow(-8), escalatedAt: daysFromNow(-1) });
    await assign(id, people.dave, { dueAt: daysFromNow(-8), exempt: true });

    // Two instances' hourly ticks at once: the claim stamps the column it
    // tests (FOR UPDATE SKIP LOCKED), so one of them escalates ana and the
    // other finds nothing; one outbox row, one audit row between them.
    const [x, y] = await Promise.all([escalateOverdueAcks({ documentIds: [id], defaults: D }), escalateOverdueAcks({ documentIds: [id], defaults: D })]);
    assert.equal(x.claimed + y.claimed, 1, `ana is escalated once between the two sweeps (${x.claimed} + ${y.claimed})`);
    assert.equal((await pendingOutboxE2(id)).filter((r) => r.mode === "escalation").length, 1, "one escalation row");
    assert.equal((await audits("ack.escalated", id)).length, 1, "one ack.escalated row");
    const first = x.claimed ? x : y;
    assert.deepEqual([first.claimed, first.policies], [1, 1], "ana alone crossed the line (8 > 7); ben has not; cal was escalated already; dave is exempt");
    assertNear((await row(id, people.ana)).escalated_at, new Date(), 60_000, "ana's row is stamped");
    assert.equal((await row(id, people.ben)).escalated_at, null);
    // The private space: the viewer lead cannot see it and gets nothing; the
    // admin lead (space.read_all) and the owner do.
    const [outbox] = (await pendingOutboxE2(id)).filter((r) => r.mode === "escalation");
    assert.ok(outbox, "one escalation row");
    assert.deepEqual([...(outbox.user_ids ?? [])].sort(), [people.owner, people.adminlead].sort(), "the owner and the lead in scope; not the lead without access");
    const payload = outbox.payload as { days: number; overdue: { user_id: number; name: string }[]; recipients: { id: number; via: string }[] };
    assert.equal(payload.days, 7);
    assert.deepEqual(payload.overdue.map((o) => [o.user_id, o.name]), [[people.ana, "Sweep ana"]]);
    assert.deepEqual(
      payload.recipients.map((r) => [r.id, r.via]).sort((x, y) => Number(x[0]) - Number(y[0])),
      [[people.owner, "owner"], [people.adminlead, "lead"]].sort((x, y) => Number(x[0]) - Number(y[0]))
    );
    assert.equal(first.recipients, 2);
    const audit = await audits("ack.escalated", id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_name, "system");
    assert.deepEqual([audit[0].details.policy, audit[0].details.overdue, audit[0].details.recipients, audit[0].details.days], [id, 1, 2, 7]);
    assert.deepEqual(audit[0].details.user_ids, [people.ana]);

    // Once: the next sweep finds nothing; ben crosses the line later and is
    // escalated on his own.
    assert.equal((await escalateOverdueAcks({ documentIds: [id], defaults: D })).claimed, 0, "ana is not escalated twice");
    await assign(id, people.ben, { dueAt: daysFromNow(-8) });
    assert.equal((await escalateOverdueAcks({ documentIds: [id], defaults: D })).claimed, 1, "ben, once he is 8 days overdue");

    // Extending the due date (what extendAssignments writes) re-arms the row.
    await pool().query("UPDATE policy_assignments SET due_at = now() + interval '5 days', escalated_at = NULL WHERE document_id = $1 AND user_id = $2", [id, people.ana]);
    assert.equal((await escalateOverdueAcks({ documentIds: [id], defaults: D })).claimed, 0, "extended: not overdue, nothing fires");
    await pool().query("UPDATE policy_assignments SET due_at = now() - interval '8 days' WHERE document_id = $1 AND user_id = $2", [id, people.ana]);
    assert.equal((await escalateOverdueAcks({ documentIds: [id], defaults: D })).claimed, 1, "past the extended date: escalated again");

    // The grace delays the threshold: 8 days overdue with 3 days' grace is not 7 past it.
    const graced = await policy("escalation grace");
    await assign(graced, people.ana, { dueAt: daysFromNow(-8) });
    const G = sweepDefaults({ remind_before_days: 3, remind_every_days: 7, escalate_after_days: 7, nudge_every_days: 0, overdue_grace_days: 3 });
    assert.equal((await claimAckEscalations(G, { documentIds: [graced] })).length, 0, "8 < 3 + 7: waits");
    await assign(graced, people.ana, { dueAt: daysFromNow(-11) });
    const late = await claimAckEscalations(G, { documentIds: [graced] });
    assert.equal(late.length, 1, "11 > 10: fires");
    assert.equal(late[0].days, 10, "the threshold reported is grace + escalate");
    // The policy's own escalate_after_days wins.
    const own = await policy("escalation own days");
    await setPolicySettings(own, { escalate_after_days: 30 });
    await assign(own, people.ana, { dueAt: daysFromNow(-20) });
    assert.equal((await claimAckEscalations(D, { documentIds: [own] })).length, 0, "the policy says 30 days");

    // Recipients: requested_by when there is no owner; the space's approvers when there is neither.
    const viaRequester = await policy("escalation requester");
    await setPolicySettings(viaRequester, { owner_user_id: null, requested_by: people.requester });
    let recipients = await escalationRecipients([{ document_id: viaRequester, space_id: privateSpace, user_ids: [people.cal] }]);
    assert.deepEqual(
      recipients.get(viaRequester)!.map((r) => [r.id, r.via]),
      [[people.requester, "requested_by"]],
      "no owner: whoever switched it on (cal belongs to no group: no lead)"
    );
    const viaApprovers = await policy("escalation approvers");
    await setPolicySettings(viaApprovers, { owner_user_id: null, requested_by: null });
    recipients = await escalationRecipients([{ document_id: viaApprovers, space_id: privateSpace, user_ids: [people.cal] }]);
    const approvers = await listApproverIdsForSpace(privateSpace, 0);
    assert.deepEqual(
      recipients.get(viaApprovers)!.map((r) => r.id).sort(),
      [...approvers].sort(),
      "neither: the space's approvers"
    );
    assert.ok(recipients.get(viaApprovers)!.every((r) => r.via === "approver"));
    // An owner whose account is disabled is skipped like no owner at all.
    await setPolicySettings(viaRequester, { owner_user_id: people.gone });
    recipients = await escalationRecipients([{ document_id: viaRequester, space_id: privateSpace, user_ids: [] }]);
    assert.deepEqual(recipients.get(viaRequester)!.map((r) => r.via), ["requested_by"], "a disabled owner falls through");
    // An owner who cannot see the private space is skipped the same way (the
    // ceiling: an escalation names the overdue people), and so is a
    // requester who cannot: the policy falls to the space's approvers.
    await setPolicySettings(viaRequester, { owner_user_id: people.outsider });
    recipients = await escalationRecipients([{ document_id: viaRequester, space_id: privateSpace, user_ids: [] }]);
    assert.deepEqual(
      recipients.get(viaRequester)!.map((r) => [r.id, r.via]),
      [[people.requester, "requested_by"]],
      "an owner off the private space is not told; the requester in scope is"
    );
    await setPolicySettings(viaRequester, { owner_user_id: people.outsider, requested_by: people.outsider });
    recipients = await escalationRecipients([{ document_id: viaRequester, space_id: privateSpace, user_ids: [] }]);
    assert.ok(recipients.get(viaRequester)!.every((r) => r.via === "approver" && r.id !== people.outsider), "both off the space: the approvers");
    assert.deepEqual(
      recipients.get(viaRequester)!.map((r) => r.id).sort(),
      [...(await listApproverIdsForSpace(privateSpace, 0))].sort()
    );
    // The space layer's owner (policy_defaults.owner_user_id) stands in for a
    // policy that names none, as the Settings tab's cascade says.
    await setPolicySettings(viaRequester, { owner_user_id: null, requested_by: null });
    await pool().query("UPDATE spaces SET policy_defaults = $2::jsonb WHERE id = $1", [privateSpace, JSON.stringify({ owner_user_id: people.owner })]);
    recipients = await escalationRecipients([{ document_id: viaRequester, space_id: privateSpace, user_ids: [] }]);
    assert.deepEqual(recipients.get(viaRequester)!.map((r) => [r.id, r.via]), [[people.owner, "owner"]], "the space's owner, via 'owner'");
    await pool().query("UPDATE spaces SET policy_defaults = $2::jsonb WHERE id = $1", [privateSpace, JSON.stringify({ owner_user_id: people.outsider })]);
    recipients = await escalationRecipients([{ document_id: viaRequester, space_id: privateSpace, user_ids: [] }]);
    assert.ok(recipients.get(viaRequester)!.every((r) => r.via === "approver"), "a space owner off the space falls through too");
    await pool().query("UPDATE spaces SET policy_defaults = '{}'::jsonb WHERE id = $1", [privateSpace]);

    // The requester is whoever switched the requirement on, written by the
    // switch-on itself (no fixture): the portal's Request and the popover
    // both go through requestAcknowledgement. The first requester is kept.
    const switched = await createDocument({
      space_id: privateSpace,
      title: `${E2} escalation switch-on`,
      type: "policy",
      status: "published",
      content: TEXT,
      summary: "",
      tags: [],
      author: "test",
    });
    docIds.push(switched.id);
    e2Docs.push(switched.id);
    const on = await requestAcknowledgement(switched, { id: people.requester, name: "Sweep requester" }, "", { notify: false });
    assert.equal(on.switched_on, true);
    const stamped = (await pool().query("SELECT requested_by, requested_at FROM policy_settings WHERE document_id = $1", [switched.id])).rows[0];
    assert.equal(stamped?.requested_by, people.requester, "requested_by is the actor who switched it on");
    assert.ok(stamped?.requested_at, "and the moment");
    recipients = await escalationRecipients([{ document_id: switched.id, space_id: privateSpace, user_ids: [] }]);
    assert.deepEqual(recipients.get(switched.id)!.map((r) => [r.id, r.via]), [[people.requester, "requested_by"]], "no owner: the requester, from the switch-on");
    await setAckRequired(switched.id, false);
    assert.equal((await requestAcknowledgement(switched, { id: people.owner, name: "Sweep owner" }, "", { notify: false })).switched_on, true);
    assert.equal(
      (await pool().query("SELECT requested_by FROM policy_settings WHERE document_id = $1", [switched.id])).rows[0].requested_by,
      people.requester,
      "a later switch-on keeps the first requester"
    );

    // An internal space: both leads of the overdue person's group can see it; a person reached two ways keeps the first.
    const internal = await policy("escalation internal", spaceId);
    await setPolicySettings(internal, { owner_user_id: people.lead });
    recipients = await escalationRecipients([{ document_id: internal, space_id: spaceId, user_ids: [people.ana] }]);
    assert.deepEqual(
      recipients.get(internal)!.map((r) => [r.id, r.via]).sort((x, y) => Number(x[0]) - Number(y[0])),
      [[people.lead, "owner"], [people.adminlead, "lead"]].sort((x, y) => Number(x[0]) - Number(y[0])),
      "the viewer lead sees an internal space; as the owner he is listed once, as the owner"
    );
    // A policy nobody can be told about is still stamped and audited, with no outbox row.
    const nobody = await policy("escalation nobody");
    await setPolicySettings(nobody, { owner_user_id: null, requested_by: null });
    await assign(nobody, people.cal, { dueAt: daysFromNow(-8) });
    await pool().query("UPDATE policy_assignments SET escalated_at = NULL WHERE document_id = $1", [nobody]);
    const approversHere = await listApproverIdsForSpace(privateSpace, 0);
    const r = await escalateOverdueAcks({ documentIds: [nobody], defaults: D });
    assert.equal(r.claimed, 1);
    assert.equal(r.recipients, approversHere.length, "told whoever approves in the space, or nobody");
    assert.equal((await pendingOutboxE2(nobody)).filter((x) => x.mode === "escalation").length, approversHere.length > 0 ? 1 : 0);
    assert.equal((await audits("ack.escalated", nobody)).length, 1, "audited either way");
    assertNear((await row(nobody, people.cal)).escalated_at, new Date(), 60_000, "and stamped, so it is not escalated again");
  });

  test("the manual Remind stamps the open, unconfirmed rows it reaches; the per-policy summary says when people were last reminded and when the sweep next will", async () => {
    // The internal space: the stamp reaches only people who can see the
    // policy's space (the drain's recipients), and the four here are
    // viewers with no grant on the private one.
    const id = await policy("stamp", spaceId);
    await assign(id, people.ana, { dueAt: daysFromNow(10) });
    await assign(id, people.ben, { dueAt: daysFromNow(2), remindedAt: daysFromNow(-1) });
    await assign(id, people.cal, { dueAt: daysFromNow(2), exempt: true });
    await assign(id, people.dave, { dueAt: daysFromNow(2) });
    await recordAcknowledgement(id, people.dave, "", (await listVersions(id))[0].id);

    // Before the Remind: ben's next automatic reminder is 7 days after his
    // last (in 6 days), ana's 3 days before her date (in 7); the earliest wins.
    let summary = (await ackReminderSummary([id], D)).get(id)!;
    assertNear(summary.last_reminded_at, new Date(Date.now() - DAY), 60_000, "last reminded: ben's stamp");
    assertNear(summary.next_reminder_at, new Date(Date.now() + 6 * DAY), 60_000, "next: ben, in 6 days");
    assert.equal(
      reminderSubtitle(summary, (iso) => new Date(iso).toISOString().slice(0, 10)),
      `last reminded yesterday · next automatic reminder ${new Date(Date.now() + 6 * DAY).toISOString().slice(0, 10)}`
    );
    const pure = nextReminderAt({ due_at: daysFromNow(2), reminded_at: daysFromNow(-1) }, D);
    assertNear(pure!.toISOString(), new Date(Date.now() + 6 * DAY), 60_000, "the pure helper agrees");

    assert.equal(await stampAckReminded(id), 2, "ana and ben: open and unconfirmed (cal exempt, dave confirmed)");
    assert.equal((await row(id, people.ana)).reminder_count, 1);
    assert.equal((await row(id, people.ben)).reminder_count, 2);
    assert.equal((await row(id, people.cal)).reminder_count, 0);
    assert.equal((await row(id, people.dave)).reminder_count, 0);
    assert.equal(await stampAckReminded(id, [people.dave, people.cal]), 0, "named people who are confirmed or exempt: nothing");
    assert.equal(await stampAckReminded(id, [people.ana]), 1, "a named open row");

    summary = (await ackReminderSummary([id], D)).get(id)!;
    assertNear(summary.last_reminded_at, new Date(), 60_000, "last reminded: just now");
    assertNear(summary.next_reminder_at, new Date(Date.now() + 7 * DAY), 60_000, "next: 7 days after today's stamp (ana's date is 10 days out, so 3 days before it is later)");
    // A document whose manual Remind stamp is newer than every row's.
    await pool().query("UPDATE policy_assignments SET reminded_at = now() - interval '3 days' WHERE document_id = $1", [id]);
    await pool().query("UPDATE documents SET ack_last_reminded_at = now() - interval '1 day' WHERE id = $1", [id]);
    summary = (await ackReminderSummary([id], D)).get(id)!;
    assertNear(summary.last_reminded_at, new Date(Date.now() - DAY), 60_000, "the document's stamp when it is the later one");
    // Nothing scheduled: everyone confirmed or exempt, or no date and no nudge.
    await pool().query("UPDATE policy_assignments SET exempt_at = now() WHERE document_id = $1 AND user_id = ANY($2)", [id, [people.ana, people.ben]]);
    summary = (await ackReminderSummary([id], D)).get(id)!;
    assert.equal(summary.next_reminder_at, null, "no open, unconfirmed row: nothing is scheduled");
    assert.equal(reminderSubtitle({ last_reminded_at: null, next_reminder_at: null }, (s) => s), null);
    assert.deepEqual(await ackReminderSummary([], D), new Map());
  });

  test("complianceHourly runs the steps in order under the licence, a failing step never stops the next, and nothing moves with the feature off", async () => {
    // An internal space, so the reconcile step (the first) keeps the rows
    // of people who can see it rather than closing them.
    const id = await policy("hourly", spaceId);
    // ana is due in 2 days: the reminder step claims her. ben's exemption
    // ran out yesterday: the exemptions step would clear it, but a trigger
    // scoped to his row refuses, so that step throws.
    await assign(id, people.ana, { dueAt: daysFromNow(2) });
    await assign(id, people.ben, { dueAt: daysFromNow(-5), exempt: true });
    await pool().query("UPDATE policy_assignments SET exempt_until = now() - interval '1 day' WHERE document_id = $1 AND user_id = $2", [id, people.ben]);
    const refuse = `acksweep_refuse_${STAMP.replace(/\D/g, "")}`;
    await fixtureQuery(
      `CREATE OR REPLACE FUNCTION ${refuse}() RETURNS trigger AS $t$
       BEGIN
         IF OLD.user_id = ${people.ben} AND OLD.exempt_at IS NOT NULL AND NEW.exempt_at IS NULL THEN
           RAISE EXCEPTION 'exemption expiry refused by the test';
         END IF;
         RETURN NEW;
       END $t$ LANGUAGE plpgsql`
    );
    await fixtureQuery(`CREATE TRIGGER ${refuse} BEFORE UPDATE ON policy_assignments FOR EACH ROW EXECUTE FUNCTION ${refuse}()`);
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await complianceHourly({ documentIds: [id] });
    } finally {
      console.error = original;
      await pool().query(`DROP TRIGGER IF EXISTS ${refuse} ON policy_assignments`);
      await pool().query(`DROP FUNCTION IF EXISTS ${refuse}()`);
    }
    assert.ok(
      logged.some((l) => l.startsWith("[compliance] expired exemptions failed")),
      `the failing step is logged with its name: ${JSON.stringify(logged)}`
    );
    const ben = (await pool().query("SELECT exempt_at FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [id, people.ben])).rows[0];
    assert.ok(ben.exempt_at, "the refused step changed nothing");
    assert.equal((await row(id, people.ana)).reminder_count, 1, "the reminder step after it still ran");
    assert.equal((await audits("ack.reminder_auto", id)).length, 1, "and audited");

    // The feature off (no licence): the tick does nothing at all.
    await assign(id, people.cal, { dueAt: daysFromNow(2) });
    const granted = edition.features.splice(0, edition.features.length);
    try {
      await complianceHourly({ documentIds: [id] });
    } finally {
      edition.features.push(...granted);
    }
    assert.equal((await row(id, people.cal)).reminder_count, 0, "with the feature off nobody is reminded");
    assert.equal((await audits("ack.reminder_auto", id)).length, 1, "and nothing is audited");
    await complianceHourly({ documentIds: [id] });
    assert.equal((await row(id, people.cal)).reminder_count, 1, "licensed again: the tick runs");
  });
});

describe("lib/ack-remind (pure)", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const iso = (d: number) => new Date(now.getTime() + d * DAY).toISOString();
  const cadence = { remind_before_days: 3, remind_every_days: 7, nudge_every_days: 0 };

  test("nextReminderAt mirrors the claim: before the date, after the last reminder, a nudge only when on, never in the past, held by a snooze", () => {
    assert.equal(nextReminderAt({ due_at: iso(10), reminded_at: null }, cadence, now)!.toISOString(), iso(7), "3 days before the date");
    assert.equal(nextReminderAt({ due_at: iso(2), reminded_at: null }, cadence, now)!.toISOString(), now.toISOString(), "already inside the window: the next tick");
    assert.equal(nextReminderAt({ due_at: iso(2), reminded_at: iso(-1) }, cadence, now)!.toISOString(), iso(6), "7 days after the last reminder");
    assert.equal(nextReminderAt({ due_at: iso(-5), reminded_at: iso(-8) }, cadence, now)!.toISOString(), now.toISOString(), "overdue and the week is up: the next tick");
    assert.equal(nextReminderAt({ due_at: iso(20), reminded_at: iso(-1) }, cadence, now)!.toISOString(), iso(17), "the later of the two rules");
    assert.equal(nextReminderAt({ due_at: null, reminded_at: null }, cadence, now), null, "no date, nudge off: never");
    assert.equal(nextReminderAt({ due_at: null, reminded_at: null }, { ...cadence, nudge_every_days: 5 }, now)!.toISOString(), now.toISOString(), "no date, nudge on, never nudged: the next tick");
    assert.equal(nextReminderAt({ due_at: null, reminded_at: iso(-2) }, { ...cadence, nudge_every_days: 5 }, now)!.toISOString(), iso(3), "5 days after the last nudge");
    assert.equal(nextReminderAt({ due_at: iso(2), reminded_at: null, snoozed_until: iso(4) }, cadence, now)!.toISOString(), iso(4), "a snooze holds it to its end");
    assert.equal(nextReminderAt({ due_at: iso(10), reminded_at: null, snoozed_until: iso(1) }, cadence, now)!.toISOString(), iso(7), "a snooze that ends before the date changes nothing");
  });

  test("the subtitle and the days-ago words", () => {
    const fmt = (s: string) => s.slice(0, 10);
    assert.equal(daysAgoLabel(iso(0), now), "today");
    assert.equal(daysAgoLabel(iso(-1), now), "yesterday");
    assert.equal(daysAgoLabel(iso(-2), now), "2 days ago");
    assert.equal(daysAgoLabel(new Date(now.getTime() - 3_600_000).toISOString(), now), "today");
    assert.equal(reminderSubtitle({ last_reminded_at: iso(-2), next_reminder_at: iso(5) }, fmt, now), "last reminded 2 days ago · next automatic reminder 2026-10-25");
    assert.equal(reminderSubtitle({ last_reminded_at: null, next_reminder_at: iso(5) }, fmt, now), "next automatic reminder 2026-10-25");
    assert.equal(reminderSubtitle({ last_reminded_at: iso(0), next_reminder_at: null }, fmt, now), "last reminded today");
    assert.equal(reminderSubtitle({ last_reminded_at: null, next_reminder_at: null }, fmt, now), null);
  });

  test("the notices' words: due in N days, due today, overdue, a nudge, the bundle, the escalation; glossary words only", () => {
    const t = "Acceptable Use Policy";
    const fmt = (s: string) => new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    assert.equal(dueNoticeTitle(t, iso(3), false, now), 'Due in 3 days: confirm "Acceptable Use Policy"');
    assert.equal(dueNoticeTitle(t, iso(1), false, now), 'Due in 1 day: confirm "Acceptable Use Policy"');
    assert.equal(dueNoticeTitle(t, iso(0.4), false, now), 'Due in 1 day: confirm "Acceptable Use Policy"', "a part of a day rounds up");
    assert.equal(dueNoticeTitle(t, iso(-1), false, now), 'Due today: confirm "Acceptable Use Policy"', "the date passed inside the grace");
    assert.equal(dueNoticeTitle(t, iso(-5), true, now), 'Overdue: confirm "Acceptable Use Policy"');
    assert.equal(dueNoticeTitle(t, null, false, now), 'Reminder: confirm "Acceptable Use Policy"');
    assert.equal(dueNoticeBody(t, iso(9), fmt), "Due 29 Oct.");
    assert.equal(dueNoticeBody(t, null), 'You still need to read and confirm "Acceptable Use Policy".');
    assert.equal(dueLine(iso(9), fmt), "Please confirm by 29 Oct.");
    assert.equal(dueLine(null), "");
    assert.deepEqual([dueStatusLabel(iso(9), false), dueStatusLabel(iso(-9), true), dueStatusLabel(null, false)], ["Due soon", "Overdue", "Reminder"]);

    const items = [
      { title: "Acceptable Use Policy", due_at: iso(9), overdue: false },
      { title: "Code of Conduct", due_at: iso(-3), overdue: true },
      { title: "Expense policy", due_at: null, overdue: false },
      { title: "Remote Work Policy", due_at: iso(14), overdue: false },
      { title: "Travel policy", due_at: iso(21), overdue: false },
    ];
    assert.equal(bundleTitle(5), "You have 5 policies to confirm");
    assert.equal(bundleTitle(1), "You have 1 policy to confirm");
    assert.equal(
      bundleBody(items, fmt),
      "Acceptable Use Policy (due 29 Oct) · Code of Conduct (overdue) · Expense policy (no deadline) · Remote Work Policy (due 3 Nov) · +1"
    );
    assert.equal(bundleBody(items.slice(0, 2), fmt), "Acceptable Use Policy (due 29 Oct) · Code of Conduct (overdue)");
    assert.equal(bundleList(items.slice(0, 3), fmt), "- Acceptable Use Policy (due 29 Oct)\n- Code of Conduct (overdue)\n- Expense policy");

    assert.equal(escalationTitle(7, t), 'Overdue: 7 people on "Acceptable Use Policy"');
    assert.equal(escalationTitle(1, t), 'Overdue: 1 person on "Acceptable Use Policy"');
    assert.equal(escalationBody(7, ["Ana Ruiz", "Ben Lo", "Chloe Park", "Dan Fox"]), "More than 7 days overdue: Ana Ruiz, Ben Lo, +2");
    assert.equal(escalationBody(1, ["Ana Ruiz"]), "More than 1 day overdue: Ana Ruiz");
    assert.equal(escalationList([{ name: "Ana Ruiz", due_at: iso(-9) }, { name: "Ben Lo", due_at: null }], fmt), "- Ana Ruiz (due 11 Oct)\n- Ben Lo");

    for (const s of [
      dueNoticeTitle(t, iso(3), false, now),
      dueNoticeBody(t, null),
      bundleTitle(4),
      bundleBody(items, fmt),
      escalationTitle(7, t),
      escalationBody(7, ["Ana"]),
      reminderSubtitle({ last_reminded_at: iso(-2), next_reminder_at: iso(5) }, fmt, now)!,
    ]) {
      assert.ok(!s.includes("—") && !/acknowledg|attest/i.test(s), `glossary: ${s}`);
    }
  });
});
