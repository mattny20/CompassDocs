// Merge, restore and change requests carry the same decision (1.11.0, A6).
//
// A change request stores the submitter's recommendation for the readers of
// a confirmed document (ack_policy 'keep' | 'reset' | 'auto', ack_reason) and
// the review list carries the target's ack_required and ack_version_id.
// approveChangeRequest applies the reviewer's choice when given, else the
// submitter's stored one, else the document's edit default, and records both
// sides on the decision row. The shared pre-flight (lib/ack-decision) is what
// PATCH /api/change-requests/[id] answers 428 or 400 from, with the request's
// stored choice standing in for the body; the cr_resolved notice appends what
// the decision did. The merge and restore routes use the same pre-flight and
// are exercised end to end (e2e/branches.spec.ts for the merge,
// e2e/history.spec.ts for the restore) and through their handlers with a
// session cookie in test/ack-tokens.test.ts.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-decisions.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { asScope } from "../src/lib/space-scope";
import {
  pool,
  getSetting,
  createDocument,
  getDocument,
  updateDocument,
  setAckRequired,
  recordAcknowledgement,
  getCurrentAck,
  listVersions,
  listAckDecisions,
  createChangeRequest,
  getChangeRequest,
  listChangeRequests,
  approveChangeRequest,
  changeRequestAckPolicy,
  changeRequestAckReason,
  pendingAckOutboxFor,
  AckReasonRequiredError,
  ACK_REASON_MAX,
} from "../src/lib/db";
import {
  ackDecisionRequired,
  ackReasonUsable,
  auditedAckPolicy,
  ACK_DECISION_ERROR,
  ACK_POLICY_ERROR,
  ACK_REASON_ERROR,
} from "../src/lib/ack-decision";
import { ackOutcomeSentence, crResolvedBody } from "../src/lib/notifications";
import { fixtureQuery } from "./support/retry";

const STAMP = `ackdec-${Date.now()}`;

let spaceId = 0;
let readerId = 0;
let editorId = 0;
let approverId = 0;
const docIds: number[] = [];

const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);
/** One word changed in one paragraph: the heuristic calls it editorial (keep, high). */
const EDITORIAL = LONG_TEXT.replace("Clause 1: staff", "Clause 1: all staff");
/** A number changed: the heuristic calls it material (reset, high). */
const MATERIAL = LONG_TEXT.replace("Clause 3: staff must follow", "Clause 3: staff must, within 30 days, follow");

const marker = (id: number) =>
  pool()
    .query("SELECT ack_revision_at::text AS at, ack_version_id FROM documents WHERE id = $1", [id])
    .then((r) => r.rows[0]);

async function confirmedPolicy(title: string, content = LONG_TEXT): Promise<{ id: number; v1: number }> {
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
  // editDefault null: leave the column at 'ask' rather than reading the
  // workspace setting, which another test file may be writing.
  await setAckRequired(doc.id, true, { editDefault: null });
  docIds.push(doc.id);
  const v1 = (await listVersions(doc.id))[0].id;
  await recordAcknowledgement(doc.id, readerId, "", v1);
  return { id: doc.id, v1 };
}

function propose(
  id: number,
  title: string,
  content: string,
  extra: {
    ack_policy?: unknown;
    ack_reason?: unknown;
    note?: string;
    target?: "published" | "draft";
    summary?: string;
    kind?: "edit" | "publish";
  } = {}
) {
  return createChangeRequest({
    document_id: id,
    kind: extra.kind ?? "edit",
    title,
    content,
    summary: extra.summary ?? "",
    tags: [],
    type: "policy",
    target_status: extra.target ?? "published",
    note: extra.note ?? "Reworded the first clause",
    created_by: editorId,
    ack_policy: extra.ack_policy,
    ack_reason: extra.ack_reason,
  });
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Decisions ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Dec Reader', $2, 'viewer', 'active'),
       ($3, 'Alex Submitter', $4, 'editor', 'active'),
       ($5, 'Priya Approver', $6, 'approver', 'active')
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
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [
    docIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  // Before the users: reviewed_by has no ON DELETE.
  await pool().query("DELETE FROM change_requests WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("a change request carries the submitter's recommendation (A6)", () => {
  test("the two columns exist with their defaults", async () => {
    const cols = await pool().query<{ column_name: string; column_default: string; is_nullable: string }>(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'change_requests'
         AND column_name IN ('ack_policy', 'ack_reason') ORDER BY column_name`
    );
    assert.deepEqual(
      cols.rows.map((r) => [r.column_name, r.column_default, r.is_nullable]),
      [
        ["ack_policy", "'auto'::text", "NO"],
        ["ack_reason", "''::text", "NO"],
      ]
    );
  });

  test("createChangeRequest stores keep or reset with the reason; the review list carries the target's requirement and marker", async () => {
    const title = `${STAMP} stored`;
    const { id, v1 } = await confirmedPolicy(title);
    const crId = await propose(id, title, EDITORIAL, { ack_policy: "keep", ack_reason: "  Fixed a typo in the first clause  " });
    const cr = await getChangeRequest(crId);
    assert.ok(cr);
    assert.equal(cr.ack_policy, "keep");
    assert.equal(cr.ack_reason, "Fixed a typo in the first clause", "trimmed");
    assert.equal(cr.ack_required, 1, "the target requires read confirmation");
    assert.equal(cr.ack_version_id, v1, "the version people confirmed");
    assert.equal(cr.content, EDITORIAL, "the proposed text is still on the row");

    const listed = (await listChangeRequests("pending", asScope([spaceId]))).find((c) => c.id === crId);
    assert.ok(listed, "the review list has it");
    assert.equal(listed.ack_policy, "keep");
    assert.equal(listed.ack_reason, "Fixed a typo in the first clause");
    assert.equal(listed.ack_required, 1);
    assert.equal(listed.ack_version_id, v1);

    const reset = await getChangeRequest(await propose(id, title, MATERIAL, { ack_policy: "reset", ack_reason: "A deadline was added" }));
    assert.equal(reset!.ack_policy, "reset");
  });

  test("anything but keep or reset is stored as 'auto'; the reason is a trimmed string cut at 500", async () => {
    const title = `${STAMP} auto`;
    const { id } = await confirmedPolicy(title);
    for (const raw of [undefined, null, "auto", "bogus", 7, true]) {
      const cr = await getChangeRequest(await propose(id, title, EDITORIAL, { ack_policy: raw }));
      assert.equal(cr!.ack_policy, "auto", `${String(raw)} is no recommendation`);
      assert.equal(cr!.ack_reason, "", "no reason given");
    }
    for (const raw of [undefined, null, 7, true, { text: "x" }]) {
      const cr = await getChangeRequest(await propose(id, title, EDITORIAL, { ack_policy: "keep", ack_reason: raw }));
      assert.equal(cr!.ack_reason, "", `${String(raw)} is no reason`);
    }
    const long = await getChangeRequest(await propose(id, title, EDITORIAL, { ack_policy: "keep", ack_reason: "r".repeat(600) }));
    assert.equal(long!.ack_reason.length, ACK_REASON_MAX);
    assert.equal(ACK_REASON_MAX, 500);
    assert.equal(changeRequestAckPolicy("reset"), "reset");
    assert.equal(changeRequestAckPolicy("Keep"), "auto", "case matters, as it does on PUT");
    assert.equal(changeRequestAckReason(42), "");
  });
});

describe("approval applies the reviewer's choice, else the submitter's, else the edit default", () => {
  test("the submitter's keep applies when the reviewer says nothing, and the row names both sides", async () => {
    const title = `${STAMP} submitter keep`;
    const { id, v1 } = await confirmedPolicy(title);
    const before = await marker(id);
    const crId = await propose(id, title, EDITORIAL, { ack_policy: "keep", ack_reason: "fixed broken link to the expenses form" });
    const result = await approveChangeRequest(crId, approverId, "Priya Approver", "Looks fine");
    assert.ok(result);
    assert.equal(result.version_written, true);
    assert.equal(result.ack_outcome.substantive, true);
    assert.equal(result.ack_outcome.reset, false, "kept as the submitter recommended");
    assert.equal(result.ack_outcome.policy, "keep", "the policy applied");
    assert.equal(result.ack_outcome.source, "approval", "a person decided, not the document's setting");
    assert.equal(result.ack_outcome.confirmations_reset, 0);
    assert.ok(result.ack_outcome.decision_id);

    const after = await marker(id);
    assert.equal(after.ack_version_id, v1, "a keep never moves the marker");
    assert.equal(after.at, before.at);
    assert.ok(await getCurrentAck(id, readerId), "the reader's confirmation still counts");

    const [row] = await listAckDecisions(id);
    assert.equal(row.id, result.ack_outcome.decision_id);
    assert.equal(row.outcome, "kept");
    assert.equal(row.source, "approval");
    assert.equal(row.version_id, (await listVersions(id))[0].id);
    assert.equal(row.submitted_policy, "keep", "what Alex recommended");
    assert.equal(row.submitted_by, editorId);
    assert.equal(row.submitted_by_name, "Alex Submitter");
    assert.equal(row.decided_by, approverId, "who approved");
    assert.equal(row.decided_by_name, "Priya Approver");
    assert.equal(row.reason, "fixed broken link to the expenses form", "the submitter's reason, since the reviewer gave none");
    assert.equal(row.suggested, "keep");
    assert.equal(row.overrode_suggestion, false);
    assert.equal(row.confirmations_affected, 1);
    assert.equal((await pendingAckOutboxFor(id)).length, 0, "a keep queues no notice");
    assert.equal(
      (await listVersions(id))[0].note,
      "Reworded the first clause — approved by Priya Approver",
      "no reviewer reason: the request's note is the version note, as before"
    );
  });

  test("the reviewer's reset overrides the submitter's keep; the row keeps the recommendation beside the outcome", async () => {
    const title = `${STAMP} reviewer reset`;
    const { id, v1 } = await confirmedPolicy(title);
    const crId = await propose(id, title, EDITORIAL, { ack_policy: "keep", ack_reason: "just a wording tweak" });
    const result = await approveChangeRequest(crId, approverId, "Priya Approver", "", {
      ackPolicy: "reset",
      ackReason: "The first clause now covers contractors, everyone must re-read",
    });
    assert.ok(result);
    assert.equal(result.ack_outcome.reset, true);
    assert.equal(result.ack_outcome.policy, "reset");
    assert.equal(result.ack_outcome.source, "approval");
    assert.equal(result.ack_outcome.confirmations_reset, 1);
    const v2 = (await listVersions(id))[0].id;
    assert.notEqual(v2, v1);
    assert.equal((await marker(id)).ack_version_id, v2, "the marker moved to the approved text");
    assert.equal(await getCurrentAck(id, readerId), undefined, "the reader's confirmation is stale");

    const [row] = await listAckDecisions(id);
    assert.equal(row.outcome, "reset");
    assert.equal(row.submitted_policy, "keep", "the recommendation is kept for the record");
    assert.equal(row.submitted_by, editorId);
    assert.equal(row.decided_by, approverId);
    assert.equal(row.reason, "The first clause now covers contractors, everyone must re-read", "the reviewer's reason wins");
    assert.equal(row.suggested, "keep");
    assert.equal(row.overrode_suggestion, true, "reset against a keep suggestion");
    assert.equal(row.confirmations_affected, 1);
    const outbox = await pendingAckOutboxFor(id);
    assert.equal(outbox.length, 1, "a reset queues the 'updated' notice in the same transaction");
    assert.equal(outbox[0].source, "approval");
    // The dialog's note is the version note in every mode (A6): the
    // reviewer's reason replaces the request's note on the version row.
    assert.equal(
      (await listVersions(id))[0].note,
      "The first clause now covers contractors, everyone must re-read — approved by Priya Approver"
    );
  });

  test("the reviewer's keep overrides the submitter's reset", async () => {
    const title = `${STAMP} reviewer keep`;
    const { id, v1 } = await confirmedPolicy(title);
    const crId = await propose(id, title, MATERIAL, { ack_policy: "reset", ack_reason: "A 30-day deadline was added" });
    const result = await approveChangeRequest(crId, approverId, "Priya Approver", "", {
      ackPolicy: "keep",
      ackReason: "The deadline was already in the handbook; nothing new for readers",
    });
    assert.ok(result);
    assert.equal(result.ack_outcome.reset, false);
    assert.equal(result.ack_outcome.policy, "keep");
    assert.equal((await marker(id)).ack_version_id, v1);
    const [row] = await listAckDecisions(id);
    assert.equal(row.outcome, "kept");
    assert.equal(row.submitted_policy, "reset");
    assert.equal(row.suggested, "reset", "a number changed");
    assert.equal(row.overrode_suggestion, true);
    assert.equal(row.reason, "The deadline was already in the handbook; nothing new for readers");
  });

  test("the reviewer's reset needs a reason of 10 characters: refused before any write, the request stays pending", async () => {
    const title = `${STAMP} short reason`;
    const { id, v1 } = await confirmedPolicy(title);
    const before = await marker(id);
    const crId = await propose(id, title, EDITORIAL, { ack_policy: "keep", ack_reason: "wording" });
    await assert.rejects(
      approveChangeRequest(crId, approverId, "Priya Approver", "", { ackPolicy: "reset", ackReason: "short" }),
      (e: unknown) => e instanceof AckReasonRequiredError
    );
    const cr = await getChangeRequest(crId);
    assert.equal(cr!.status, "pending", "nothing was decided");
    assert.equal((await listVersions(id)).length, 1, "no version written");
    assert.equal((await listAckDecisions(id)).length, 0, "no decision row");
    assert.deepEqual(await marker(id), before);
    assert.equal((await getDocument(id))!.content, LONG_TEXT, "the document is untouched");
    assert.equal(v1, (await listVersions(id))[0].id);
    assert.equal((await pendingAckOutboxFor(id)).length, 0, "a refused approval queues no notice");
  });

  test("the reviewer's keep follows the workspace's keep_reason_required: refused by default, excused when the setting is off", async () => {
    const title = `${STAMP} keep excused`;
    const { id } = await confirmedPolicy(title);
    const crId = await propose(id, title, EDITORIAL, { ack_policy: "reset", ack_reason: "Everyone should re-read" });
    await assert.rejects(
      approveChangeRequest(crId, approverId, "Priya Approver", "", { ackPolicy: "keep", ackReason: "typo" }),
      (e: unknown) => e instanceof AckReasonRequiredError
    );
    assert.equal((await getChangeRequest(crId))!.status, "pending");
    assert.equal((await pendingAckOutboxFor(id)).length, 0, "a refused approval queues no notice");
    const result = await approveChangeRequest(crId, approverId, "Priya Approver", "", {
      ackPolicy: "keep",
      ackReason: "typo",
      ackKeepReasonRequired: false,
    });
    assert.ok(result);
    assert.equal(result.ack_outcome.reset, false);
    const [row] = await listAckDecisions(id);
    assert.equal(row.outcome, "kept");
    assert.equal(row.reason, "typo", "whatever was typed is recorded");
    assert.equal(row.submitted_policy, "reset");
  });

  test("with no recommendation and no reviewer choice the edit default decides, as in 1.10.1", async () => {
    const title = `${STAMP} auto approve`;
    const { id, v1 } = await confirmedPolicy(title);
    const crId = await propose(id, title, EDITORIAL, { note: "Reworded the first clause" });
    const result = await approveChangeRequest(crId, approverId, "Priya Approver");
    assert.ok(result);
    assert.equal(result.ack_outcome.policy, "auto", "nobody decided");
    assert.equal(result.ack_outcome.reset, true, "'ask' resets when nobody can be asked");
    assert.equal(result.ack_outcome.source, "approval");
    assert.notEqual((await marker(id)).ack_version_id, v1);
    const [row] = await listAckDecisions(id);
    assert.equal(row.submitted_policy, "");
    assert.equal(row.submitted_by, editorId, "the submitter is still named");
    assert.equal(row.reason, "Reworded the first clause", "the change note");
    assert.equal(row.overrode_suggestion, false, "'auto' never overrides");
  });

  test("a stored recommendation changes nothing when the request is not substantive: no version, no decision", async () => {
    const title = `${STAMP} metadata only`;
    const { id, v1 } = await confirmedPolicy(title);
    const before = await marker(id);
    const crId = await propose(id, title, LONG_TEXT, { ack_policy: "reset", ack_reason: "Everyone must re-read this", summary: "New summary" });
    const result = await approveChangeRequest(crId, approverId, "Priya Approver", "", {
      ackPolicy: "reset",
      ackReason: "Everyone must re-read this",
    });
    assert.ok(result);
    assert.equal(result.version_written, false, "the text equals the live row");
    assert.equal(result.ack_outcome.substantive, false);
    assert.equal(result.ack_outcome.reset, false);
    assert.equal(result.ack_outcome.decision_id, null);
    assert.equal((await listVersions(id)).length, 1);
    assert.equal((await listAckDecisions(id)).length, 0);
    assert.deepEqual(await marker(id), before);
    assert.equal((await getDocument(id))!.summary, "New summary", "the metadata still applied");
    assert.equal((await marker(id)).ack_version_id, v1);
    assert.ok(await getCurrentAck(id, readerId));
  });
});

describe("the pre-flight a review decision goes through (PATCH /api/change-requests/[id])", () => {
  test("an undecided substantive request on a confirmed document is a 428 with the numbers the question shows", async () => {
    const title = `${STAMP} preflight 428`;
    const { id } = await confirmedPolicy(title);
    const doc = (await getDocument(id))!;
    const cr = (await getChangeRequest(await propose(id, title, EDITORIAL)))!;
    const { refusal, decision } = await ackDecisionRequired(
      doc,
      { title: cr.title, content: cr.content, status: cr.target_status },
      {}
    );
    assert.ok(refusal);
    assert.equal(refusal.status, 428);
    assert.equal(refusal.body.error, ACK_DECISION_ERROR);
    assert.equal(refusal.body.decision_required, true);
    assert.equal(refusal.body.confirmations, 1);
    assert.ok(refusal.body.eligible! >= 3);
    assert.equal(refusal.body.baseline, "v1");
    assert.equal(refusal.body.suggested, "keep");
    assert.equal(typeof refusal.body.change?.pct, "number");
    assert.equal(refusal.body.change?.wordsChanged, 1);
    assert.deepEqual(decision, { ackPolicy: "auto", ackReason: "" });
  });

  test("the request's stored keep stands in for the body; a short reason or a bad policy is a 400 in the helper's words", async () => {
    const title = `${STAMP} preflight stored`;
    const { id } = await confirmedPolicy(title);
    const doc = (await getDocument(id))!;
    const next = (cr: { title: string; content: string; target_status: string }) => ({
      title: cr.title,
      content: cr.content,
      status: cr.target_status,
    });

    const stored = (await getChangeRequest(await propose(id, title, EDITORIAL, { ack_policy: "keep", ack_reason: "Fixed a typo in clause one" })))!;
    const ok = await ackDecisionRequired(doc, next(stored), { ack_policy: stored.ack_policy, ack_reason: stored.ack_reason });
    assert.equal(ok.refusal, null);
    assert.deepEqual(ok.decision, { ackPolicy: "keep", ackReason: "Fixed a typo in clause one" });

    const short = (await getChangeRequest(await propose(id, title, EDITORIAL, { ack_policy: "keep", ack_reason: "typo" })))!;
    const refusedReason = await ackDecisionRequired(doc, next(short), { ack_policy: short.ack_policy, ack_reason: short.ack_reason });
    assert.equal(refusedReason.refusal?.status, 400);
    assert.equal(refusedReason.refusal?.body.error, ACK_REASON_ERROR);

    const bad = await ackDecisionRequired(doc, next(stored), { ack_policy: "auto", ack_reason: "ten characters or more" });
    assert.equal(bad.refusal?.status, 400);
    assert.equal(bad.refusal?.body.error, ACK_POLICY_ERROR);
  });

  test("a request that leaves the text and title alone never sees the question, whatever it carries", async () => {
    const title = `${STAMP} preflight metadata`;
    const { id } = await confirmedPolicy(title);
    const doc = (await getDocument(id))!;
    const cr = (await getChangeRequest(await propose(id, title, LONG_TEXT, { summary: "Only the summary" })))!;
    const { refusal, decision } = await ackDecisionRequired(
      doc,
      { title: cr.title, content: cr.content, status: cr.target_status },
      {}
    );
    assert.equal(refusal, null);
    assert.deepEqual(decision, { ackPolicy: "auto", ackReason: "" });
  });
});

describe("the cr_resolved notice says what the decision did", () => {
  const outcome = (o: Partial<{ substantive: boolean; reset: boolean; confirmations_reset: number; decision_id: number | null }>) => ({
    substantive: true,
    reset: false,
    confirmations_reset: 0,
    decision_id: 1,
    ...o,
  });

  test("nothing when no decision was taken; kept; the count of people asked again", () => {
    assert.equal(ackOutcomeSentence(undefined), null);
    assert.equal(ackOutcomeSentence(outcome({ substantive: false, decision_id: null })), null, "a metadata-only approval");
    assert.equal(ackOutcomeSentence(outcome({ decision_id: null })), null, "substantive but nobody was asked (draft, requirement off)");
    assert.equal(ackOutcomeSentence(outcome({})), "Confirmations kept.");
    assert.equal(ackOutcomeSentence(outcome({ reset: true, confirmations_reset: 42 })), "42 people asked to re-confirm.");
    assert.equal(ackOutcomeSentence(outcome({ reset: true, confirmations_reset: 1 })), "1 person asked to re-confirm.");
    assert.equal(ackOutcomeSentence(outcome({ reset: true, confirmations_reset: 0 })), "Everyone was asked to re-confirm.");
  });

  test("the body is the reviewer's note, the sentence, or both", () => {
    assert.equal(crResolvedBody("", null), undefined, "as before: no note, no body");
    assert.equal(crResolvedBody("Looks good", null), "Looks good");
    assert.equal(crResolvedBody("", "Confirmations kept."), "Confirmations kept.");
    assert.equal(crResolvedBody("  Looks good  ", "42 people asked to re-confirm."), "Looks good · 42 people asked to re-confirm.");
  });
});
