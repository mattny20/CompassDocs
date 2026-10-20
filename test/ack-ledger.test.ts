// The decision ledger (1.10.0, C1): every keep and every reset of a confirmed
// document's confirmations is a row in ack_decisions, written by exactly two
// helpers inside the caller's transaction, with name snapshots, the measured
// size of the change and the counts it touched. The readers feed the record
// pages, the portal and both CSVs; the audit vocabulary has a label for every
// key the family can emit.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  pool,
  getSetting,
  createDocument,
  updateDocument,
  setAckRequired,
  recordAcknowledgement,
  getCurrentAck,
  getAckVersionInfo,
  listVersions,
  listAckDecisions,
  lastAckDecision,
  keptSinceLastReset,
  ackSummary,
  complianceDocs,
  resetAcknowledgements,
  keepAcknowledgements,
  recordAckDecision,
  anonymiseComplianceRecord,
  deleteDocument,
  purgeDocument,
  getAttestedVersion,
  createChangeRequest,
  approveChangeRequest,
  backfillVersionProvenance,
  claimReconfirmation,
  setAckLastReminded,
  pendingAckOutboxFor,
} from "../src/lib/db";
import { ACK_AUDIT_ACTIONS } from "../src/lib/audit";
import { fixtureQuery } from "./support/retry";
import { hasActionLabel, actionLabel } from "../src/lib/audit-labels";

const STAMP = `ackled-${Date.now()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let spaceId = 0;
let readerId = 0;
let editorId = 0;
let approverId = 0;
const docIds: number[] = [];

const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);

async function newPolicy(title: string, content = LONG_TEXT): Promise<{ id: number; v1: number }> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content,
    summary: "",
    tags: [],
    author: "test",
  });
  await setAckRequired(doc.id, true);
  docIds.push(doc.id);
  return { id: doc.id, v1: (await listVersions(doc.id))[0].id };
}

async function confirmedPolicy(title: string, content = LONG_TEXT) {
  const p = await newPolicy(title, content);
  await recordAcknowledgement(p.id, readerId, "", p.v1);
  return p;
}

const marker = (id: number) =>
  pool()
    .query("SELECT ack_revision_at::text AS at, ack_version_id FROM documents WHERE id = $1", [id])
    .then((r) => r.rows[0]);

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Ledger ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Led Reader', $2, 'viewer', 'active'),
       ($3, 'Led Editor', $4, 'editor', 'active'),
       ($5, 'Led Approver', $6, 'approver', 'active')
     RETURNING id`,
    [
      `${STAMP}-reader`,
      `${STAMP}-reader@example.test`,
      `${STAMP}-editor`,
      `${STAMP}-editor@example.test`,
      `${STAMP}-approver`,
      `${STAMP}-approver@example.test`,
    ]
  );
  readerId = users.rows[0].id;
  editorId = users.rows[1].id;
  approverId = users.rows[2].id;
});

after(async () => {
  const userIds = [readerId, editorId, approverId];
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2) OR document_title LIKE $3", [
    docIds,
    userIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [
    docIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1) OR document_title LIKE $2", [
    docIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM change_requests WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("the decision ledger", () => {
  test("a kept save writes a row with the measured change, the suggestion and the counts", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} kept`);
    const edited = LONG_TEXT.replace("Clause 1: staff", "Clause 1: all staff");
    await updateDocument(id, {
      content: edited,
      ackPolicy: "keep",
      ackReason: "Clarified who the first clause covers",
      ackActor: { id: editorId, name: "Led Editor" },
      ackSource: "edit",
    });
    const rows = await listAckDecisions(id);
    assert.equal(rows.length, 1);
    const row = rows[0];
    const v2 = (await listVersions(id))[0].id;
    assert.equal(row.document_id, id);
    assert.equal(row.outcome, "kept");
    assert.equal(row.version_id, v2);
    assert.equal(row.rev, 2);
    assert.equal(row.source, "edit");
    assert.equal(row.scope, "all");
    assert.equal(row.decided_by, editorId);
    assert.equal(row.decided_by_name, "Led Editor");
    assert.equal(row.submitted_policy, "keep");
    assert.equal(row.submitted_by, null);
    assert.equal(row.reason, "Clarified who the first clause covers");
    assert.equal(typeof row.change_pct, "number");
    assert.ok(row.change_pct! > 0 && row.change_pct! < 5, `a one-word change is small: ${row.change_pct}%`);
    assert.equal(row.suggested, "keep", "the heuristic agrees with the editor");
    assert.equal(row.overrode_suggestion, false);
    assert.equal(row.confirmations_affected, 1, "one confirmation kept standing");
    assert.ok(row.eligible! >= 3, "the audience at the time");
    assert.equal(row.notified_at, null);
    assert.ok(row.decided_at);
    const stored = await pool().query("SELECT document_title, change_json FROM ack_decisions WHERE id = $1", [row.id]);
    assert.equal(stored.rows[0].document_title, `${STAMP} kept`);
    assert.equal(JSON.parse(stored.rows[0].change_json).wordsChanged, 1);
    assert.equal((await marker(id)).ack_version_id, v1, "a keep never moves the marker");
  });

  test("a reset against the heuristic records that the suggestion was overridden", async () => {
    const { id } = await confirmedPolicy(`${STAMP} override`);
    await updateDocument(id, {
      content: LONG_TEXT.replace("Clause 2: staff", "Clause 2: staff and contractors"),
      ackPolicy: "reset",
      ackReason: "Contractors are now in scope, everyone must re-read",
      ackActor: { id: editorId, name: "Led Editor" },
      ackSource: "edit",
    });
    const [row] = await listAckDecisions(id);
    assert.equal(row.outcome, "reset");
    assert.equal(row.suggested, "keep");
    assert.equal(row.overrode_suggestion, true);
    assert.equal(row.confirmations_affected, 1, "one confirmation went stale");
  });

  test("a reset writes its row and moves the marker in one transaction; a rollback leaves neither", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} atomic`);
    const before = await marker(id);
    const v2 = (
      await pool().query<{ id: number }>(
        "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1, $2, 'new text', 'test', 'Edited') RETURNING id",
        [id, `${STAMP} atomic`]
      )
    ).rows[0].id;
    const opts = {
      versionId: v2,
      actor: { id: approverId, name: "Led Approver" },
      source: "manual" as const,
      reason: "Annual re-confirmation of the whole set",
    };

    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const r = await resetAcknowledgements(client, id, opts);
      assert.equal(r.confirmations_reset, 1);
      assert.ok(r.decision_id);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.deepEqual(await marker(id), before, "the marker is where it was");
    assert.equal((await listAckDecisions(id)).length, 0, "and there is no row");
    assert.ok(await getCurrentAck(id, readerId), "the confirmation still counts");

    const client2 = await pool().connect();
    try {
      await client2.query("BEGIN");
      await resetAcknowledgements(client2, id, opts);
      await client2.query("COMMIT");
    } finally {
      client2.release();
    }
    const after = await marker(id);
    assert.equal(after.ack_version_id, v2);
    assert.notEqual(after.at, before.at);
    assert.notEqual(after.ack_version_id, v1);
    const [row] = await listAckDecisions(id);
    assert.equal(row.outcome, "reset");
    assert.equal(row.source, "manual");
    assert.equal(row.decided_by, approverId);
    assert.equal(row.change_pct, null, "nothing was measured for a manual ask");
    assert.equal(await getCurrentAck(id, readerId), undefined, "everyone is asked again");
    // The row's decided_at is the marker: both are the transaction's now().
    const same = await pool().query(
      "SELECT (x.decided_at = d.ack_revision_at) AS same FROM ack_decisions x JOIN documents d ON d.id = x.document_id WHERE x.id = $1",
      [row.id]
    );
    assert.equal(same.rows[0].same, true);
  });

  test("an approval row stores the submitter beside the approver", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} approval`);
    await keepAcknowledgements(pool(), id, {
      versionId: v1,
      actor: { id: approverId, name: "Led Approver" },
      source: "approval",
      reason: "Submitted as an editorial fix; agreed",
      submittedPolicy: "keep",
      submittedBy: { id: editorId, name: "Led Editor" },
    });
    const [row] = await listAckDecisions(id);
    assert.equal(row.outcome, "kept");
    assert.equal(row.source, "approval");
    assert.equal(row.decided_by, approverId);
    assert.equal(row.decided_by_name, "Led Approver");
    assert.equal(row.submitted_by, editorId);
    assert.equal(row.submitted_by_name, "Led Editor");
    assert.equal(row.submitted_policy, "keep");
  });

  test("a caller without a policy writes source 'default' and the version note as the reason", async () => {
    const { id } = await confirmedPolicy(`${STAMP} default`);
    const doc = await updateDocument(id, { content: "Imported replacement", versionNote: "Imported" });
    assert.equal(doc!.ack_outcome!.reset, true);
    const [row] = await listAckDecisions(id);
    assert.equal(row.outcome, "reset");
    assert.equal(row.source, "default");
    assert.equal(row.reason, "Imported");
    assert.equal(row.submitted_policy, "");
    assert.equal(row.decided_by, null);
    assert.equal(row.decided_by_name, "test");
  });

  test("decisions list newest first; lastAckDecision filters by outcome; kept-since-reset counts and measures drift", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} history`);
    const editor = { id: editorId, name: "Led Editor" };
    assert.equal(await lastAckDecision(id), null);
    assert.deepEqual(await keptSinceLastReset(id), { count: 0, drift_pct: 0 });

    let text = LONG_TEXT.replace("Clause 3: staff", "Clause 3: every member of staff");
    await updateDocument(id, { content: text, ackPolicy: "keep", ackReason: "Wording in clause three", ackActor: editor, ackSource: "edit" });
    text = text.replace("Clause 4: staff", "Clause 4: all staff");
    await updateDocument(id, { content: text, ackPolicy: "keep", ackReason: "Wording in clause four", ackActor: editor, ackSource: "edit" });
    const kept = await keptSinceLastReset(id);
    assert.equal(kept.count, 2);
    assert.ok(kept.drift_pct > 0, "the live text drifted from v1");
    const summary = await ackSummary(id, { baseline: true });
    assert.equal(summary.version_id, v1, "the marker still points at what people confirmed");
    assert.equal(summary.baseline!.content, LONG_TEXT);
    assert.equal(summary.last_decision!.reason, "Wording in clause four");

    await updateDocument(id, {
      content: text + "\n\nClause 41: a new obligation.",
      ackPolicy: "reset",
      ackReason: "A new clause everyone must read",
      ackActor: editor,
      ackSource: "edit",
    });
    const rows = await listAckDecisions(id);
    assert.deepEqual(
      rows.map((r) => r.reason),
      ["A new clause everyone must read", "Wording in clause four", "Wording in clause three"]
    );
    assert.deepEqual(
      rows.map((r) => r.rev),
      [4, 3, 2]
    );
    assert.equal((await lastAckDecision(id))!.outcome, "reset");
    assert.equal((await lastAckDecision(id, { outcome: "kept" }))!.reason, "Wording in clause four");
    assert.deepEqual(await keptSinceLastReset(id), { count: 0, drift_pct: 0 }, "the reset starts a new count");

    // One more keep after the reset: counted from the new marker, drift
    // measured against the new confirmed text (one word of a longer text).
    await updateDocument(id, {
      content: (text + "\n\nClause 41: a new obligation.").replace("Clause 5: staff", "Clause 5: staff members"),
      ackPolicy: "keep",
      ackReason: "Wording in clause five",
      ackActor: editor,
      ackSource: "edit",
    });
    const again = await keptSinceLastReset(id);
    assert.equal(again.count, 1);
    assert.ok(again.drift_pct > 0 && again.drift_pct < 2, `one word of drift: ${again.drift_pct}%`);
  });

  test("ackSummary gives counts, the marker, the newest version and the last decision, and never names people", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} summary`);
    const s = await ackSummary(id);
    assert.equal(s.required, true);
    assert.ok(s.eligible >= 3);
    assert.equal(s.current, 1);
    assert.equal(s.pending, s.eligible - 1);
    assert.ok(s.reset_at);
    assert.equal(s.version_id, v1);
    assert.equal(s.rev, 1);
    assert.equal(s.latest_version_id, v1);
    assert.equal(s.latest_rev, 1);
    assert.equal(s.edit_default, "ask");
    assert.equal(s.last_decision, null);
    assert.equal(s.baseline, undefined, "the text only when asked for");
    const json = JSON.stringify(s);
    assert.ok(!json.includes("Led Reader") && !json.includes("example.test"), "no names, no emails");
    const withBaseline = await ackSummary(id, { baseline: true });
    assert.deepEqual(withBaseline.baseline, { version_id: v1, rev: 1, title: `${STAMP} summary`, content: LONG_TEXT });
    await setAckRequired(id, false);
    assert.equal((await ackSummary(id)).required, false);
    await assert.rejects(ackSummary(-1), /not found/);
  });

  test("getAckVersionInfo tells the confirmed version from the newest one after a kept edit", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} versions`);
    await updateDocument(id, {
      content: LONG_TEXT + "\n\nAppendix.",
      author: "Led Editor",
      ackPolicy: "keep",
      ackReason: "Appendix added for reference only",
      ackActor: { id: editorId, name: "Led Editor" },
      ackSource: "edit",
    });
    const v2 = (await listVersions(id))[0].id;
    const info = await getAckVersionInfo(id);
    assert.equal(info.version_id, v1);
    assert.equal(info.author, "test");
    assert.equal(info.latest_version_id, v2);
    assert.equal(info.latest_rev, 2);
    assert.equal(info.latest_author, "Led Editor");
    assert.ok(info.latest_created_at && info.created_at);
    assert.ok(new Date(info.latest_created_at!).getTime() >= new Date(info.created_at!).getTime());
  });

  test("complianceDocs rows carry the last decision, the last reset, and the kept edits since", async () => {
    const { id } = await confirmedPolicy(`${STAMP} portal`);
    const editor = { id: editorId, name: "Led Editor" };
    const fresh = (await complianceDocs()).find((d) => d.id === id)!;
    assert.equal(fresh.last_decision, null);
    assert.equal(fresh.last_reset, null);
    assert.equal(fresh.kept_since_reset, 0);
    assert.equal(fresh.drift_pct, 0);

    await updateDocument(id, {
      content: LONG_TEXT.replace("Clause 6", "Clause six"),
      ackPolicy: "reset",
      ackReason: "Numbering changed throughout the clause",
      ackActor: editor,
      ackSource: "edit",
    });
    await updateDocument(id, {
      content: LONG_TEXT.replace("Clause 6", "Clause six").replace("Clause 7: staff", "Clause 7: all staff"),
      ackPolicy: "keep",
      ackReason: "Wording in clause seven only",
      ackActor: editor,
      ackSource: "edit",
    });
    const row = (await complianceDocs()).find((d) => d.id === id)!;
    assert.equal(row.acked, 0);
    assert.deepEqual(
      { ...row.last_decision, decided_at: "x" },
      { decided_at: "x", decided_by_name: "Led Editor", reason: "Wording in clause seven only", outcome: "kept", source: "edit" }
    );
    assert.equal(row.last_reset!.reason, "Numbering changed throughout the clause");
    assert.equal(row.last_reset!.outcome, "reset");
    assert.equal(row.kept_since_reset, 1);
    assert.ok(row.drift_pct > 0);
  });

  test("anonymising rewrites the names a decision carries, not what it says", async () => {
    const { id } = await confirmedPolicy(`${STAMP} anon`);
    await updateDocument(id, {
      content: LONG_TEXT + "\n\nFootnote.",
      ackPolicy: "keep",
      ackReason: "Footnote added for the reader",
      ackActor: { id: approverId, name: "Led Approver" },
      ackSource: "edit",
    });
    await keepAcknowledgements(pool(), id, {
      versionId: (await listVersions(id))[0].id,
      actor: { id: editorId, name: "Led Editor" },
      source: "approval",
      reason: "Agreed on review of the footnote",
      submittedPolicy: "keep",
      submittedBy: { id: approverId, name: "Led Approver" },
    });
    const result = await anonymiseComplianceRecord(approverId);
    // The person has no confirmations; every rewritten row is a decision
    // (these two, plus the ones earlier tests in this file had them take).
    assert.ok(result.rows >= 2, `decision rows naming the person were rewritten: ${result.rows}`);
    assert.equal(result.snapshots_rewritten, 0);
    const rows = await listAckDecisions(id);
    assert.equal(rows[1].decided_by_name, `Former staff #${approverId}`);
    assert.equal(rows[1].reason, "Footnote added for the reader");
    assert.equal(rows[0].submitted_by_name, `Former staff #${approverId}`);
    assert.equal(rows[0].decided_by_name, "Led Editor", "other names stay");
  });

  test("purging a policy archives the versions its decisions cite", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} purged`, "First text");
    await updateDocument(id, {
      content: "First text, kept",
      ackPolicy: "keep",
      ackReason: "A comma, nothing more than that",
      ackActor: { id: editorId, name: "Led Editor" },
      ackSource: "edit",
    });
    const v2 = (await listVersions(id))[0].id;
    await deleteDocument(id);
    assert.equal(await purgeDocument(id), true);
    const archived = await pool().query("SELECT version_id FROM attested_texts WHERE document_id = $1 ORDER BY version_id", [id]);
    assert.deepEqual(
      archived.rows.map((r) => r.version_id),
      [v1, v2],
      "v1 (confirmed, the marker) and v2 (cited by the kept decision) are both archived"
    );
    const text = await getAttestedVersion(v2);
    assert.equal(text?.source, "archived");
    assert.equal(text?.content_sha256, sha("First text, kept"));
    const row = await pool().query("SELECT document_id, document_title, version_id FROM ack_decisions WHERE document_title = $1", [
      `${STAMP} purged`,
    ]);
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].document_id, null, "the FK was set null");
    assert.equal(row.rows[0].version_id, v2, "the plain id survived the purge");
  });

  test("recordAckDecision is the single insert both writers use", async () => {
    const { id, v1 } = await newPolicy(`${STAMP} direct`);
    const decisionId = await recordAckDecision(pool(), {
      document_id: id,
      document_title: `${STAMP} direct`,
      version_id: v1,
      outcome: "retired",
      source: "manual",
      decided_by: approverId,
      decided_by_name: "Led Approver",
      reason: "Policy withdrawn",
      confirmations_affected: 7,
      eligible: 9,
    });
    assert.ok(decisionId > 0);
    const [row] = await listAckDecisions(id);
    assert.equal(row.id, decisionId);
    assert.equal(row.outcome, "retired");
    assert.equal(row.confirmations_affected, 7);
    assert.equal(row.eligible, 9);
    assert.equal(row.change_pct, null);
    assert.equal(row.overrode_suggestion, false);
  });
});

describe("version provenance (C6)", () => {
  test("a direct publish stamps published_by from the acting user, the author byline otherwise", async () => {
    const { id } = await confirmedPolicy(`${STAMP} provenance`);
    const [v1] = await listVersions(id);
    assert.equal(v1.published_by, null, "createDocument has no account to stamp");
    assert.equal(v1.published_by_name, "test", "but the byline is the name");
    assert.equal(v1.approved_by, null);
    assert.equal(v1.approved_by_name, "");
    assert.equal(v1.change_request_id, null);

    await updateDocument(id, {
      content: LONG_TEXT + "\n\nClause 41: a new obligation.",
      ackPolicy: "reset",
      ackReason: "A new clause everyone must read",
      ackActor: { id: editorId, name: "Led Editor" },
      ackSource: "edit",
    });
    const [v2] = await listVersions(id);
    assert.equal(v2.published_by, editorId);
    assert.equal(v2.published_by_name, "Led Editor");
    assert.equal(v2.approved_by, null);
    assert.equal(v2.approved_by_name, "");
    assert.equal(v2.change_request_id, null);
    let info = await getAckVersionInfo(id);
    assert.equal(info.version_id, v2.id, "the marker moved");
    assert.equal(info.published_by_name, "Led Editor");
    assert.equal(info.approved_by_name, "");
    assert.equal(info.latest_published_by_name, "Led Editor");

    // No actor (an import, the API without a session): the byline.
    await updateDocument(id, { content: v2.content + "\n\nAppendix.", author: "Imported Author", versionNote: "Imported" });
    const [v3] = await listVersions(id);
    assert.equal(v3.published_by, null);
    assert.equal(v3.published_by_name, "Imported Author");
    info = await getAckVersionInfo(id);
    assert.equal(info.latest_published_by_name, "Imported Author");
  });

  test("an approval stamps published_by = submitter, approved_by = reviewer and change_request_id", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} approved`);
    const crId = await createChangeRequest({
      document_id: id,
      kind: "edit",
      title: `${STAMP} approved`,
      content: LONG_TEXT.replace("Clause 2: staff", "Clause 2: staff and contractors"),
      summary: "",
      tags: [],
      type: "policy",
      target_status: "published",
      note: "Contractors are now in scope",
      created_by: editorId,
    });
    const result = await approveChangeRequest(crId, approverId, "Led Approver");
    assert.ok(result && result.version_written);
    const [v2] = await listVersions(id);
    assert.notEqual(v2.id, v1);
    assert.equal(v2.published_by, editorId, "the submitter published the words");
    assert.equal(v2.published_by_name, "Led Editor");
    assert.equal(v2.approved_by, approverId, "the reviewer approved them");
    assert.equal(v2.approved_by_name, "Led Approver");
    assert.equal(v2.change_request_id, crId);
    assert.match(v2.note, /approved by Led Approver$/, "the note keeps saying so");
    const info = await getAckVersionInfo(id);
    assert.equal(info.version_id, v2.id);
    assert.equal(info.published_by_name, "Led Editor");
    assert.equal(info.approved_by_name, "Led Approver");
    assert.equal(info.latest_approved_by_name, "Led Approver");
    const [decision] = await listAckDecisions(id);
    assert.equal(decision.decided_by, approverId, "the ledger and the version agree");
    assert.equal(decision.submitted_by, editorId);
  });

  test("the backfill fills names once: the byline, and the approver from the legacy note", async () => {
    const { id } = await newPolicy(`${STAMP} legacy`);
    const legacy = await pool().query<{ id: number }>(
      `INSERT INTO doc_versions (document_id, title, content, author, note) VALUES
         ($1, $2, 'a', 'Led Editor', 'Fix typo — approved by Priya Patel'),
         ($1, $2, 'b', 'Led Editor', 'Approved by Priya Patel'),
         ($1, $2, 'c', 'Led Editor', 'Edited')
       RETURNING id`,
      [id, `${STAMP} legacy`]
    );
    const [withNote, bareNote, plain] = legacy.rows.map((r) => r.id);
    const read = async () =>
      (
        await pool().query<{ id: number; published_by: number | null; published_by_name: string; approved_by: number | null; approved_by_name: string }>(
          "SELECT id, published_by, published_by_name, approved_by, approved_by_name FROM doc_versions WHERE id = ANY($1) ORDER BY id",
          [[withNote, bareNote, plain]]
        )
      ).rows;
    assert.ok((await read()).every((r) => r.published_by_name === "" && r.approved_by_name === ""), "raw rows start blank");

    const n = await backfillVersionProvenance(pool());
    assert.ok(n.published >= 3 && n.approved >= 2, `rows filled: ${JSON.stringify(n)}`);
    assert.deepEqual(
      (await read()).map((r) => [r.published_by, r.published_by_name, r.approved_by, r.approved_by_name]),
      [
        [null, "Led Editor", null, "Priya Patel"],
        [null, "Led Editor", null, "Priya Patel"],
        [null, "Led Editor", null, ""],
      ],
      "names only: a name is not an account"
    );

    // Once: a later change to a filled row is not undone by a second run.
    await pool().query("UPDATE doc_versions SET approved_by_name = 'Someone Else', published_by_name = 'Renamed' WHERE id = $1", [withNote]);
    await backfillVersionProvenance(pool());
    const again = (await read()).find((r) => r.id === withNote)!;
    assert.equal(again.approved_by_name, "Someone Else");
    assert.equal(again.published_by_name, "Renamed");
    assert.equal(await getSetting("migrated_version_provenance"), "1", "the boot ran the one-shot and said so");
  });
});

describe("ask everyone to re-confirm (A7)", () => {
  const manager = () => ({ id: approverId, name: "Led Approver" });

  /** One claim in its own transaction, the way the route runs it (client null) but visible to Promise.all. */
  const claim = (id: number, reason: string) => async () => {
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const r = await claimReconfirmation(client, id, { source: "manual", reason, actor: manager() });
      await client.query("COMMIT");
      return r;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  };

  const ackRows = async (id: number) =>
    (await pool().query<{ n: number }>("SELECT COUNT(*)::int AS n FROM acknowledgements WHERE document_id = $1", [id])).rows[0].n;

  test("two parallel claims produce one decision row, one notice and one refusal; the marker and version move; prior confirmations stay", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} reask`);
    // A kept edit first, so the newest version is not the confirmed one: the
    // claim must move the marker onto it without writing a version of its own.
    await updateDocument(id, {
      content: LONG_TEXT.replace("Clause 1: staff", "Clause 1: all staff"),
      ackPolicy: "keep",
      ackReason: "Clarified who the first clause covers",
      ackActor: { id: editorId, name: "Led Editor" },
      ackSource: "edit",
    });
    const v2 = (await listVersions(id))[0].id;
    const before = await marker(id);
    assert.equal(before.ack_version_id, v1, "the keep left the marker at v1");
    assert.ok(await getCurrentAck(id, readerId), "the reader's v1 confirmation is current");

    const [a, b] = await Promise.all([
      claim(id, "Section 4 now applies to contractors too")(),
      claim(id, "Please read the contractor clause again")(),
    ]);
    const won = [a, b].filter((r) => r.claimed);
    const lost = [a, b].filter((r) => !r.claimed);
    assert.equal(won.length, 1, "exactly one claim went through");
    assert.equal(lost.length, 1, "the other was refused");
    const winner = won[0];
    const loser = lost[0];
    if (!winner.claimed || loser.claimed) throw new Error("unreachable");
    assert.equal(winner.confirmations_reset, 1, "one confirmation went stale");
    assert.ok(winner.eligible >= 3, "the audience at the time");
    assert.equal(winner.version_id, v2, "the marker is on the newest version");
    assert.equal(winner.rev, 2);
    assert.equal(winner.title, `${STAMP} reask`);
    assert.equal(winner.space_id, spaceId);
    assert.ok(winner.decision_id > 0 && winner.outbox_id > 0);
    assert.ok(loser.last_asked_at, "the refusal says when readers were last asked");
    assert.equal(
      new Date(loser.last_asked_at!).toISOString().slice(0, 16),
      new Date(winner.marker).toISOString().slice(0, 16),
      "and that stamp is the winner's"
    );

    // The marker and the version moved once; the Remind cooldown is stamped.
    const after = await marker(id);
    assert.equal(after.ack_version_id, v2);
    assert.notEqual(after.at, before.at);
    const stamped = await pool().query<{ reminded: string | null; versions: number }>(
      `SELECT ack_last_reminded_at::text AS reminded,
              (SELECT COUNT(*)::int FROM doc_versions WHERE document_id = $1) AS versions
       FROM documents WHERE id = $1`,
      [id]
    );
    assert.ok(stamped.rows[0].reminded, "the cooldown is stamped");
    assert.equal(stamped.rows[0].versions, 2, "no version row was written");

    // One ledger row for the re-ask (beside the kept edit), from the claim that won.
    const rows = await listAckDecisions(id);
    assert.equal(rows.length, 2, "the kept edit and one reset: the refused claim wrote nothing");
    const [reset, kept] = rows;
    assert.equal(kept.outcome, "kept");
    assert.equal(reset.id, winner.decision_id);
    assert.equal(reset.outcome, "reset");
    assert.equal(reset.source, "manual");
    assert.equal(reset.scope, "all");
    assert.ok(
      ["Section 4 now applies to contractors too", "Please read the contractor clause again"].includes(reset.reason),
      "the reason is the winner's"
    );
    assert.equal(reset.version_id, v2);
    assert.equal(reset.rev, 2);
    assert.equal(reset.decided_by, approverId);
    assert.equal(reset.decided_by_name, "Led Approver");
    assert.equal(reset.confirmations_affected, 1);
    assert.equal(reset.change_pct, null, "nothing was measured: the text did not change");
    assert.equal(reset.notified_at, null, "the drain stamps it later");
    const same = await pool().query(
      "SELECT (x.decided_at = d.ack_revision_at) AS same FROM ack_decisions x JOIN documents d ON d.id = x.document_id WHERE x.id = $1",
      [reset.id]
    );
    assert.equal(same.rows[0].same, true, "the row and the marker carry one stamp");

    // One notice, immediate, for everyone pending at delivery, with the reason as the body.
    const queued = await pendingAckOutboxFor(id);
    assert.equal(queued.length, 1, "one outbox row: the refused claim queued nothing");
    assert.equal(queued[0].id, winner.outbox_id);
    assert.equal(queued[0].mode, "updated");
    assert.equal(queued[0].source, "manual");
    assert.equal(queued[0].reason, reset.reason);
    assert.equal(queued[0].user_ids, null);
    assert.equal(queued[0].actor_id, approverId);
    assert.ok(new Date(queued[0].not_before).getTime() <= Date.now() + 1000, "manual asks go out at once");

    // Everyone is asked again; the old row stays in the ledger.
    assert.equal(await getCurrentAck(id, readerId), undefined, "the reader is pending again");
    assert.equal(await ackRows(id), 1, "the prior confirmation is kept, not deleted");
    const s = await ackSummary(id);
    assert.equal(s.current, 0);
    assert.equal(s.version_id, v2);
    assert.equal(s.last_decision!.id, reset.id);
  });

  test("the one-hour guard refuses a claim inside the hour after any ask, request or reminder, and lets one through after it", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} guard`);
    // A Request or Remind stamp blocks a re-ask too: the three share the hour.
    await setAckLastReminded(id);
    const blocked = await claimReconfirmation(null, id, { source: "manual", reason: "Blocked by the reminder stamp", actor: manager() });
    assert.equal(blocked.claimed, false);
    assert.ok(!blocked.claimed && blocked.last_asked_at, "the reminder's stamp is reported");
    assert.equal((await listAckDecisions(id)).length, 0, "nothing was written");
    assert.ok(await getCurrentAck(id, readerId), "the confirmation still counts");

    // An hour later (the stamp moved back), the claim goes through on its own transaction.
    await pool().query("UPDATE documents SET ack_last_reminded_at = now() - interval '61 minutes' WHERE id = $1", [id]);
    const first = await claimReconfirmation(null, id, { source: "manual", reason: "Out-of-band event: re-read it", actor: manager() });
    assert.equal(first.claimed, true);
    if (!first.claimed) throw new Error("unreachable");
    assert.equal(first.confirmations_reset, 1);
    assert.equal(first.version_id, v1, "no newer version: the marker stays on v1 with a new stamp");
    assert.equal(await getCurrentAck(id, readerId), undefined);

    // Straight after, the hour guard refuses again and reports the re-ask's own stamp.
    const second = await claimReconfirmation(null, id, { source: "manual", reason: "Asking twice in a minute", actor: manager() });
    assert.equal(second.claimed, false);
    if (second.claimed) throw new Error("unreachable");
    assert.ok(second.last_asked_at);
    assert.ok(new Date(second.last_asked_at!).getTime() >= Date.now() - 60_000, "the stamp is this minute's");
    assert.equal((await listAckDecisions(id)).length, 1, "still one reset row");
    assert.equal((await pendingAckOutboxFor(id)).length, 1, "still one notice");
  });

  test("a rollback leaves no marker, no row and no notice; a document that does not take confirmations is refused without a stamp; a per-person list leaves the marker where it is (D4)", async () => {
    const { id } = await confirmedPolicy(`${STAMP} rollback`);
    const before = await marker(id);
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const r = await claimReconfirmation(client, id, { source: "manual", reason: "Will be rolled back", actor: manager() });
      assert.equal(r.claimed, true);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.deepEqual(await marker(id), before, "the marker is where it was");
    assert.equal((await listAckDecisions(id)).length, 0);
    assert.equal((await pendingAckOutboxFor(id)).length, 0);
    assert.ok(await getCurrentAck(id, readerId), "the confirmation still counts");

    // A per-person list (D4) is the other statement: the reader's row is
    // re-opened (test/ack-reask.test.ts has the rest) and the document
    // marker stays where it is.
    await fixtureQuery(
      `INSERT INTO policy_assignments (document_id, user_id, source) VALUES ($1, $2, 'space')
       ON CONFLICT (document_id, user_id) DO UPDATE SET removed_at = NULL, exempt_at = NULL`,
      [id, readerId]
    );
    const one = await claimReconfirmation(null, id, { source: "manual", reason: "One person only", actor: manager(), userIds: [readerId] });
    assert.equal(one.claimed, true);
    if (!one.claimed) throw new Error("unreachable");
    assert.equal(one.scope, "users");
    assert.deepEqual(one.user_ids, [readerId]);
    assert.deepEqual(await marker(id), before, "a per-person ask never moves the marker");

    await setAckRequired(id, false);
    const off = await claimReconfirmation(null, id, { source: "manual", reason: "Requirement is off now", actor: manager() });
    assert.deepEqual(off, { claimed: false, last_asked_at: null });
    assert.deepEqual(await marker(id), before);
    const gone = await claimReconfirmation(null, -1, { source: "manual", reason: "No such document", actor: manager() });
    assert.deepEqual(gone, { claimed: false, last_asked_at: null });
  });

  test("the recurrence source is the same statement, immediate, with its sentence as the reason", async () => {
    const { id } = await confirmedPolicy(`${STAMP} recurrence`);
    const reason = "Annual re-confirmation: it has been 12 months since you confirmed this document.";
    const r = await claimReconfirmation(null, id, { source: "recurrence", reason, actor: { id: null, name: "system" } });
    assert.equal(r.claimed, true);
    const [row] = await listAckDecisions(id);
    assert.equal(row.source, "recurrence");
    assert.equal(row.reason, reason);
    assert.equal(row.decided_by, null);
    assert.equal(row.decided_by_name, "system");
    const [notice] = await pendingAckOutboxFor(id);
    assert.equal(notice.source, "recurrence");
    assert.equal(notice.actor_name, "system");
    assert.ok(new Date(notice.not_before).getTime() <= Date.now() + 1000, "recurrence goes out at once too");
  });
});

describe("the audit vocabulary", () => {
  test("every ack-family key auditAck can emit has a verb-first label", () => {
    assert.ok(ACK_AUDIT_ACTIONS.length >= 24);
    for (const key of ACK_AUDIT_ACTIONS) {
      assert.ok(hasActionLabel(key), `missing label for ${key}`);
      assert.match(actionLabel(key), /^[A-Z]/);
      assert.doesNotMatch(actionLabel(key), /[_.]\w/);
    }
    assert.ok(ACK_AUDIT_ACTIONS.every((k) => k.startsWith("ack.") || k.startsWith("document.ack") || k === "document.acknowledge"));
    assert.equal(actionLabel("ack.confirmations_kept"), "Kept confirmations after an edit");
    assert.equal(actionLabel("ack.confirmations_reset"), "Reset confirmations after an edit");
    assert.equal(actionLabel("document.ack_removed"), "Removed read-confirmation requirement");
  });
});
