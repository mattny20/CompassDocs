// The notice outbox (1.10.1, H4) and the per-person coalescing it applies
// (H1): a fan-out is a row, claimed atomically by whichever instance's
// minute tick gets there first, delivered to the people pending at that
// moment, recorded per person (E3), retried after a failure without telling
// anyone twice, and retired after three failures.
//
// Run: npm run test:integration  (needs DATABASE_URL)

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
} from "../src/lib/db";
import { enqueueAckNotice, deliverAckNotices, noticeCopy } from "../src/lib/compliance";
import type { Mailer } from "../src/lib/compliance";
import { notify } from "../src/lib/notifications";
import { fixtureQuery } from "./support/retry";

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
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2) OR document_title LIKE $3", [
    docIds,
    userIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
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
    assert.deepEqual(
      (await inboxRows(readerB, `Reminder: confirm "${title}"`)).map((r) => [r.body, r.link]),
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
      (await inboxRows(readerA, `Changed. Please re-confirm "${title}"`)).map((r) => [r.body, r.link]),
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

    // A row that fails three times keeps its error, is audited and is never claimed again.
    const dead = await newPolicy("dead");
    const deadId = await enqueueAckNotice(null, { document_id: dead.id, mode: "reminder", source: "manual", actor: actor() });
    await pool().query("UPDATE ack_outbox SET attempts = 2 WHERE id = $1", [deadId]);
    await drainUntil(failing, async () => ((await getAckOutboxRow(deadId))!.attempts ?? 0) >= 3, `row ${deadId} on its third attempt`);
    row = (await getAckOutboxRow(deadId))!;
    assert.equal(row.attempts, 3);
    assert.equal(row.done_at, null);
    assert.match(row.error ?? "", /SMTP down/);
    const failed = await auditRows("ack.notice_failed", dead.id);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].details.attempts, 3);
    assert.match(String(failed[0].details.error), /SMTP down/);
    await pool().query("UPDATE ack_outbox SET claimed_at = now() - interval '11 minutes' WHERE id = $1", [deadId]);
    await drain(working);
    assert.equal((await getAckOutboxRow(deadId))!.attempts, 3, "never claimed again");
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
