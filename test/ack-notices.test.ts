// The per-person notice log (1.10.1, E3): every request and reminder is
// provable per recipient, with the channels that actually went out, and the
// row outlives the account. The portal's Request and Remind go through
// requestAcknowledgement / enqueueReminder, which only queue; the drain
// writes the record and the audit row.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  getSetting,
  createDocument,
  getDocument,
  setAckRequired,
  deleteUser,
  anonymiseComplianceRecord,
  getAckOutboxRow,
  pendingAckOutboxFor,
  listAckNotices,
} from "../src/lib/db";
import {
  requestAcknowledgement,
  enqueueReminder,
  enqueueAckNotice,
  deliverAckNotices,
  recordNotices,
} from "../src/lib/compliance";
import type { Mailer } from "../src/lib/compliance";
import { fixtureQuery } from "./support/retry";

const STAMP = `acknot-${Date.now()}`;
const ORIGIN = "https://docs.example.test";

let spaceId = 0;
let readerA = 0;
let readerB = 0;
let actorId = 0;
const userIds: number[] = [];
const docIds: number[] = [];
const actor = () => ({ id: actorId, name: "Not Actor" });
const emailOf = (tag: string) => `${STAMP}-${tag}@example.test`;

async function newUser(tag: string, prefs: Record<string, Record<string, boolean>> = {}): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, notify_prefs) VALUES ($1, $2, $3, 'viewer', 'active', $4) RETURNING id`,
    [`${STAMP}-${tag}`, `Not ${tag}`, emailOf(tag), JSON.stringify(prefs)]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function newDoc(title: string): Promise<{ id: number; title: string }> {
  const full = `${STAMP} ${title}`;
  const doc = await createDocument({
    space_id: spaceId,
    title: full,
    type: "policy",
    status: "published",
    content: "Policy body that everyone must read.",
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  return { id: doc.id, title: full };
}

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}
function recorder(): { sent: Sent[]; mailer: Mailer } {
  const sent: Sent[] = [];
  return {
    sent,
    mailer: async (to, subject, text, html) => {
      for (const t of to) sent.push({ to: t, subject, text, html: html ?? "" });
    },
  };
}

async function drainUntilDone(mailer: Mailer | null, id: number): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await deliverAckNotices({ origin: ORIGIN, mailer, limit: 50 });
    if ((await getAckOutboxRow(id))?.done_at) return;
  }
  assert.fail(`outbox row ${id} was never delivered`);
}

async function auditRow(action: string, docId: number): Promise<{ actor_id: number | null; actor_name: string; details: Record<string, unknown> } | undefined> {
  const r = await pool().query(
    "SELECT actor_id, actor_name, details FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id DESC LIMIT 1",
    [action, String(docId)]
  );
  return r.rows[0];
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Notices ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  readerA = await newUser("Reader A");
  // B turned the read-confirmation email off (Account → Notifications).
  readerB = await newUser("Reader B", { ack_requested: { email: false } });
  actorId = await newUser("Actor");
});

after(async () => {
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2) OR by_user_id = ANY($2) OR document_title LIKE $3", [
    docIds,
    userIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("the per-person notice log", () => {
  test("a request writes one row per pending user with the channels used; an opted-out email leaves inapp only", async () => {
    const doc = await newDoc("request");
    const r = await requestAcknowledgement(doc, actor(), ORIGIN, { notify: true });
    assert.ok(r.queued >= 2, `queued is the pending count now: ${r.queued}`);
    assert.ok(r.outbox_id);
    const live = (await getDocument(doc.id))!;
    assert.equal(live.ack_required, 1, "the document now requires confirmation");
    assert.ok(live.ack_last_reminded_at, "the one-hour Remind cooldown is stamped");
    const queued = (await getAckOutboxRow(r.outbox_id!))!;
    assert.equal(queued.mode, "request");
    assert.equal(queued.source, "manual");
    assert.equal(queued.actor_id, actorId);
    assert.equal(queued.user_ids, null);
    assert.equal(queued.done_at, null, "nothing was sent on the request path");
    assert.equal((await listAckNotices({ documentId: doc.id })).length, 0);
    assert.equal((await auditRow("ack.requested", doc.id)) ?? null, null, "and nothing audited yet");

    const { sent, mailer } = recorder();
    await drainUntilDone(mailer, r.outbox_id!);

    const notices = await listAckNotices({ documentId: doc.id });
    const a = notices.find((n) => n.user_id === readerA)!;
    const b = notices.find((n) => n.user_id === readerB)!;
    assert.ok(a && b, "one row per pending person");
    assert.deepEqual(a.channels, ["inapp", "email"]);
    assert.deepEqual(b.channels, ["inapp"], "the per-kind email preference is honored and the record shows it");
    for (const n of [a, b]) {
      assert.equal(n.kind, "request");
      assert.equal(n.document_title, doc.title);
      assert.equal(n.by_user_id, actorId);
      assert.equal(n.by_name, "Not Actor");
      assert.equal(n.outbox_id, r.outbox_id);
      assert.ok(n.sent_at);
    }
    assert.equal(a.user_name, "Not Reader A");
    assert.equal(a.user_email, emailOf("Reader A"));
    assert.equal(notices.filter((n) => n.user_id === readerA).length, 1);

    assert.equal(sent.filter((m) => m.to === emailOf("Reader A")).length, 1, "A was emailed once");
    assert.equal(sent.filter((m) => m.to === emailOf("Reader B")).length, 0, "B was not");
    const mail = sent.find((m) => m.to === emailOf("Reader A"))!;
    assert.match(mail.subject, new RegExp(`Action required: confirm "${doc.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`));
    assert.match(mail.text, /Not Actor requested that you read and confirm:/);
    assert.ok(mail.text.includes(`${ORIGIN}/doc/${doc.id}#confirm-reading`), "the link lands on the card");
    assert.match(mail.text, /and confirm at the end that you have read and understood it\.$/);
    assert.doesNotMatch(mail.text, /acknowledg/i, "glossary");
    assert.doesNotMatch(mail.text, /—/, "no em-dash");
    assert.ok(mail.html.includes("confirm at the end"));

    const row = (await getAckOutboxRow(r.outbox_id!))!;
    assert.equal(row.noticed, notices.length, "'noticed' is the count of rows actually written");
    assert.equal(row.emailed, notices.filter((n) => n.channels.includes("email")).length);
    assert.equal(row.emailed, sent.length);
    const audit = (await auditRow("ack.requested", doc.id))!;
    assert.ok(audit, "the drain writes ack.requested with real counts");
    assert.equal(audit.actor_id, actorId);
    assert.equal(audit.actor_name, "Not Actor");
    assert.equal(audit.details.noticed, notices.length);
    assert.equal(audit.details.emailed, sent.length);
    assert.equal(audit.details.pending, notices.length);
    assert.equal(audit.details.skipped_recent, 0);
    assert.equal(audit.details.source, "manual");
  });

  test("Request with notify off requires without telling anyone; Remind queues a reminder and stamps the cooldown", async () => {
    const doc = await newDoc("quiet");
    const r = await requestAcknowledgement(doc, actor(), ORIGIN, { notify: false });
    assert.deepEqual(r, { queued: 0, outbox_id: null });
    const quiet = (await getDocument(doc.id))!;
    assert.equal(quiet.ack_required, 1);
    assert.equal(quiet.ack_last_reminded_at ?? null, null, "a quiet switch-on does not start the Remind cooldown");
    assert.deepEqual(await pendingAckOutboxFor(doc.id), []);
    assert.equal((await auditRow("ack.requested", doc.id)) ?? null, null, "requestAcknowledgement writes no audit row");

    const rem = await enqueueReminder(doc, actor(), ORIGIN);
    assert.ok(rem.queued >= 2);
    assert.ok((await getDocument(doc.id))!.ack_last_reminded_at, "stamped");
    const queued = (await getAckOutboxRow(rem.outbox_id))!;
    assert.equal(queued.mode, "reminder");
    const { sent, mailer } = recorder();
    await drainUntilDone(mailer, rem.outbox_id);
    const a = (await listAckNotices({ documentId: doc.id, userId: readerA }))[0];
    assert.equal(a.kind, "reminder");
    assert.deepEqual(a.channels, ["inapp", "email"]);
    assert.match(sent.find((m) => m.to === emailOf("Reader A"))!.subject, /Reminder: confirm/);
    assert.match(sent.find((m) => m.to === emailOf("Reader A"))!.text, /sent a reminder that you read and confirm:/);
    const inbox = await pool().query("SELECT title, body FROM notifications WHERE user_id = $1 AND title = $2", [
      readerA,
      `Reminder: confirm "${doc.title}"`,
    ]);
    assert.equal(inbox.rows.length, 1);
    assert.equal(inbox.rows[0].body, `You still need to read and confirm "${doc.title}".`);
    const audit = (await auditRow("ack.reminder_sent", doc.id))!;
    assert.equal(audit.details.noticed, (await listAckNotices({ documentId: doc.id })).filter((n) => n.outbox_id === rem.outbox_id).length);
  });

  test("deleteUser keeps the row with the name snapshot; anonymising rewrites it", async () => {
    const leaver = await newUser("Leaver");
    const asker = await newUser("Asker");
    const doc = await newDoc("leaver");
    await setAckRequired(doc.id, true);
    const outboxId = await enqueueAckNotice(null, {
      document_id: doc.id,
      mode: "request",
      source: "manual",
      actor: { id: asker, name: "Not Asker" },
      user_ids: [leaver, readerA],
    });
    await drainUntilDone(null, outboxId);
    let rows = await listAckNotices({ documentId: doc.id });
    assert.deepEqual(rows.map((n) => n.user_id).sort(), [leaver, readerA].sort());
    assert.ok(rows.every((n) => n.channels.length === 1 && n.channels[0] === "inapp"), "no mailer: inapp only");

    assert.equal(await deleteUser(leaver), true);
    rows = await listAckNotices({ documentId: doc.id });
    const kept = rows.find((n) => n.user_name === "Not Leaver")!;
    assert.ok(kept, "the row survived the account");
    assert.equal(kept.user_id, null);
    assert.equal(kept.user_email, emailOf("Leaver"));
    assert.equal(kept.by_name, "Not Asker");

    const result = await anonymiseComplianceRecord(readerA);
    assert.ok(result.rows >= 1, "notice rows naming the person count");
    const anon = (await listAckNotices({ userId: readerA, documentId: doc.id }))[0];
    assert.equal(anon.user_name, `Former staff #${readerA}`);
    assert.equal(anon.user_email, "");
    await anonymiseComplianceRecord(asker);
    rows = await listAckNotices({ documentId: doc.id });
    assert.ok(rows.every((n) => n.by_name === `Former staff #${asker}`), "the asker's name is rewritten too");
    assert.ok(rows.every((n) => n.kind === "request" && n.document_title === doc.title), "what the row says stays");
    // Undo for the later tests (they expect A's real name).
    await pool().query("UPDATE users SET name = $2 WHERE id = $1", [readerA, "Not Reader A"]);
  });

  test("recordNotices is the single writer: a digest row with no outbox and no person asking", async () => {
    const doc = await newDoc("digest");
    const [id] = await recordNotices([
      {
        user_id: readerB,
        user_name: "Not Reader B",
        user_email: emailOf("Reader B"),
        document_id: doc.id,
        document_title: doc.title,
        kind: "digest",
        channels: ["email", "email"],
      },
    ]);
    assert.ok(id > 0);
    const [row] = await listAckNotices({ documentId: doc.id });
    assert.equal(row.id, id);
    assert.equal(row.kind, "digest");
    assert.deepEqual(row.channels, ["email"], "channels are a set");
    assert.equal(row.by_user_id, null);
    assert.equal(row.by_name, "system");
    assert.equal(row.outbox_id, null);
    assert.deepEqual(await recordNotices([]), []);
  });
});
