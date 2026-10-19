// Periodic re-confirmation (G1, 1.12.0): the sweep's one-statement claim
// fires each due cycle once across parallel instances, writes one ledger
// row and one notice, and leaves unpublished, retired and not-yet-due
// policies alone; the first cycle of a newly set interval lands 14 days out
// when the marker is older than the interval; every reset moves the next
// date and a keep leaves it; the workspace default interval lands on the
// first switch-on; and the pure rules and copy in lib/ack-recert.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-sweep.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  pool,
  getSetting,
  setSetting,
  createDocument,
  setAckRequired,
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
  await setAckRequired(doc.id, true, { editDefault: null, recertMonths: null });
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
    // the shared pool: the second's UPDATE waits on the row lock, re-reads
    // the next date the first moved and matches nothing.
    const [a, b] = await Promise.all([recertifyDueAcks({ documentIds: [id] }), recertifyDueAcks({ documentIds: [id] })]);
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
    await setAckRequired(quiet, true, { editDefault: null });
    const q = await recertRow(quiet);
    assert.deepEqual([q.ack_recert_months, q.ack_next_recert_at], [null, null]);
    assertToday(q.ack_effective_at, "dated even without a cycle");

    // A value the build does not offer reads as never; an explicit option applies instead of the workspace's; null leaves the columns alone.
    await setSetting("ack_defaults", JSON.stringify({ recert_months: 7 }));
    const seven = await newPolicy(`${STAMP} default seven`);
    await setAckRequired(seven, true, { editDefault: null });
    assert.equal((await recertRow(seven)).ack_recert_months, null, "7 is not an option: no cycle");
    await setSetting("ack_defaults", JSON.stringify({ recert_months: 24 }));
    const explicit = await newPolicy(`${STAMP} explicit six`);
    await setAckRequired(explicit, true, { editDefault: null, recertMonths: 6 });
    assert.equal((await recertRow(explicit)).ack_recert_months, 6);
    const alone = await newPolicy(`${STAMP} left alone`);
    await setAckRequired(alone, true, { editDefault: null, recertMonths: null });
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
