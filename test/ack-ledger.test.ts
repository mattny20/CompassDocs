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
