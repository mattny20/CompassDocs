// The notice outbox (1.10.1, H4) and the per-person coalescing it applies
// (H1): a fan-out is a row, claimed atomically by whichever instance's
// minute tick gets there first, delivered to the people pending at that
// moment, recorded per person (E3), retried after a failure without telling
// anyone twice, and closed after three failures.
//
// Run: npm run test:integration  (needs DATABASE_URL)
//
// The suite must not share its database with a running licensed server:
// the server's minute tick drains the queue with no document filter and
// would claim this file's rows (the "dead" row below, the debounced edit
// row) before the assertions see them. This file's own drains claim this
// file's rows only, so parallel test files cannot poison each other.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  getSetting,
  createDocument,
  updateDocument,
  setAckRequired,
  recordAcknowledgement,
  listVersions,
  listAckDecisions,
  resetAcknowledgements,
  getAckOutboxRow,
  pendingAckOutboxFor,
  listAckNotices,
  lastAckNoticeByDocument,
  runDbMaintenance,
} from "../src/lib/db";
import { enqueueAckNotice, deliverAckNotices, noticeCopy, recordNotices } from "../src/lib/compliance";
import type { Mailer } from "../src/lib/compliance";
import { notify } from "../src/lib/notifications";
import { fixtureQuery } from "./support/retry";
// E2 (1.13.0): the sweep's deliveries.
import { listAckNotices as listNoticesE2 } from "../src/lib/db";
import { DUE_BUNDLE_OVER } from "../src/lib/compliance";

const STAMP = `ackout-${Date.now()}`;
const ORIGIN = "https://docs.example.test";

let spaceId = 0;
let readerA = 0;
let readerB = 0;
let actorId = 0;
const userIds: number[] = [];
const docIds: number[] = [];
const actor = () => ({ id: actorId, name: "Out Actor" });

const LONG_TEXT = Array.from({ length: 30 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);

async function newUser(tag: string): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP}-${tag}`, `Out ${tag}`, `${STAMP}-${tag}@example.test`]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function newPolicy(title: string, content = LONG_TEXT): Promise<{ id: number; title: string; v1: number }> {
  const full = `${STAMP} ${title}`;
  const doc = await createDocument({
    space_id: spaceId,
    title: full,
    type: "policy",
    status: "published",
    content,
    summary: "",
    tags: [],
    author: "test",
  });
  await setAckRequired(doc.id, true);
  docIds.push(doc.id);
  return { id: doc.id, title: full, v1: (await listVersions(doc.id))[0].id };
}

const quiet: Mailer = async () => {};
// Test files run in parallel against one database and one queue: this
// file's drains claim this file's rows only, so another file's failing
// mailer cannot poison them (production passes no filter).
const drain = (mailer: Mailer | null, limit = 50) =>
  deliverAckNotices({ origin: ORIGIN, mailer, limit, documentIds: docIds });

/** Drain until the condition holds (a row may be due a tick later). */
async function drainUntil(mailer: Mailer | null, pred: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await drain(mailer);
    if (await pred()) return;
  }
  assert.fail(`the drain never reached: ${what}`);
}
const done = (id: number) => async () => Boolean((await getAckOutboxRow(id))?.done_at);
const claimed = (id: number) => async () => ((await getAckOutboxRow(id))?.attempts ?? 0) >= 1;

async function noticesFor(docId: number, userId: number, kind?: string): Promise<number> {
  const r = await pool().query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM ack_notices WHERE document_id = $1 AND user_id = $2 AND ($3::text IS NULL OR kind = $3)",
    [docId, userId, kind ?? null]
  );
  return r.rows[0].n;
}
async function inboxRows(userId: number, title: string): Promise<{ title: string; body: string; link: string }[]> {
  const r = await pool().query(
    "SELECT title, body, link FROM notifications WHERE user_id = $1 AND kind = 'ack_requested' AND title = $2 ORDER BY id",
    [userId, title]
  );
  return r.rows;
}
async function auditRows(action: string, docId: number): Promise<{ actor_name: string; details: Record<string, unknown> }[]> {
  const r = await pool().query(
    "SELECT actor_name, details FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
    [action, String(docId)]
  );
  return r.rows;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Outbox ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  readerA = await newUser("Reader A");
  readerB = await newUser("Reader B");
  actorId = await newUser("Actor");
});

after(async () => {
  // Only this file's documents (see test/ack-notices.test.ts: rows about
  // another file's policy are that file's to delete).
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  // The drain tells every account that can see the space (e2e_admin, other
  // files' fixtures); every title it writes carries this file's stamp.
  await pool().query("DELETE FROM notifications WHERE kind = 'ack_requested' AND title LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("the notice outbox", () => {
  test("two drains in parallel claim each row once", async () => {
    const docs = [await newPolicy("parallel 1"), await newPolicy("parallel 2"), await newPolicy("parallel 3")];
    const ids: number[] = [];
    for (const d of docs) {
      ids.push(await enqueueAckNotice(null, { document_id: d.id, mode: "request", source: "manual", actor: actor() }));
    }
    const allDone = async () => (await Promise.all(ids.map((id) => done(id)()))).every(Boolean);
    for (let i = 0; i < 12 && !(await allDone()); i++) {
      // Small claims, so both drains have to take part.
      await Promise.all([drain(quiet, 2), drain(quiet, 2)]);
    }
    assert.ok(await allDone(), "every row was delivered");
    for (const id of ids) {
      const row = (await getAckOutboxRow(id))!;
      assert.equal(row.attempts, 1, `row ${id} was claimed exactly once`);
      assert.equal(row.error, null);
      assert.ok(row.claimed_at);
    }
    const dup = await pool().query(
      "SELECT document_id, user_id FROM ack_notices WHERE outbox_id = ANY($1) GROUP BY 1, 2 HAVING COUNT(*) > 1",
      [ids]
    );
    assert.equal(dup.rows.length, 0, "nobody has two notices for one row");
    for (const d of docs) {
      assert.equal((await inboxRows(readerA, `Action required: confirm "${d.title}"`)).length, 1, "one inbox row per person per policy");
      assert.equal(await noticesFor(d.id, readerA, "request"), 1);
    }
  });

  test("a row with user_ids NULL resolves the pending people at delivery; an explicit list reaches only those", async () => {
    const { id, title, v1 } = await newPolicy("resolve");
    const outboxId = await enqueueAckNotice(null, { document_id: id, mode: "request", source: "manual", actor: actor() });
    // A confirms between enqueue and delivery: not pending any more, not told.
    await recordAcknowledgement(id, readerA, "", v1);
    // No mailer at all (SMTP not configured): the record says inapp only.
    await drainUntil(null, done(outboxId), `row ${outboxId} delivered`);

    const row = (await getAckOutboxRow(outboxId))!;
    assert.equal(row.user_ids, null);
    const notices = await listAckNotices({ documentId: id });
    assert.ok(!notices.some((n) => n.user_id === readerA), "the person who confirmed in the meantime is not told");
    const b = notices.find((n) => n.user_id === readerB);
    assert.ok(b, "the pending person is");
    assert.equal(b.kind, "request");
    assert.equal(b.document_title, title);
    assert.equal(b.outbox_id, outboxId);
    assert.deepEqual(b.channels, ["inapp"]);
    assert.equal(row.noticed, notices.filter((n) => n.outbox_id === outboxId).length, "noticed is the rows actually written");
    assert.equal(row.emailed, 0, "without SMTP nothing is counted as emailed");

    const explicit = await enqueueAckNotice(null, {
      document_id: id,
      mode: "reminder",
      source: "manual",
      actor: actor(),
      user_ids: [readerB, readerB],
    });
    await drainUntil(quiet, done(explicit), `row ${explicit} delivered`);
    const only = (await listAckNotices({ documentId: id })).filter((n) => n.outbox_id === explicit);
    assert.deepEqual(
      only.map((n) => n.user_id),
      [readerB],
      "an explicit list is used as given (deduplicated), not re-resolved"
    );
    assert.equal(only[0].kind, "reminder");
    const last = (await lastAckNoticeByDocument([id])).get(id)!;
    assert.equal(last.kind, "reminder", "the roster's 'last notified' is the newest row");
    // The body may end "by {date}" (E1, 1.13.0): the person's own due date,
    // from their assignment row; this test is about who is told, not when.
    assert.deepEqual(
      (await inboxRows(readerB, `Reminder: confirm "${title}"`)).map((r) => [r.body.replace(/ by [^"]+\.$/, "."), r.link]),
      [[`You still need to read and confirm "${title}".`, `/doc/${id}#confirm-reading`]]
    );
  });

  test("the 24h per-person coalescing skips a second 'updated' for the same person and document, not another person; manual bypasses it", async () => {
    const { id, title } = await newPolicy("coalesce");
    const first = await enqueueAckNotice(null, {
      document_id: id,
      mode: "updated",
      source: "edit",
      reason: "Section 4 now covers contractors",
      actor: actor(),
      delay_minutes: 0,
    });
    await drainUntil(quiet, done(first), `row ${first} delivered`);
    assert.equal(await noticesFor(id, readerA, "updated"), 1);
    assert.equal(await noticesFor(id, readerB, "updated"), 1);
    assert.deepEqual(
      // Minus the "by {date}" the person's assignment row adds (E1, 1.13.0).
      (await inboxRows(readerA, `Changed. Please re-confirm "${title}"`)).map((r) => [r.body.replace(/ by [^"]+\.$/, "."), r.link]),
      [[`Out Actor changed "${title}": Section 4 now covers contractors. Please read the changes and confirm again.`, `/doc/${id}#confirm-reading`]],
      "the in-app copy names who changed what"
    );

    // The same afternoon, another save: the same people hear nothing more.
    const second = await enqueueAckNotice(null, {
      document_id: id,
      mode: "updated",
      source: "edit",
      reason: "Clause 2 reworded",
      actor: actor(),
      delay_minutes: 0,
    });
    await drainUntil(quiet, done(second), `row ${second} delivered`);
    assert.equal(await noticesFor(id, readerA, "updated"), 1, "A hears once a day");
    assert.equal(await noticesFor(id, readerB, "updated"), 1);
    const row2 = (await getAckOutboxRow(second))!;
    // Other test files create accounts while this runs; a brand-new account
    // has no notice today and is told, which is the rule, so the count is
    // compared with the rows rather than with zero.
    const second_rows = (await listAckNotices({ documentId: id })).filter((n) => n.outbox_id === second);
    assert.equal(row2.noticed, second_rows.length);
    assert.ok(!second_rows.some((n) => n.user_id === readerA || n.user_id === readerB), "neither A nor B again");
    assert.equal(row2.error, null);
    const audit2 = (await auditRows("ack.reset_notified", id)).find((r) => r.details.outbox_id === second)!;
    assert.ok(audit2, "the drain writes the audit row");
    assert.equal(audit2.actor_name, "Out Actor");
    assert.equal(audit2.details.noticed, second_rows.length);
    assert.ok((audit2.details.skipped_recent as number) >= 2, `the people skipped are counted: ${audit2.details.skipped_recent}`);
    assert.equal(audit2.details.reason, "Clause 2 reworded");

    // Someone who has not heard yet (a new account) still does.
    const readerC = await newUser("Reader C");
    const third = await enqueueAckNotice(null, {
      document_id: id,
      mode: "updated",
      source: "merge",
      reason: "Merged the contractor branch",
      actor: actor(),
      delay_minutes: 0,
    });
    await drainUntil(quiet, done(third), `row ${third} delivered`);
    assert.equal(await noticesFor(id, readerC, "updated"), 1, "a person without a notice today hears");
    assert.equal(await noticesFor(id, readerA, "updated"), 1, "and A still does not");

    // A manual re-ask always delivers (its brake is the one-hour guard).
    const manual = await enqueueAckNotice(null, {
      document_id: id,
      mode: "updated",
      source: "manual",
      reason: "Annual review: please re-read the whole policy",
      actor: actor(),
    });
    await drainUntil(quiet, done(manual), `row ${manual} delivered`);
    assert.equal(await noticesFor(id, readerA, "updated"), 2, "manual source bypasses the coalescing");
    assert.equal(await noticesFor(id, readerB, "updated"), 2);
    assert.equal(await noticesFor(id, readerC, "updated"), 2);
    assert.deepEqual(
      (await inboxRows(readerA, `Please re-confirm "${title}"`)).map((r) => r.body),
      ["Annual review: please re-read the whole policy"],
      "for a manual re-ask the body is the reason"
    );

    // The window closes: a person whose last 'updated' notice is older than
    // a day is told again, while the others, told today, are not.
    await pool().query(
      "UPDATE ack_notices SET sent_at = now() - interval '25 hours' WHERE document_id = $1 AND user_id = $2",
      [id, readerA]
    );
    const fifth = await enqueueAckNotice(null, {
      document_id: id,
      mode: "updated",
      source: "edit",
      reason: "Appendix added",
      actor: actor(),
      delay_minutes: 0,
    });
    await drainUntil(quiet, done(fifth), `row ${fifth} delivered`);
    assert.equal(await noticesFor(id, readerA, "updated"), 3, "A's day is over: told again");
    assert.equal(await noticesFor(id, readerB, "updated"), 2, "B heard today");
    assert.equal(await noticesFor(id, readerC, "updated"), 2, "so did C");
    const rows5 = (await listAckNotices({ documentId: id })).filter((n) => n.outbox_id === fifth);
    assert.ok(rows5.some((n) => n.user_id === readerA), "A is among the rows written");
    const audit5 = (await auditRows("ack.reset_notified", id)).find((r) => r.details.outbox_id === fifth)!;
    assert.ok((audit5.details.skipped_recent as number) >= 2, `B and C were skipped: ${audit5.details.skipped_recent}`);
    assert.equal(
      audit5.details.pending,
      (audit5.details.noticed as number) + (audit5.details.skipped_recent as number),
      "everyone pending was either told or counted as skipped, A among the told"
    );
  });

  test("claimed 'updated' rows for one document merge into one delivery that keeps the latest reason", async () => {
    const { id } = await newPolicy("merge");
    const older = await enqueueAckNotice(null, { document_id: id, mode: "updated", source: "edit", reason: "First save", actor: actor(), delay_minutes: 0 });
    const newer = await enqueueAckNotice(null, { document_id: id, mode: "updated", source: "edit", reason: "Second save", actor: actor(), delay_minutes: 0 });
    await drainUntil(quiet, async () => (await done(older)()) && (await done(newer)()), "both rows delivered");
    const rows = await listAckNotices({ documentId: id });
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((n) => n.outbox_id === newer), "every notice cites the newest row of the group");
    assert.equal(await noticesFor(id, readerA), 1, "one notice, not two");
    const audit = await auditRows("ack.reset_notified", id);
    assert.equal(audit.length, 1, "one audit row for the merged delivery");
    assert.equal(audit[0].details.merged, 2);
    assert.equal(audit[0].details.reason, "Second save");
    assert.equal((await getAckOutboxRow(older))!.noticed, (await getAckOutboxRow(newer))!.noticed, "both rows carry the delivery's counts");

    // A manual row claimed in the same drain as an edit row turns the
    // coalescing off for the whole group: everyone who heard today is told
    // again, once, with the manual row's reason.
    const edit2 = await enqueueAckNotice(null, { document_id: id, mode: "updated", source: "edit", reason: "Third save", actor: actor(), delay_minutes: 0 });
    const manual2 = await enqueueAckNotice(null, { document_id: id, mode: "updated", source: "manual", reason: "Please re-read before Friday", actor: actor() });
    await drainUntil(quiet, async () => (await done(edit2)()) && (await done(manual2)()), "both rows delivered");
    assert.equal(await noticesFor(id, readerA), 2, "told again, once");
    assert.equal(await noticesFor(id, readerB), 2);
    const audit2 = (await auditRows("ack.reset_notified", id)).find((r) => r.details.outbox_id === manual2)!;
    assert.ok(audit2, "one delivery, cited by its newest row");
    assert.equal(audit2.details.merged, 2);
    assert.equal(audit2.details.skipped_recent, 0, "nobody was skipped");
    assert.equal(audit2.details.reason, "Please re-read before Friday");
    assert.equal((await auditRows("ack.reset_notified", id)).length, 2, "two deliveries in all");
    assert.ok(
      (await listAckNotices({ documentId: id })).filter((n) => n.outbox_id === manual2).some((n) => n.user_id === readerA),
      "A's second row cites the merged group's newest row"
    );
  });

  test("a person who confirmed since their last notice is told again when they lapse; a debounced edit row delivers after its two minutes and stamps notified_at", async () => {
    const { id, v1 } = await newPolicy("confirmed since");
    const first = await enqueueAckNotice(null, { document_id: id, mode: "updated", source: "edit", reason: "First change", actor: actor(), delay_minutes: 0 });
    await drainUntil(quiet, done(first), `row ${first} delivered`);
    assert.equal(await noticesFor(id, readerA, "updated"), 1);
    assert.equal(await noticesFor(id, readerB, "updated"), 1);

    // A reads and confirms at noon; the afternoon's material edit lapses it again.
    await recordAcknowledgement(id, readerA, "", v1);
    await updateDocument(id, {
      content: LONG_TEXT.replace("Clause 2: staff", "Clause 2 (revised): all staff"),
      ackPolicy: "reset",
      ackReason: "Clause 2 was revised",
      ackActor: actor(),
      ackSource: "edit",
    });
    const [queued] = await pendingAckOutboxFor(id);
    assert.equal(queued.source, "edit");
    assert.equal((await listAckDecisions(id))[0].notified_at, null, "the reset decision is not notified yet");
    // Its two minutes are up.
    await pool().query("UPDATE ack_outbox SET not_before = now() WHERE id = $1", [queued.id]);
    await drainUntil(quiet, done(queued.id), `row ${queued.id} delivered`);
    assert.equal(await noticesFor(id, readerA, "updated"), 2, "A answered the morning's notice, so the afternoon's change is news");
    assert.equal(await noticesFor(id, readerB, "updated"), 1, "B heard this morning and did nothing since");
    const audit = (await auditRows("ack.reset_notified", id)).find((r) => r.details.outbox_id === queued.id)!;
    assert.ok(audit, "the drain audits the debounced delivery");
    assert.ok((audit.details.skipped_recent as number) >= 1, `B is counted as skipped: ${audit.details.skipped_recent}`);
    assert.ok((await listAckDecisions(id))[0].notified_at, "the edit-sourced decision records when the notice went out");
  });

  test("the record is written before the mail loop, so a reclaim resumes with the email only; the claim is kept fresh while mail goes out", async () => {
    const { id, title } = await newPolicy("lease");
    const outboxId = await enqueueAckNotice(null, { document_id: id, mode: "request", source: "manual", actor: actor() });
    // What an instance leaves behind when it dies after the inbox and before
    // the mail: A's row with the in-app channel. Whoever takes the row over
    // must email A and not write a second inbox row.
    const [preId] = await recordNotices([
      {
        user_id: readerA,
        user_name: "Out Reader A",
        user_email: `${STAMP}-Reader A@example.test`,
        document_id: id,
        document_title: title,
        kind: "request",
        channels: ["inapp"],
        by_user_id: actorId,
        by_name: "Out Actor",
        outbox_id: outboxId,
      },
    ]);
    const sent: string[] = [];
    const seen: (string | null)[] = [];
    const mailer: Mailer = async (to) => {
      for (const t of to) sent.push(t);
      // Each mail finds the claim fresh (the heartbeat after the previous
      // one), then ages it, so the next call proves the heartbeat again.
      seen.push((await getAckOutboxRow(outboxId))!.claimed_at);
      await pool().query("UPDATE ack_outbox SET claimed_at = now() - interval '11 minutes' WHERE id = $1", [outboxId]);
    };
    for (let i = 0; i < 12 && !(await done(outboxId)()); i++) {
      await deliverAckNotices({ origin: ORIGIN, mailer, limit: 50, documentIds: docIds, heartbeatEvery: 1 });
    }
    const row = (await getAckOutboxRow(outboxId))!;
    assert.ok(row.done_at, "delivered");
    assert.equal(row.attempts, 1, "claimed once: the lease never lapsed");
    assert.equal(row.error, null);
    assert.equal(sent.filter((t) => t === `${STAMP}-Reader A@example.test`).length, 1, "A was emailed once");
    assert.equal((await inboxRows(readerA, `Action required: confirm "${title}"`)).length, 0, "no inbox row was repeated for A");
    const a = await listAckNotices({ documentId: id, userId: readerA });
    assert.equal(a.length, 1, "one row for A");
    assert.equal(a[0].id, preId, "the pre-written row");
    assert.deepEqual(a[0].channels, ["inapp", "email"], "with the email added");
    assert.equal((await inboxRows(readerB, `Action required: confirm "${title}"`)).length, 1, "B, fresh, got the inbox row");
    assert.deepEqual((await listAckNotices({ documentId: id, userId: readerB }))[0].channels, ["inapp", "email"]);
    assert.ok(sent.length >= 2, `several mails went out: ${sent.length}`);
    for (const s of seen) {
      assert.ok(s && Date.now() - new Date(s).getTime() < 60_000, `the claim was fresh before each mail: ${s}`);
    }
    assert.ok(Date.now() - new Date(row.claimed_at!).getTime() < 60_000, "and after the last one");
  });

  test("a reset queues its 'updated' notice inside its transaction: debounced for an edit, immediate for a manual ask, nothing on rollback", async () => {
    const { id, v1 } = await newPolicy("reset");
    await recordAcknowledgement(id, readerA, "", v1);
    await updateDocument(id, {
      content: LONG_TEXT.replace("Clause 1: staff", "Clause 1: all staff and contractors"),
      ackPolicy: "reset",
      ackReason: "Contractors are now in scope",
      ackActor: actor(),
      ackSource: "edit",
    });
    let queued = await pendingAckOutboxFor(id);
    assert.equal(queued.length, 1);
    const edit = queued[0];
    assert.equal(edit.mode, "updated");
    assert.equal(edit.source, "edit");
    assert.equal(edit.reason, "Contractors are now in scope");
    assert.equal(edit.actor_id, actorId);
    assert.equal(edit.actor_name, "Out Actor");
    assert.equal(edit.user_ids, null);
    const lead = await pool().query<{ secs: number }>(
      "SELECT EXTRACT(EPOCH FROM (not_before - now()))::float8 AS secs FROM ack_outbox WHERE id = $1",
      [edit.id]
    );
    assert.ok(lead.rows[0].secs > 90 && lead.rows[0].secs <= 120, `an edit waits two minutes: ${lead.rows[0].secs}s`);
    await drain(quiet);
    assert.equal((await getAckOutboxRow(edit.id))!.attempts, 0, "not claimable before not_before");

    // A rolled-back reset queues nothing.
    const v2 = (await listVersions(id))[0].id;
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const r = await resetAcknowledgements(client, id, { versionId: v2, actor: actor(), source: "manual", reason: "Rolled back" });
      assert.ok(r.outbox_id, "the row exists inside the transaction");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    queued = await pendingAckOutboxFor(id);
    assert.deepEqual(queued.map((r) => r.id), [edit.id], "the rolled-back row is gone");

    // A committed manual ask is immediate, and its delivery stamps the ledger.
    const client2 = await pool().connect();
    let manualId = 0;
    try {
      await client2.query("BEGIN");
      const r = await resetAcknowledgements(client2, id, { versionId: v2, actor: actor(), source: "manual", reason: "Please re-read before the audit" });
      manualId = r.outbox_id!;
      await client2.query("COMMIT");
    } finally {
      client2.release();
    }
    const manual = (await getAckOutboxRow(manualId))!;
    assert.ok(new Date(manual.not_before).getTime() <= Date.now() + 1000, "manual: not_before is now");
    await drainUntil(quiet, done(manualId), `row ${manualId} delivered`);
    assert.equal(await noticesFor(id, readerA, "updated"), 1);
    const [latest] = await listAckDecisions(id);
    assert.equal(latest.source, "manual");
    assert.ok(latest.notified_at, "the decision row records when the notice went out");
    assert.equal((await getAckOutboxRow(edit.id))!.done_at, null, "the debounced edit row is still waiting its two minutes");
  });

  test("a failing sendMail leaves the row for retry with attempts incremented; the retry emails without repeating the inbox; three failures retire it", async () => {
    const { id, title } = await newPolicy("retry");
    const outboxId = await enqueueAckNotice(null, { document_id: id, mode: "request", source: "manual", actor: actor() });
    const failing: Mailer = async () => {
      throw new Error("SMTP down");
    };
    await drainUntil(failing, claimed(outboxId), `row ${outboxId} claimed`);
    let row = (await getAckOutboxRow(outboxId))!;
    assert.equal(row.done_at, null, "not done");
    assert.equal(row.attempts, 1);
    assert.match(row.error ?? "", /SMTP down/);
    assert.match(row.error ?? "", /Email to user #\d+: SMTP down/, "the error names the person by id");
    assert.doesNotMatch(row.error ?? "", /@example\.test/, "never by address");
    const a = (await listAckNotices({ documentId: id, userId: readerA }))[0];
    assert.ok(a, "the in-app notice that did go out is on record");
    assert.deepEqual(a.channels, ["inapp"], "without the email");
    assert.equal(row.noticed, (await listAckNotices({ documentId: id })).filter((n) => n.outbox_id === outboxId).length);
    assert.equal(row.emailed, 0);
    assert.equal((await inboxRows(readerA, `Action required: confirm "${title}"`)).length, 1);

    // Ten minutes later another instance takes the row; mail works now.
    await pool().query("UPDATE ack_outbox SET claimed_at = now() - interval '11 minutes' WHERE id = $1", [outboxId]);
    const sent: { to: string; subject: string }[] = [];
    const working: Mailer = async (to, subject) => {
      for (const t of to) sent.push({ to: t, subject });
    };
    await drainUntil(working, done(outboxId), `row ${outboxId} delivered on retry`);
    row = (await getAckOutboxRow(outboxId))!;
    assert.equal(row.attempts, 2);
    assert.equal(row.error, null, "a completed row carries no error");
    assert.ok(row.emailed! >= 2, `the retry emailed the people the first attempt could not: ${row.emailed}`);
    assert.equal(
      sent.filter((m) => m.to === `${STAMP}-Reader A@example.test` && m.subject.includes(title)).length,
      1,
      "A was emailed once"
    );
    const again = (await listAckNotices({ documentId: id, userId: readerA }))[0];
    assert.equal(again.id, a.id, "the same row");
    assert.deepEqual(again.channels, ["inapp", "email"], "now with the email");
    assert.equal((await inboxRows(readerA, `Action required: confirm "${title}"`)).length, 1, "the inbox row was not repeated");
    const audit = (await auditRows("ack.requested", id)).find((r) => r.details.outbox_id === outboxId)!;
    assert.ok(audit, "the audit row is written when the delivery completes");
    assert.equal(audit.details.attempts, 2);
    assert.equal(audit.details.emailed, row.emailed);
    assert.equal(audit.details.noticed, row.noticed);

    // A row that fails three times is closed with its error, audited and never claimed again.
    const dead = await newPolicy("dead");
    const deadId = await enqueueAckNotice(null, { document_id: dead.id, mode: "reminder", source: "manual", actor: actor() });
    await pool().query("UPDATE ack_outbox SET attempts = 2 WHERE id = $1", [deadId]);
    await drainUntil(failing, async () => ((await getAckOutboxRow(deadId))!.attempts ?? 0) >= 3, `row ${deadId} on its third attempt`);
    row = (await getAckOutboxRow(deadId))!;
    assert.equal(row.attempts, 3);
    assert.ok(row.done_at, "closed on its last failure (hidden from the queue, swept with the delivered rows)");
    assert.match(row.error ?? "", /SMTP down/);
    assert.deepEqual(await pendingAckOutboxFor(dead.id), [], "not queued any more");
    const failed = await auditRows("ack.notice_failed", dead.id);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].details.attempts, 3);
    assert.match(String(failed[0].details.error), /SMTP down/);
    await pool().query("UPDATE ack_outbox SET claimed_at = now() - interval '11 minutes' WHERE id = $1", [deadId]);
    await drain(working);
    assert.equal((await getAckOutboxRow(deadId))!.attempts, 3, "never claimed again");
    assert.equal((await auditRows("ack.notice_failed", dead.id)).length, 1, "and not audited twice");

    // A row whose last claim died with its instance (nothing failed or
    // completed it; the claim went stale) is closed by the next drain,
    // audited, and swept with the rest. The people it was for stay untold
    // rather than told twice.
    const gone = await newPolicy("abandoned");
    const goneId = await enqueueAckNotice(null, { document_id: gone.id, mode: "reminder", source: "manual", actor: actor() });
    await pool().query(
      "UPDATE ack_outbox SET attempts = 3, claimed_at = now() - interval '11 minutes', error = 'SMTP down' WHERE id = $1",
      [goneId]
    );
    const swept = await drain(working);
    assert.ok(swept.retired >= 1, `the drain closed the abandoned row: ${JSON.stringify(swept)}`);
    row = (await getAckOutboxRow(goneId))!;
    assert.equal(row.attempts, 3, "not claimed again");
    assert.ok(row.done_at, "closed");
    assert.equal(row.error, "instance died on the last attempt; earlier: SMTP down");
    assert.equal((await listAckNotices({ documentId: gone.id })).length, 0, "nobody was told");
    const abandoned = await auditRows("ack.notice_failed", gone.id);
    assert.equal(abandoned.length, 1, "audited once");
    assert.equal(abandoned[0].details.attempts, 3);
    assert.equal(abandoned[0].details.outbox_id, goneId);
    assert.match(String(abandoned[0].details.error), /^instance died on the last attempt/);
    await pool().query("UPDATE ack_outbox SET done_at = now() - interval '31 days' WHERE id = $1", [goneId]);
    await runDbMaintenance();
    assert.equal(await getAckOutboxRow(goneId), undefined, "swept like a delivered row");
  });

  test("a policy that stopped requiring confirmation tells nobody; notify() reports what it reached", async () => {
    const { id } = await newPolicy("stopped");
    const outboxId = await enqueueAckNotice(null, { document_id: id, mode: "request", source: "manual", actor: actor() });
    await setAckRequired(id, false);
    await drainUntil(quiet, done(outboxId), `row ${outboxId} closed`);
    const row = (await getAckOutboxRow(outboxId))!;
    assert.equal(row.noticed, 0);
    assert.equal(row.error, null);
    assert.equal((await listAckNotices({ documentId: id })).length, 0);

    const r = await notify([readerA, readerA], { kind: "ack_requested", title: `${STAMP} direct`, body: "x", link: "/doc/1" });
    assert.deepEqual(r, { inbox: 1, webhook: 0, inboxIds: [readerA], webhookIds: [] });
    assert.deepEqual(await notify([], { kind: "ack_requested", title: "none" }), { inbox: 0, webhook: 0, inboxIds: [], webhookIds: [] });
  });

  test("noticeCopy: one sentence set per mode, no em-dashes, glossary words only", () => {
    const base = { docTitle: "Expense policy", actorName: "Dana" };
    const updated = noticeCopy({ ...base, mode: "updated", source: "edit", reason: "Cap raised to £75" });
    assert.equal(updated.label, "Updated");
    assert.equal(updated.title, 'Changed. Please re-confirm "Expense policy"');
    assert.equal(updated.body, 'Dana changed "Expense policy": Cap raised to £75. Please read the changes and confirm again.');
    assert.equal(updated.changeNote, "Cap raised to £75");
    assert.equal(updated.reason, "");
    const due = noticeCopy({ ...base, mode: "updated", source: "approval", reason: "", dueAt: "2026-03-03T12:00:00Z" });
    assert.equal(due.body, 'Dana changed "Expense policy". Please read the changes and confirm again by 3 Mar 2026.');
    const manual = noticeCopy({ ...base, mode: "updated", source: "manual", reason: "Annual review" });
    assert.equal(manual.label, "Action required");
    assert.equal(manual.body, "Annual review");
    assert.equal(manual.reason, "Annual review");
    const recurrence = noticeCopy({ ...base, mode: "updated", source: "recurrence", reason: "" });
    assert.equal(recurrence.label, "Annual re-confirmation");
    assert.equal(noticeCopy({ ...base, mode: "reminder" }).label, "Reminder");
    assert.equal(noticeCopy({ ...base, mode: "request" }).title, 'Action required: confirm "Expense policy"');
    for (const mode of ["request", "reminder", "updated", "due", "overdue", "escalation", "welcome"] as const) {
      const c = noticeCopy({ ...base, mode, source: "edit", reason: "r" });
      for (const s of [c.title, c.body, c.requestType, c.label]) {
        assert.doesNotMatch(s, /—/, `no em-dash in "${s}"`);
        assert.doesNotMatch(s, /acknowledg/i, `glossary: "${s}"`);
      }
    }
  });
});

// --- E2 (1.13.0): the sweep's deliveries --------------------------------------------
//
// 'due' rows (one per policy, the claimed people and their dates in the
// payload) and 'escalation' rows (the recipients and the overdue names) are
// what remindDueAcks / escalateOverdueAcks queue; the drain words each
// person's own notice, bundles a person named on more than three 'due' rows
// of a batch into one, and records every delivery per person and policy.

describe("the sweep's deliveries (E2)", () => {
  const system = { id: null, name: "system" };
  const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  const inboxOf = async (userId: number, kind: string) =>
    (
      await pool().query<{ title: string; body: string; link: string }>(
        "SELECT title, body, link FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY id",
        [userId, kind]
      )
    ).rows;
  const allDone = async (ids: number[]) => (await Promise.all(ids.map((id) => done(id)()))).every(Boolean);

  test("a person named on more than three 'due' rows is told once, with one record per policy; everyone else gets their own notice worded from their date; the per-kind email choice is honoured", async () => {
    // C turned the policy-reminder email off; A and B did not.
    const readerC = await newUser("Reader C due");
    await pool().query("UPDATE users SET notify_prefs = $2 WHERE id = $1", [readerC, JSON.stringify({ ack_due: { email: false } })]);
    const policies = [];
    for (let i = 1; i <= DUE_BUNDLE_OVER + 1; i++) policies.push(await newPolicy(`due ${i}`));
    const [p1, p2, p3, p4] = policies;
    const soon = daysFromNow(2);
    const past = daysFromNow(-2);
    const due = (p: { id: number }, rows: { user_id: number; due_at: string | null; overdue: boolean }[]) =>
      enqueueAckNotice(null, {
        document_id: p.id,
        mode: "due",
        source: "",
        actor: system,
        user_ids: rows.map((r) => r.user_id),
        payload: { rows },
        delay_minutes: 0,
      });
    const ids = [
      await due(p1, [
        { user_id: readerA, due_at: soon, overdue: false },
        { user_id: readerB, due_at: soon, overdue: false },
        { user_id: readerC, due_at: soon, overdue: false },
      ]),
      await due(p2, [
        { user_id: readerA, due_at: past, overdue: true },
        { user_id: readerB, due_at: past, overdue: true },
      ]),
      await due(p3, [{ user_id: readerA, due_at: null, overdue: false }]),
      await due(p4, [{ user_id: readerA, due_at: daysFromNow(9), overdue: false }]),
    ];
    const sent: { to: string; subject: string; text: string }[] = [];
    const mailer: Mailer = async (to, subject, text) => {
      for (const t of to) sent.push({ to: t, subject, text });
    };
    for (let i = 0; i < 12 && !(await allDone(ids)); i++) await deliverAckNotices({ origin: ORIGIN, mailer, limit: 50, documentIds: docIds });
    assert.ok(await allDone(ids), "every row was delivered");
    for (const id of ids) {
      const row = (await getAckOutboxRow(id))!;
      assert.equal(row.error, null, `row ${id} completed without error`);
      assert.equal(row.attempts, 1);
    }

    // A: one inbox row for the four policies, linking My policies.
    const bundle = await inboxOf(readerA, "ack_due");
    assert.equal(bundle.length, 1, `A hears once about the four: ${JSON.stringify(bundle)}`);
    assert.equal(bundle[0].title, "You have 4 policies to confirm");
    assert.equal(bundle[0].link, "/compliance");
    assert.ok(bundle[0].body.includes(`${p1.title} (due`), "the body lists the titles with their dates");
    assert.ok(bundle[0].body.includes(`${p2.title} (overdue)`), "and which are overdue");
    assert.ok(bundle[0].body.includes(`${p3.title} (no deadline)`), "and which have none");
    // ... with one record per policy, each under its own outbox row.
    const aRows = (await listNoticesE2({ userId: readerA })).filter((n) => ids.includes(n.outbox_id ?? -1));
    assert.equal(aRows.length, 4, "four ack_notices rows for A");
    assert.deepEqual(aRows.map((n) => n.outbox_id).sort(), [...ids].sort(), "one per outbox row");
    assert.ok(aRows.every((n) => n.kind === "due" && n.by_name === "system" && n.by_user_id === null), "kind 'due', by the system");
    assert.ok(aRows.every((n) => n.channels.includes("inapp") && n.channels.includes("email")), `every record shows the bundle's channels: ${JSON.stringify(aRows.map((n) => n.channels))}`);
    const aMail = sent.filter((m) => m.to === `${STAMP}-Reader A@example.test`);
    assert.equal(aMail.length, 1, "A was emailed once");
    assert.match(aMail[0].subject, /You have 4 policies to confirm$/);
    for (const p of policies) assert.ok(aMail[0].text.includes(p.title), `the mail lists ${p.title}`);
    assert.ok(aMail[0].text.includes(`${ORIGIN}/compliance`), "and links My policies");

    // B: two policies, two notices, each worded from B's own date.
    const own = await inboxOf(readerB, "ack_due");
    assert.deepEqual(
      own.map((n) => [n.title, n.link]).sort(),
      [
        [`Due in 2 days: confirm "${p1.title}"`, `/doc/${p1.id}#confirm-reading`],
        [`Overdue: confirm "${p2.title}"`, `/doc/${p2.id}#confirm-reading`],
      ].sort()
    );
    assert.match(own.find((n) => n.title.startsWith("Due in"))!.body, /^Due .+\.$/);
    const bMail = sent.filter((m) => m.to === `${STAMP}-Reader B@example.test`);
    assert.deepEqual(
      bMail.map((m) => m.subject).sort(),
      [`[CompassDocs] Due soon: confirm "${p1.title}"`, `[CompassDocs] Overdue: confirm "${p2.title}"`].sort().map((s) => s.replace(/^\[CompassDocs\]/, bMail[0].subject.split("]")[0] + "]"))
    );
    assert.ok(bMail.every((m) => /Please confirm by /.test(m.text)), "the due line is in the mail");
    assert.ok(bMail.every((m) => m.text.includes("#confirm-reading")), "the link lands on the card");
    const bRows = (await listNoticesE2({ userId: readerB })).filter((n) => ids.includes(n.outbox_id ?? -1));
    assert.equal(bRows.length, 2);
    assert.ok(bRows.every((n) => n.kind === "due" && n.channels.includes("email")));

    // C: in-app only, by choice; the record says so.
    const cRows = (await listNoticesE2({ userId: readerC })).filter((n) => ids.includes(n.outbox_id ?? -1));
    assert.equal(cRows.length, 1);
    assert.deepEqual(cRows[0].channels, ["inapp"], "the Policy reminders email is off for C");
    assert.equal(sent.filter((m) => m.to === `${STAMP}-Reader C due@example.test`).length, 0);
    assert.equal((await inboxOf(readerC, "ack_due")).length, 1);

    // The drain's audit row per 'due' row: ack.reminder_auto with the counts and who was bundled.
    const audit = (await auditRows("ack.reminder_auto", p1.id)).find((r) => r.details.outbox_id === ids[0])!;
    assert.ok(audit, "ack.reminder_auto by the drain");
    assert.equal(audit.actor_name, "system");
    assert.equal(audit.details.mode, "due");
    assert.equal(audit.details.pending, 3);
    assert.equal(audit.details.bundled, 1, "A was bundled");
    assert.equal(audit.details.noticed, 3, "three records under this row (A's from the bundle, B's and C's from the row)");
    assert.equal(audit.details.emailed, 2, "A (the bundle) and B; not C");
    assert.equal((await getAckOutboxRow(ids[0]))!.noticed, 3);
  });

  test("a bundle whose mail fails keeps every row of it for a retry that emails once and repeats no inbox row", async () => {
    const readerD = await newUser("Reader D due");
    const policies = [];
    for (let i = 1; i <= DUE_BUNDLE_OVER + 1; i++) policies.push(await newPolicy(`retry due ${i}`));
    const ids: number[] = [];
    for (const p of policies) {
      ids.push(
        await enqueueAckNotice(null, {
          document_id: p.id,
          mode: "due",
          source: "",
          actor: system,
          user_ids: [readerD],
          payload: { rows: [{ user_id: readerD, due_at: daysFromNow(1), overdue: false }] },
          delay_minutes: 0,
        })
      );
    }
    const failing: Mailer = async () => {
      throw new Error("SMTP down");
    };
    for (let i = 0; i < 12 && !(await Promise.all(ids.map((id) => claimed(id)()))).every(Boolean); i++) {
      await deliverAckNotices({ origin: ORIGIN, mailer: failing, limit: 50, documentIds: docIds });
    }
    for (const id of ids) {
      const row = (await getAckOutboxRow(id))!;
      assert.equal(row.done_at, null, `row ${id} is kept: the bundle's failure is charged to every row of it`);
      assert.match(row.error ?? "", /SMTP down/);
      assert.equal(row.attempts, 1);
    }
    assert.equal((await inboxOf(readerD, "ack_due")).length, 1, "the bundle reached the inbox once");
    let rows = (await listNoticesE2({ userId: readerD })).filter((n) => ids.includes(n.outbox_id ?? -1));
    assert.equal(rows.length, 4, "the record is written before the mail");
    assert.ok(rows.every((n) => n.channels.length === 1 && n.channels[0] === "inapp"), "without the email");

    // Ten minutes later another instance takes the rows; mail works now.
    await pool().query("UPDATE ack_outbox SET claimed_at = now() - interval '11 minutes' WHERE id = ANY($1)", [ids]);
    const sent: string[] = [];
    const working: Mailer = async (to, subject) => {
      for (const t of to) sent.push(`${t} ${subject}`);
    };
    for (let i = 0; i < 12 && !(await allDone(ids)); i++) await deliverAckNotices({ origin: ORIGIN, mailer: working, limit: 50, documentIds: docIds });
    assert.ok(await allDone(ids), "delivered on the retry");
    assert.equal(sent.filter((s) => s.startsWith(`${STAMP}-Reader D due@example.test`)).length, 1, "one mail, the bundle's");
    assert.match(sent[0], /You have 4 policies to confirm/);
    assert.equal((await inboxOf(readerD, "ack_due")).length, 1, "no second inbox row");
    rows = (await listNoticesE2({ userId: readerD })).filter((n) => ids.includes(n.outbox_id ?? -1));
    assert.equal(rows.length, 4, "the same four rows");
    assert.ok(rows.every((n) => n.channels.includes("inapp") && n.channels.includes("email")), "now with the email");
    for (const id of ids) {
      const row = (await getAckOutboxRow(id))!;
      assert.equal(row.attempts, 2);
      assert.equal(row.error, null);
      assert.equal(row.emailed, 1);
    }
  });

  test("an escalation row tells the owner and the leads about the overdue people, each linked to their own view, recorded under kind 'escalation'", async () => {
    const { id, title } = await newPolicy("escalation");
    // The actor plays the owner, A the lead; B and a third person are overdue.
    const readerE = await newUser("Reader E overdue");
    const outboxId = await enqueueAckNotice(null, {
      document_id: id,
      mode: "escalation",
      source: "",
      actor: system,
      user_ids: [actorId, readerA],
      payload: {
        days: 7,
        overdue: [
          { user_id: readerB, name: "Out Reader B", due_at: daysFromNow(-10) },
          { user_id: readerE, name: "Out Reader E overdue", due_at: daysFromNow(-9) },
        ],
        recipients: [
          { id: actorId, via: "owner" },
          { id: readerA, via: "lead" },
        ],
      },
      delay_minutes: 0,
    });
    const sent: { to: string; subject: string; text: string }[] = [];
    const mailer: Mailer = async (to, subject, text) => {
      for (const t of to) sent.push({ to: t, subject, text });
    };
    await drainUntil(mailer, done(outboxId), `row ${outboxId} delivered`);

    const owner = await inboxOf(actorId, "ack_escalation");
    assert.equal(owner.length, 1);
    assert.equal(owner[0].title, `Overdue: 2 people on "${title}"`);
    assert.equal(owner[0].body, "More than 7 days overdue: Out Reader B, Out Reader E overdue");
    assert.equal(owner[0].link, `/compliance/policies?policy=${id}`, "the owner opens the policy in the portal");
    const lead = await inboxOf(readerA, "ack_escalation");
    assert.equal(lead.length, 1);
    assert.equal(lead[0].link, "/compliance/team", "a lead opens the team view");
    assert.equal((await inboxOf(readerB, "ack_escalation")).length, 0, "the overdue people are not told they were escalated");

    const rows = (await listNoticesE2({ documentId: id })).filter((n) => n.outbox_id === outboxId);
    assert.deepEqual(rows.map((n) => n.user_id).sort(), [actorId, readerA].sort(), "one record per recipient");
    assert.ok(rows.every((n) => n.kind === "escalation" && n.by_name === "system"));
    assert.ok(rows.every((n) => n.channels.includes("inapp") && n.channels.includes("email")));
    assert.equal(sent.length, 2, "the owner and the lead were emailed");
    for (const m of sent) {
      assert.ok(m.subject.endsWith(`2 overdue on "${title}"`), m.subject);
      assert.ok(m.text.includes("Out Reader B (due"), "the mail lists the people with their dates");
      assert.doesNotMatch(m.text, /acknowledg|—/i);
    }
    assert.ok(sent.find((m) => m.to === `${STAMP}-Reader A@example.test`)!.text.includes(`${ORIGIN}/compliance/team`), "the lead's link");
    assert.ok(sent.find((m) => m.to === `${STAMP}-Actor@example.test`)!.text.includes(`${ORIGIN}/compliance/policies?policy=${id}`), "the owner's link");

    const audit = (await auditRows("ack.escalated", id)).find((r) => r.details.outbox_id === outboxId)!;
    assert.ok(audit, "ack.escalated by the drain with the delivery counts");
    assert.equal(audit.details.mode, "escalation");
    assert.equal(audit.details.pending, 2);
    assert.equal(audit.details.noticed, 2);
    assert.equal(audit.details.emailed, 2);

    // A policy that stopped requiring confirmation escalates to nobody.
    const stopped = await newPolicy("escalation stopped");
    const quietId = await enqueueAckNotice(null, {
      document_id: stopped.id,
      mode: "escalation",
      source: "",
      actor: system,
      user_ids: [actorId],
      payload: { days: 7, overdue: [{ user_id: readerB, name: "Out Reader B", due_at: null }], recipients: [{ id: actorId, via: "owner" }] },
      delay_minutes: 0,
    });
    await setAckRequired(stopped.id, false);
    await drainUntil(mailer, done(quietId), `row ${quietId} closed`);
    assert.equal((await listNoticesE2({ documentId: stopped.id })).length, 0, "nobody was told");
    assert.equal((await inboxOf(actorId, "ack_escalation")).length, 1, "still the one from before");
  });
});
