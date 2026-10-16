// Read confirmations are current against the confirmation marker, not
// updated_at (1.10.0, A1): a metadata-only save or a no-op save keeps every
// confirmation, only a moved marker asks again, and each new row cites the
// version it was made against with the SHA-256 of that version's text.
//
// The first describe pins the query semantics (it moves the marker with SQL
// the way resetAcknowledgements does); the second drives the marker through
// updateDocument's ackPolicy (A2): a no-op save writes nothing, a kept text
// edit leaves the marker, a reset moves it, 'auto' resets, and the
// requirement being off advances the marker silently. The third covers the
// two text writers that do not go through updateDocument (change-request
// approval and the scheduler's publish), and the fourth the row lock that
// keeps a confirmation from landing inside a reset.
//
// The fifth describe (1.10.1, A5) drives the per-document edit default:
// 'ask' and 'reset' reset when a caller says nothing, 'material' keeps a
// change that looks editorial and records it from source 'default' (for a
// save, an approval and a scheduled publish alike), the workspace default
// lands on the first switch-on only, and the keep side's change note
// follows the workspace's keep_reason_required. That describe writes the
// shared ack_defaults setting, so it holds the advisory lock
// test/compliance-settings.test.ts holds for the same row; every other
// switch-on here passes editDefault explicitly and never reads the setting.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { asScope } from "../src/lib/space-scope";
import {
  pool,
  getSetting,
  setSetting,
  createDocument,
  updateDocument,
  setAckRequired,
  setAckEditDefault,
  ackSummary,
  recordAcknowledgement,
  getCurrentAck,
  getAckVersionInfo,
  ackStatusForDocument,
  complianceDocs,
  compliancePendingUsers,
  complianceUserSummary,
  listPendingAcksFor,
  listVersions,
  listAckDecisions,
  getAckDecision,
  resetAcknowledgements,
  createChangeRequest,
  approveChangeRequest,
  AckReasonRequiredError,
} from "../src/lib/db";
import { runDueDocSchedules, setDocSchedule } from "../src/lib/doc-schedule";
import { fixtureQuery } from "./support/retry";

const STAMP = `ackrev-${Date.now()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let spaceId = 0;
let readerId = 0;
let otherId = 0;
let approverId = 0;
const docIds: number[] = [];

async function newPolicy(title: string, content = "Policy body"): Promise<number> {
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
  return doc.id;
}

/** The advisory lock the settings-touching describes share with test/compliance-settings.test.ts. */
const SETTINGS_LOCK = 728342;

async function latestVersionId(docId: number): Promise<number> {
  return (await listVersions(docId))[0].id;
}

async function ackCount(docId: number, userId: number): Promise<number> {
  const r = await pool().query(
    "SELECT COUNT(*)::int AS n FROM acknowledgements WHERE document_id = $1 AND user_id = $2",
    [docId, userId]
  );
  return r.rows[0].n;
}

// Shared by both describes below (node:test runs a describe's `after` before
// the next describe starts, so the fixtures live at the top level).
before(async () => {
  await getSetting("__schema_bootstrap__"); // run the schema and migrations first
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Revision ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Rev Reader', $2, 'viewer', 'active'),
       ($3, 'Rev Other', $4, 'viewer', 'active'),
       ($5, 'Rev Approver', $6, 'approver', 'active')
     RETURNING id`,
    [
      `${STAMP}-reader`,
      `${STAMP}-reader@example.test`,
      `${STAMP}-other`,
      `${STAMP}-other@example.test`,
      `${STAMP}-approver`,
      `${STAMP}-approver@example.test`,
    ]
  );
  readerId = users.rows[0].id;
  otherId = users.rows[1].id;
  approverId = users.rows[2].id;
});

after(async () => {
  const userIds = [readerId, otherId, approverId];
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [
    docIds,
    userIds,
  ]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [
    docIds,
    `${STAMP}%`,
  ]);
  // Before the users: reviewed_by has no ON DELETE.
  await pool().query("DELETE FROM change_requests WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'document' AND target_id = ANY($1::text[])", [
    docIds.map(String),
  ]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("read confirmation marker and version evidence", () => {
  test("a new document starts with its marker at the first version", async () => {
    const id = await newPolicy(`${STAMP} fresh`);
    const info = await getAckVersionInfo(id);
    const v1 = await latestVersionId(id);
    assert.equal(info.version_id, v1);
    assert.equal(info.rev, 1);
    assert.equal(info.latest_version_id, v1);
    assert.equal(info.latest_rev, 1);
    assert.equal(info.author, "test");
    const row = await pool().query("SELECT ack_revision_at, ack_version_id FROM documents WHERE id = $1", [id]);
    assert.ok(row.rows[0].ack_revision_at, "ack_revision_at took its default");
    assert.equal(row.rows[0].ack_version_id, v1);
  });

  test("a confirmation stamps the version id and the hash of that version's text, not the live body", async () => {
    const id = await newPolicy(`${STAMP} hash`, "The words the reader saw");
    const v1 = await latestVersionId(id);
    // The live body drifts without a version (nothing in the product does
    // this; it proves the hash is taken from the version row).
    await pool().query("UPDATE documents SET content = 'tampered' WHERE id = $1", [id]);
    const r = await recordAcknowledgement(id, readerId, "10.0.0.1", v1);
    assert.deepEqual(r, { recorded: true, stale: false });
    const ack = await getCurrentAck(id, readerId);
    assert.ok(ack);
    assert.equal(ack.version_id, v1);
    assert.equal(ack.rev, 1);
    assert.equal(ack.content_sha256, sha("The words the reader saw"));
    const row = await pool().query(
      "SELECT user_name, user_email, document_title, ip FROM acknowledgements WHERE document_id = $1 AND user_id = $2",
      [id, readerId]
    );
    assert.equal(row.rows[0].user_name, "Rev Reader");
    assert.equal(row.rows[0].user_email, `${STAMP}-reader@example.test`);
    assert.equal(row.rows[0].document_title, `${STAMP} hash`);
    assert.equal(row.rows[0].ip, "10.0.0.1");
    const status = await ackStatusForDocument(id);
    const mine = status.find((s) => s.id === readerId)!;
    assert.equal(mine.version_source, "recorded");
    assert.equal(mine.rev, 1);
  });

  test("confirming again against the same version is a no-op, not a second row", async () => {
    const id = await newPolicy(`${STAMP} twice`);
    const v1 = await latestVersionId(id);
    await recordAcknowledgement(id, readerId, "", v1);
    const again = await recordAcknowledgement(id, readerId, "", v1);
    assert.deepEqual(again, { recorded: false, stale: false });
    assert.equal(await ackCount(id, readerId), 1);
  });

  test("a stale version id is refused: not the latest version, or not this document's", async () => {
    const id = await newPolicy(`${STAMP} stale`);
    const v1 = await latestVersionId(id);
    await updateDocument(id, { content: "Edited body" });
    const v2 = await latestVersionId(id);
    assert.notEqual(v1, v2);
    assert.deepEqual(await recordAcknowledgement(id, readerId, "", v1), { recorded: false, stale: true });
    assert.deepEqual(await recordAcknowledgement(id, readerId, "", 0), { recorded: false, stale: true });
    const foreign = await newPolicy(`${STAMP} foreign`);
    assert.deepEqual(await recordAcknowledgement(id, readerId, "", await latestVersionId(foreign)), {
      recorded: false,
      stale: true,
    });
    assert.equal(await ackCount(id, readerId), 0);
    assert.deepEqual(await recordAcknowledgement(id, readerId, "", v2), { recorded: true, stale: false });
  });

  test("a metadata-only save and a no-op save keep the confirmation current", async () => {
    const id = await newPolicy(`${STAMP} metadata`);
    await recordAcknowledgement(id, readerId, "", await latestVersionId(id));
    const stamps = "SELECT updated_at::text AS updated_at, ack_revision_at::text AS marker FROM documents WHERE id = $1";
    const before = await pool().query(stamps, [id]);

    await updateDocument(id, { summary: "A new summary", tags: ["one", "two"] });
    await updateDocument(id, {}); // nothing changed at all
    const after = await pool().query(stamps, [id]);
    assert.notEqual(after.rows[0].updated_at, before.rows[0].updated_at, "updated_at still moves (conflict token)");
    assert.equal(after.rows[0].marker, before.rows[0].marker, "the marker did not");

    assert.ok(await getCurrentAck(id, readerId), "still current");
    assert.equal((await listVersions(id)).length, 1, "no version row for a metadata-only save");
    const docs = await complianceDocs();
    const mine = docs.find((d) => d.id === id)!;
    assert.equal(mine.acked, 1);
    // Every active account in the (shared) database can see an internal space.
    assert.ok(mine.required >= 2);
    assert.ok(mine.ack_revision_at);
    const pending = await compliancePendingUsers(id);
    assert.ok(pending.some((p) => p.id === otherId), "the other reader is still pending");
    assert.ok(!pending.some((p) => p.id === readerId), "the confirmed reader is not");
  });

  test("moving the marker asks everyone again; every compliance query agrees", async () => {
    const id = await newPolicy(`${STAMP} reset`);
    await recordAcknowledgement(id, readerId, "", await latestVersionId(id));
    assert.ok(await getCurrentAck(id, readerId));
    const pendingBefore = await listPendingAcksFor(readerId, asScope([spaceId]));
    assert.ok(!pendingBefore.some((d) => d.id === id), "not pending while current");

    // What resetAcknowledgements (A2/C1) does to the row.
    await pool().query("UPDATE documents SET ack_revision_at = now() + interval '1 second' WHERE id = $1", [id]);

    assert.equal(await getCurrentAck(id, readerId), undefined, "stale against the moved marker");
    const docs = await complianceDocs();
    assert.equal(docs.find((d) => d.id === id)!.acked, 0);
    const pending = await compliancePendingUsers(id);
    assert.ok(pending.some((p) => p.id === readerId));
    const status = await ackStatusForDocument(id);
    const mine = status.find((s) => s.id === readerId)!;
    assert.equal(mine.acknowledged_at, null);
    assert.equal(mine.version_source, null);
    const summary = await complianceUserSummary();
    const me = summary.find((u) => u.id === readerId)!;
    assert.ok(me.required > me.acked, "the person has something left to confirm");
    const pendingAfter = await listPendingAcksFor(readerId, asScope([spaceId]));
    assert.ok(pendingAfter.some((d) => d.id === id), "listed as pending once the marker moved");
    assert.equal(await ackCount(id, readerId), 1, "the ledger keeps the earlier row");
  });

  test("after a kept edit a reader may confirm the newer text; the ledger keeps both rows", async () => {
    const id = await newPolicy(`${STAMP} kept`, "First text");
    const v1 = await latestVersionId(id);
    await recordAcknowledgement(id, readerId, "", v1);
    await updateDocument(id, {
      content: "Second text",
      ackPolicy: "keep",
      ackReason: "Wording only, the rule is unchanged",
      ackActor: { id: otherId, name: "Rev Other" },
      ackSource: "edit",
    });
    const v2 = await latestVersionId(id);
    const info = await getAckVersionInfo(id);
    assert.equal(info.version_id, v1, "the marker's version stays until someone asks again");
    assert.equal(info.latest_version_id, v2, "the version a reader must cite");
    assert.equal(info.latest_rev, 2);

    assert.ok(await getCurrentAck(id, readerId), "the v1 confirmation is still current (nobody asked again)");
    assert.deepEqual(await recordAcknowledgement(id, readerId, "", v2), { recorded: true, stale: false });
    assert.equal(await ackCount(id, readerId), 2);
    const ack = await getCurrentAck(id, readerId);
    assert.equal(ack!.version_id, v2);
    assert.equal(ack!.rev, 2);
    assert.equal(ack!.content_sha256, sha("Second text"));
  });

  test("a row without a hash reads as version inferred", async () => {
    const id = await newPolicy(`${STAMP} inferred`);
    await recordAcknowledgement(id, readerId, "", await latestVersionId(id));
    await pool().query("UPDATE acknowledgements SET content_sha256 = NULL WHERE document_id = $1", [id]);
    const status = await ackStatusForDocument(id);
    const mine = status.find((s) => s.id === readerId)!;
    assert.equal(mine.version_source, "inferred");
    assert.equal(mine.rev, 1, "the version is still shown");
    await pool().query("UPDATE acknowledgements SET version_id = NULL WHERE document_id = $1", [id]);
    const ack = await getCurrentAck(id, readerId);
    assert.equal(ack!.version_id, null);
    assert.equal(ack!.rev, null, "no version, no number");
  });
});

describe("updateDocument decides what happens to confirmations (A2)", () => {
  const actor = { id: 0, name: "Rev Other" };
  const stamps = "SELECT updated_at::text AS updated_at, ack_revision_at::text AS marker, ack_version_id FROM documents WHERE id = $1";

  before(() => {
    actor.id = otherId;
  });

  async function confirmedPolicy(title: string, content = "First text") {
    const id = await newPolicy(title, content);
    const v1 = await latestVersionId(id);
    await recordAcknowledgement(id, readerId, "", v1);
    return { id, v1 };
  }

  async function acked(id: number): Promise<number> {
    return (await complianceDocs()).find((d) => d.id === id)!.acked;
  }

  test("a tag-only save keeps the counts, writes no version and no decision", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} a2 tags`);
    const before = await pool().query(stamps, [id]);
    const doc = await updateDocument(id, { tags: ["hr", "policy"], summary: "New summary", ackActor: actor, ackSource: "edit" });
    assert.ok(doc);
    assert.deepEqual(doc.ack_outcome, {
      changed: true,
      substantive: false,
      reset: false,
      confirmations_reset: 0,
      policy: "auto",
      source: "edit",
      decision_id: null,
    });
    const after = await pool().query(stamps, [id]);
    assert.notEqual(after.rows[0].updated_at, before.rows[0].updated_at, "updated_at moved (conflict token)");
    assert.equal(after.rows[0].marker, before.rows[0].marker, "the marker did not");
    assert.equal(after.rows[0].ack_version_id, v1);
    assert.equal(await acked(id), 1);
    assert.equal((await listVersions(id)).length, 1);
    assert.equal((await listAckDecisions(id)).length, 0);
  });

  test("a no-op save changes nothing: no UPDATE, no updated_at bump, no version, no decision", async () => {
    const { id } = await confirmedPolicy(`${STAMP} a2 noop`);
    const before = await pool().query(stamps, [id]);
    const doc = await updateDocument(id, {
      content: "First text",
      title: `${STAMP} a2 noop`,
      author: "Somebody Else", // the author is excluded from the comparison
      ackPolicy: "reset",
      ackReason: "would reset if anything had changed",
      ackActor: actor,
      ackSource: "edit",
    });
    assert.ok(doc);
    assert.equal(doc.ack_outcome!.changed, false);
    assert.equal(doc.ack_outcome!.reset, false);
    assert.equal(doc.author, "test", "the row is returned as it was");
    const after = await pool().query(stamps, [id]);
    assert.equal(after.rows[0].updated_at, before.rows[0].updated_at, "updated_at untouched");
    assert.equal(after.rows[0].marker, before.rows[0].marker);
    assert.equal((await listVersions(id)).length, 1);
    assert.equal((await listAckDecisions(id)).length, 0);
    assert.equal(await acked(id), 1);
  });

  test("a text edit with 'keep' keeps the counts, still writes a version and a 'kept' decision", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} a2 keep`);
    const doc = await updateDocument(id, {
      content: "First text.",
      versionNote: "Edited via editor",
      ackPolicy: "keep",
      ackReason: "Added a full stop, nothing else",
      ackActor: actor,
      ackSource: "edit",
    });
    assert.ok(doc);
    assert.equal(doc.ack_outcome!.substantive, true);
    assert.equal(doc.ack_outcome!.reset, false);
    assert.equal(doc.ack_outcome!.policy, "keep");
    const versions = await listVersions(id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].note, "Edited via editor");
    const row = await pool().query(stamps, [id]);
    assert.equal(row.rows[0].ack_version_id, v1, "the marker stays on the confirmed version");
    assert.equal(await acked(id), 1);
    assert.ok(await getCurrentAck(id, readerId));
    const decisions = await listAckDecisions(id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, "kept");
    assert.equal(decisions[0].reason, "Added a full stop, nothing else");
    assert.equal(decisions[0].version_id, versions[0].id, "the decision cites the new text");
    assert.equal(decisions[0].rev, 2);
    assert.equal(decisions[0].decided_by, otherId);
    assert.equal(decisions[0].decided_by_name, "Rev Other");
    assert.equal(decisions[0].submitted_policy, "keep");
    assert.equal(decisions[0].source, "edit");
    assert.equal(decisions[0].confirmations_affected, 1);
  });

  test("a text edit with 'reset' zeroes the counts and moves the marker to the new version", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} a2 reset`);
    const before = await pool().query(stamps, [id]);
    const doc = await updateDocument(id, {
      content: "Entirely different rules apply from Monday",
      ackPolicy: "reset",
      ackReason: "The notice period changed from 30 to 60 days",
      ackActor: actor,
      ackSource: "edit",
    });
    assert.ok(doc);
    assert.equal(doc.ack_outcome!.reset, true);
    assert.equal(doc.ack_outcome!.confirmations_reset, 1);
    // The outcome names the row it wrote, so the audit echo reads that row and not "the newest".
    const written = await getAckDecision(doc.ack_outcome!.decision_id!);
    assert.equal(written?.document_id, id);
    assert.equal(written?.outcome, "reset");
    const v2 = await latestVersionId(id);
    assert.notEqual(v2, v1);
    const after = await pool().query(stamps, [id]);
    assert.equal(after.rows[0].ack_version_id, v2);
    assert.notEqual(after.rows[0].marker, before.rows[0].marker, "the marker moved");
    assert.equal(await acked(id), 0);
    assert.equal(await getCurrentAck(id, readerId), undefined);
    const info = await getAckVersionInfo(id);
    assert.equal(info.version_id, v2);
    assert.equal(info.rev, 2);
    const decisions = await listAckDecisions(id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, "reset");
    assert.equal(decisions[0].version_id, v2);
    // The reader may confirm the new text; the old row stays in the ledger.
    assert.deepEqual(await recordAcknowledgement(id, readerId, "", v2), { recorded: true, stale: false });
    assert.equal(await ackCount(id, readerId), 2);
  });

  test("a title change counts as a text change", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} a2 title`);
    const doc = await updateDocument(id, {
      title: `${STAMP} a2 title (renamed)`,
      ackPolicy: "reset",
      ackReason: "Renamed to match the new policy family",
      ackActor: actor,
      ackSource: "edit",
    });
    assert.equal(doc!.ack_outcome!.reset, true);
    const row = await pool().query(stamps, [id]);
    assert.notEqual(row.rows[0].ack_version_id, v1);
  });

  test("a reason shorter than 10 characters is refused for either policy, before any write", async () => {
    const { id } = await confirmedPolicy(`${STAMP} a2 reason`);
    const before = await pool().query(stamps, [id]);
    for (const ackPolicy of ["keep", "reset"] as const) {
      await assert.rejects(
        updateDocument(id, { content: "Changed", ackPolicy, ackReason: "typo", ackActor: actor, ackSource: "edit" }),
        (e: unknown) =>
          e instanceof AckReasonRequiredError &&
          e.message === "A change note of at least 10 characters is required when the text of a confirmed document changes."
      );
    }
    const after = await pool().query(stamps, [id]);
    assert.equal(after.rows[0].updated_at, before.rows[0].updated_at, "nothing was written");
    assert.equal((await listVersions(id)).length, 1);
    assert.equal((await listAckDecisions(id)).length, 0);
    assert.equal(await acked(id), 1);
    // The rule only applies when the text of a confirmed document changes.
    const meta = await updateDocument(id, { tags: ["x"], ackPolicy: "keep", ackReason: "", ackActor: actor });
    assert.equal(meta!.ack_outcome!.changed, true);
    assert.equal(meta!.ack_outcome!.substantive, false);
  });

  test("a caller that says nothing ('auto') resets, with the version note as the reason and no length rule", async () => {
    // merge, restore, bulk, MCP, v1 and the importers pass no policy until A6
    // (1.11.0); they must keep working and simply record what they did.
    const { id } = await confirmedPolicy(`${STAMP} a2 auto`);
    const doc = await updateDocument(id, { content: "Merged text", versionNote: "Merged" });
    assert.equal(doc!.ack_outcome!.policy, "auto");
    assert.equal(doc!.ack_outcome!.reset, true);
    assert.equal(doc!.ack_outcome!.source, "default");
    assert.equal(await acked(id), 0);
    const [decision] = await listAckDecisions(id);
    assert.equal(decision.outcome, "reset");
    assert.equal(decision.reason, "Merged");
    assert.equal(decision.source, "default");
    assert.equal(decision.submitted_policy, "");
    assert.equal(decision.decided_by, null);
    assert.equal(decision.decided_by_name, "test", "the version's author when nobody is named");

    const again = await updateDocument(id, { content: "Merged text again" });
    assert.equal((await listAckDecisions(id))[0].reason, "Content changed", "the default reason");
    assert.equal(again!.ack_outcome!.reset, true);
  });

  test("requirement off, text edited, requirement on: nobody's old confirmation counts for the new text", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} a2 offon`);
    await setAckRequired(id, false);
    const doc = await updateDocument(id, { content: "Edited while nobody was asked", ackActor: actor, ackSource: "edit" });
    assert.equal(doc!.ack_outcome!.substantive, true);
    assert.equal(doc!.ack_outcome!.reset, false, "nobody is being asked");
    const v2 = await latestVersionId(id);
    const row = await pool().query(stamps, [id]);
    assert.equal(row.rows[0].ack_version_id, v2, "the marker followed the text silently");
    assert.notEqual(row.rows[0].ack_version_id, v1);
    assert.equal((await listAckDecisions(id)).length, 0, "no decision row while the requirement is off");
    await setAckRequired(id, true, { editDefault: null });
    assert.equal(await acked(id), 0, "never 100% for unread text");
    assert.equal(await getCurrentAck(id, readerId), undefined);
  });

  test("a draft edited over several saves is decided at the publish transition, against the confirmed text", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} a2 draft`);
    // Unpublish: a status flip without text drift asks nobody.
    const down = await updateDocument(id, { status: "draft", ackActor: actor, ackSource: "edit" });
    assert.equal(down!.ack_outcome!.substantive, false);
    // Two draft saves: versions are written, the marker stays, no decision yet.
    await updateDocument(id, { content: "Draft one", ackActor: actor, ackSource: "edit" });
    const mid = await updateDocument(id, { content: "Draft two", ackActor: actor, ackSource: "edit" });
    assert.equal(mid!.ack_outcome!.substantive, true);
    assert.equal(mid!.ack_outcome!.reset, false);
    assert.equal((await pool().query(stamps, [id])).rows[0].ack_version_id, v1, "the marker waits for the publish");
    assert.equal((await listAckDecisions(id)).length, 0);
    assert.equal((await listVersions(id)).length, 3);
    // Publishing without a reason is refused: the text differs from what people confirmed.
    await assert.rejects(
      updateDocument(id, { status: "published", ackPolicy: "reset", ackReason: "short", ackActor: actor, ackSource: "edit" }),
      AckReasonRequiredError
    );
    // Publishing with 'keep' records the decision; the marker still points at the confirmed text.
    const up = await updateDocument(id, {
      status: "published",
      ackPolicy: "keep",
      ackReason: "Editorial pass, the obligations are the same",
      ackActor: actor,
      ackSource: "edit",
    });
    assert.equal(up!.ack_outcome!.substantive, true);
    assert.equal(up!.ack_outcome!.reset, false);
    assert.equal((await listVersions(id)).length, 3, "publishing writes no extra version");
    const [decision] = await listAckDecisions(id);
    assert.equal(decision.outcome, "kept");
    assert.equal(decision.version_id, await latestVersionId(id), "the decision cites the newest version");
    assert.equal(await acked(id), 1, "the v1 confirmation still counts");
    // Unpublish and republish again: the text still differs from v1, so it asks again.
    await updateDocument(id, { status: "draft", ackActor: actor, ackSource: "edit" });
    const republish = await updateDocument(id, {
      status: "published",
      ackPolicy: "reset",
      ackReason: "Second thoughts: everyone should read it",
      ackActor: actor,
      ackSource: "edit",
    });
    assert.equal(republish!.ack_outcome!.reset, true);
    assert.equal(await acked(id), 0);
    assert.equal((await pool().query(stamps, [id])).rows[0].ack_version_id, await latestVersionId(id));
  });

  test("a status flip without text drift never asks, whatever the policy", async () => {
    const { id } = await confirmedPolicy(`${STAMP} a2 flip`);
    await updateDocument(id, { status: "draft", ackPolicy: "reset", ackReason: "", ackActor: actor });
    const up = await updateDocument(id, { status: "published", ackPolicy: "reset", ackReason: "", ackActor: actor });
    assert.equal(up!.ack_outcome!.substantive, false);
    assert.equal(await acked(id), 1);
    assert.equal((await listAckDecisions(id)).length, 0);
  });
});

describe("the other text writers take the same decisions (approval, schedule)", () => {
  const stamps = "SELECT status, publish_at, ack_revision_at::text AS marker, ack_version_id FROM documents WHERE id = $1";

  async function confirmedPolicy(title: string, content = "Expense cap is 50.") {
    const id = await newPolicy(title, content);
    const v1 = await latestVersionId(id);
    await recordAcknowledgement(id, readerId, "", v1);
    return { id, v1 };
  }

  async function acked(id: number): Promise<number> {
    return (await complianceDocs()).find((d) => d.id === id)!.acked;
  }

  function propose(id: number, title: string, content: string, target: "published" | "draft" = "published") {
    return createChangeRequest({
      document_id: id,
      kind: "edit",
      title,
      content,
      summary: "",
      tags: [],
      type: "policy",
      target_status: target,
      note: "Cap raised to 500",
      created_by: otherId,
    });
  }

  test("an approved change request on a confirmed policy asks everyone again and names the submitter beside the approver", async () => {
    const title = `${STAMP} approve`;
    const { id, v1 } = await confirmedPolicy(title);
    const before = await pool().query(stamps, [id]);
    const crId = await propose(id, title, "Expense cap is 500.");
    const result = await approveChangeRequest(crId, approverId, "Rev Approver", "Agreed with finance");
    assert.ok(result);
    assert.equal(result.version_written, true);
    assert.equal(result.ack_outcome.substantive, true);
    assert.equal(result.ack_outcome.reset, true);
    assert.equal(result.ack_outcome.confirmations_reset, 1);
    assert.equal(result.ack_outcome.source, "approval");
    assert.equal(result.ack_outcome.policy, "auto");

    const versions = await listVersions(id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].note, "Cap raised to 500 — approved by Rev Approver");
    const after = await pool().query(stamps, [id]);
    assert.equal(after.rows[0].ack_version_id, versions[0].id, "the marker moved to the approved text");
    assert.notEqual(after.rows[0].ack_version_id, v1);
    assert.notEqual(after.rows[0].marker, before.rows[0].marker);
    assert.equal(await getCurrentAck(id, readerId), undefined, "the reader's confirmation is stale");
    assert.equal(await acked(id), 0);
    assert.ok((await compliancePendingUsers(id)).some((p) => p.id === readerId));

    const decisions = await listAckDecisions(id);
    assert.equal(decisions.length, 1);
    const [row] = decisions;
    assert.equal(row.id, result.ack_outcome.decision_id);
    assert.equal(row.outcome, "reset");
    assert.equal(row.source, "approval");
    assert.equal(row.version_id, versions[0].id);
    assert.equal(row.rev, 2);
    assert.equal(row.decided_by, approverId);
    assert.equal(row.decided_by_name, "Rev Approver");
    assert.equal(row.submitted_by, otherId);
    assert.equal(row.submitted_by_name, "Rev Other");
    assert.equal(row.submitted_policy, "", "the recommendation travels with the request from 1.11.0");
    assert.equal(row.reason, "Cap raised to 500", "the request's change note");
    assert.equal(typeof row.change_pct, "number");
    assert.ok(row.suggested === "keep" || row.suggested === "reset", "the heuristic was consulted");
    assert.equal(row.confirmations_affected, 1);
    // The reader may confirm the approved text.
    assert.deepEqual(await recordAcknowledgement(id, readerId, "", versions[0].id), { recorded: true, stale: false });
    assert.equal(await acked(id), 1);
  });

  test("approving a request whose text equals the live row writes no version and no decision", async () => {
    const title = `${STAMP} approve same`;
    const { id, v1 } = await confirmedPolicy(title);
    const before = await pool().query(stamps, [id]);
    const crId = await propose(id, title, "Expense cap is 50.");
    const result = await approveChangeRequest(crId, approverId, "Rev Approver");
    assert.ok(result);
    assert.equal(result.version_written, false);
    assert.equal(result.ack_outcome.substantive, false);
    assert.equal(result.ack_outcome.reset, false);
    assert.equal(result.ack_outcome.decision_id, null);
    assert.equal((await listVersions(id)).length, 1);
    assert.equal((await listAckDecisions(id)).length, 0);
    const after = await pool().query(stamps, [id]);
    assert.equal(after.rows[0].ack_version_id, v1);
    assert.equal(after.rows[0].marker, before.rows[0].marker);
    assert.ok(await getCurrentAck(id, readerId), "still current");
    assert.equal(await acked(id), 1);
    const cr = await pool().query("SELECT status, reviewed_by FROM change_requests WHERE id = $1", [crId]);
    assert.equal(cr.rows[0].status, "approved", "the request itself is still decided");
    assert.equal(cr.rows[0].reviewed_by, approverId);
    assert.equal(await approveChangeRequest(crId, approverId, "Rev Approver"), false, "a second approval is refused");
  });

  test("an approval with the requirement off advances the marker silently; into a draft it waits for the publish", async () => {
    const title = `${STAMP} approve off`;
    const { id, v1 } = await confirmedPolicy(title);
    await setAckRequired(id, false);
    const off = await approveChangeRequest(await propose(id, title, "Edited while nobody was asked"), approverId, "Rev Approver");
    assert.ok(off);
    assert.equal(off.ack_outcome.substantive, true);
    assert.equal(off.ack_outcome.reset, false, "nobody is being asked");
    const v2 = await latestVersionId(id);
    assert.notEqual(v2, v1);
    assert.equal((await pool().query(stamps, [id])).rows[0].ack_version_id, v2, "the marker followed the text");
    assert.equal((await listAckDecisions(id)).length, 0, "no decision row while the requirement is off");
    await setAckRequired(id, true, { editDefault: null });
    assert.equal(await getCurrentAck(id, readerId), undefined, "never 100% for unread text");

    // Required again, confirmed at v2; a request that lands as a draft keeps the marker.
    await recordAcknowledgement(id, readerId, "", v2);
    const draft = await approveChangeRequest(await propose(id, title, "Draft wording", "draft"), approverId, "Rev Approver");
    assert.ok(draft);
    assert.equal(draft.ack_outcome.substantive, true);
    assert.equal(draft.ack_outcome.reset, false);
    const row = (await pool().query(stamps, [id])).rows[0];
    assert.equal(row.status, "draft");
    assert.equal(row.ack_version_id, v2, "the decision is taken at publish");
    assert.equal((await listAckDecisions(id)).length, 0);
    assert.ok(await getCurrentAck(id, readerId));
  });

  test("a scheduled publish of a draft whose text drifted asks everyone again with source 'schedule'", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} schedule drift`);
    const editor = { id: otherId, name: "Rev Other" };
    await updateDocument(id, { status: "draft", ackActor: editor, ackSource: "edit" });
    await updateDocument(id, { content: "Expense cap is 500 from the first of next month.", ackActor: editor, ackSource: "edit" });
    const v2 = await latestVersionId(id);
    assert.equal((await pool().query(stamps, [id])).rows[0].ack_version_id, v1, "the marker waits while it is a draft");
    await setDocSchedule(id, { publishAt: new Date(Date.now() - 60_000).toISOString() });

    await runDueDocSchedules();

    const row = (await pool().query(stamps, [id])).rows[0];
    assert.equal(row.status, "published");
    assert.equal(row.publish_at, null);
    assert.equal(row.ack_version_id, v2, "the marker moved to the published text");
    assert.equal(await getCurrentAck(id, readerId), undefined);
    assert.equal(await acked(id), 0);
    const decisions = await listAckDecisions(id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, "reset");
    assert.equal(decisions[0].source, "schedule");
    assert.equal(decisions[0].version_id, v2);
    assert.equal(decisions[0].decided_by, null);
    assert.equal(decisions[0].decided_by_name, "", "no person: the History page says Automatic");
    assert.equal(decisions[0].reason, "Published on schedule");
    assert.equal(decisions[0].confirmations_affected, 1);
    assert.equal(typeof decisions[0].change_pct, "number");
    const echo = await pool().query(
      "SELECT details FROM audit_log WHERE action = 'ack.confirmations_reset' AND target_id = $1 ORDER BY id DESC LIMIT 1",
      [String(id)]
    );
    assert.equal(echo.rows.length, 1, "the decision is echoed to the audit log");
    assert.equal(echo.rows[0].details.source, "schedule");
    assert.equal(echo.rows[0].details.version_id, v2);
    assert.equal(echo.rows[0].details.content_sha256, sha("Expense cap is 500 from the first of next month."));
  });

  test("a scheduled publish of unchanged text and a scheduled unpublish ask nobody", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} schedule same`);
    const editor = { id: otherId, name: "Rev Other" };
    const before = (await pool().query(stamps, [id])).rows[0];
    await setDocSchedule(id, { archiveAt: new Date(Date.now() - 60_000).toISOString() });
    await runDueDocSchedules();
    const down = (await pool().query(stamps, [id])).rows[0];
    assert.equal(down.status, "draft");
    assert.equal(down.marker, before.marker, "unpublishing never moves the marker");
    assert.equal(down.ack_version_id, v1);
    assert.ok(await getCurrentAck(id, readerId));

    await updateDocument(id, { tags: ["finance"], ackActor: editor, ackSource: "edit" }); // metadata only
    await setDocSchedule(id, { publishAt: new Date(Date.now() - 60_000).toISOString() });
    await runDueDocSchedules();
    const up = (await pool().query(stamps, [id])).rows[0];
    assert.equal(up.status, "published");
    assert.equal(up.marker, before.marker, "the text is what people confirmed");
    assert.equal(up.ack_version_id, v1);
    assert.equal(await acked(id), 1);
    assert.equal((await listAckDecisions(id)).length, 0);
  });
});

describe("the per-document edit default (A5): ask, material, reset", () => {
  const actor = { id: 0, name: "Rev Other" };
  // Long enough that one corrected word is well under KEEP_MAX_PCT (2%) and
  // sits in one paragraph: keep with high confidence. A changed number is
  // material on its own, whatever the share.
  const BODY = Array.from(
    { length: 12 },
    (_, i) =>
      `Clause ${i + 1}: staff must file every expense claim within 30 days of travel and attach a receipt for each item over 20 pounds, or the claim is returned.`
  ).join("\n\n");
  const TYPO = BODY.replace("attach a receipt for each item", "attach a reciept for each item");
  const NUMBER = BODY.replace("over 20 pounds", "over 25 pounds");
  const stamps = "SELECT ack_version_id FROM documents WHERE id = $1";
  let savedDefaults: string | undefined;
  // The settings row is shared with test/compliance-settings.test.ts and
  // node:test runs files in parallel: the lock is held on one dedicated
  // connection for the whole describe (an advisory lock is per session).
  let lockClient: PoolClient | null = null;

  before(async () => {
    actor.id = otherId;
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

  async function workspaceDefault(value: "ask" | "material" | "reset" | null) {
    if (value === null) await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");
    else await setSetting("ack_defaults", JSON.stringify({ edit_default: value }));
  }

  /** A required, confirmed policy whose own edit default is `mode`. */
  async function confirmedPolicy(title: string, mode: "ask" | "material" | "reset", content = TYPO) {
    const id = await newPolicy(title, content);
    await setAckEditDefault(id, mode);
    const v1 = await latestVersionId(id);
    await recordAcknowledgement(id, readerId, "", v1);
    return { id, v1 };
  }

  async function acked(id: number): Promise<number> {
    return (await complianceDocs()).find((d) => d.id === id)!.acked;
  }

  test("a new document carries 'ask'; the first switch-on applies the workspace default and a later toggle never overrides the document's own choice", async () => {
    await workspaceDefault("material");
    const doc = await createDocument({
      space_id: spaceId,
      title: `${STAMP} a5 default`,
      type: "policy",
      status: "published",
      content: BODY,
      summary: "",
      tags: [],
      author: "test",
    });
    docIds.push(doc.id);
    assert.equal((await ackSummary(doc.id)).edit_default, "ask", "the column default before the first switch-on");

    const on = await setAckRequired(doc.id, true);
    assert.equal(on.switched_on, true);
    assert.equal(on.edit_default, "material", "the workspace default on the first switch-on");
    assert.equal((await ackSummary(doc.id)).edit_default, "material");
    const row = (await complianceDocs()).find((d) => d.id === doc.id)!;
    assert.equal(row.ack_edit_default, "material", "the portal row carries it");

    assert.equal((await setAckRequired(doc.id, true)).switched_on, false, "already on: nothing switched");

    // The document's own choice survives off-and-on, whatever the workspace says now.
    assert.deepEqual(await setAckEditDefault(doc.id, "reset"), { from: "material", to: "reset" });
    await workspaceDefault("ask");
    await setAckRequired(doc.id, false);
    const again = await setAckRequired(doc.id, true);
    assert.equal(again.switched_on, true);
    assert.equal(again.edit_default, "reset", "a later toggle leaves the document's choice alone");

    // An explicit value, or null to leave the column alone, beats the workspace's.
    const other = await newPolicy(`${STAMP} a5 explicit`, BODY);
    await setAckRequired(other, false);
    assert.equal((await setAckRequired(other, true, { editDefault: "material" })).edit_default, "material");
    await setAckEditDefault(other, "ask");
    await setAckRequired(other, false);
    await workspaceDefault("reset");
    assert.equal((await setAckRequired(other, true, { editDefault: null })).edit_default, "ask");
    assert.equal(await setAckEditDefault(-1, "ask"), null, "no document, no change");
    await workspaceDefault(null);
  });

  test("'ask' and 'reset': a caller that says nothing resets, with the caller's source", async () => {
    for (const mode of ["ask", "reset"] as const) {
      const { id, v1 } = await confirmedPolicy(`${STAMP} a5 auto ${mode}`, mode);
      const doc = await updateDocument(id, { content: BODY, versionNote: "Fixed a typo", ackActor: actor, ackSource: "edit" });
      assert.ok(doc);
      assert.equal(doc.ack_outcome!.policy, "auto");
      assert.equal(doc.ack_outcome!.reset, true, `${mode}: a typo fix still resets when nobody chose`);
      assert.equal(doc.ack_outcome!.confirmations_reset, 1);
      assert.equal(doc.ack_outcome!.source, "edit", "the caller's source");
      assert.notEqual((await pool().query(stamps, [id])).rows[0].ack_version_id, v1);
      assert.equal(await acked(id), 0);
      const [decision] = await listAckDecisions(id);
      assert.equal(decision.outcome, "reset");
      assert.equal(decision.source, "edit");
      assert.equal(decision.reason, "Fixed a typo");
    }
  });

  test("'material': a typo fix is kept and recorded from source 'default'; a changed number resets", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} a5 material`, "material");
    const kept = await updateDocument(id, { content: BODY, versionNote: "Fixed a typo", ackActor: actor, ackSource: "edit" });
    assert.ok(kept);
    assert.equal(kept.ack_outcome!.substantive, true);
    assert.equal(kept.ack_outcome!.reset, false, "looks editorial with high confidence: kept unasked");
    assert.equal(kept.ack_outcome!.policy, "auto");
    assert.equal(kept.ack_outcome!.source, "default", "the document's setting decided, not the caller");
    assert.equal((await pool().query(stamps, [id])).rows[0].ack_version_id, v1, "the marker stays");
    assert.equal(await acked(id), 1);
    assert.ok(await getCurrentAck(id, readerId));
    assert.equal((await listVersions(id)).length, 2, "the version is still written");
    const [decision] = await listAckDecisions(id);
    assert.equal(decision.id, kept.ack_outcome!.decision_id);
    assert.equal(decision.outcome, "kept");
    assert.equal(decision.source, "default");
    assert.equal(decision.submitted_policy, "", "nobody chose");
    assert.equal(decision.suggested, "keep");
    assert.equal(decision.overrode_suggestion, false);
    assert.equal(decision.reason, "Fixed a typo");
    assert.equal(decision.decided_by, otherId);
    assert.equal(decision.confirmations_affected, 1);

    const reset = await updateDocument(id, { content: NUMBER, versionNote: "Threshold raised", ackActor: actor, ackSource: "edit" });
    assert.ok(reset);
    assert.equal(reset.ack_outcome!.reset, true, "a number changed: material, so it resets");
    assert.equal(reset.ack_outcome!.source, "edit");
    assert.equal(await acked(id), 0);
    const [newest] = await listAckDecisions(id);
    assert.equal(newest.outcome, "reset");
    assert.equal(newest.source, "edit");
    assert.equal(newest.suggested, "reset");
    assert.equal((await pool().query(stamps, [id])).rows[0].ack_version_id, await latestVersionId(id));

    // An explicit answer is always honoured under 'material' (the editor
    // answered the question): a keep of a material change is recorded as
    // the editor's own, with the override noted.
    await recordAcknowledgement(id, readerId, "", await latestVersionId(id));
    const chosen = await updateDocument(id, {
      content: NUMBER.replace("over 25 pounds", "over 30 pounds"),
      ackPolicy: "keep",
      ackReason: "The threshold was already announced in March",
      ackActor: actor,
      ackSource: "edit",
    });
    assert.equal(chosen!.ack_outcome!.reset, false);
    assert.equal(chosen!.ack_outcome!.source, "edit");
    const [own] = await listAckDecisions(id);
    assert.equal(own.outcome, "kept");
    assert.equal(own.source, "edit");
    assert.equal(own.overrode_suggestion, true);
    assert.equal(await acked(id), 1);
  });

  test("the keep side's change note follows keep_reason_required; the reset side always needs one", async () => {
    const { id } = await confirmedPolicy(`${STAMP} a5 reason`, "ask");
    const short = { content: BODY, ackReason: "typo", ackActor: actor, ackSource: "edit" as const };
    await assert.rejects(updateDocument(id, { ...short, ackPolicy: "keep" }), AckReasonRequiredError, "required by default");
    await assert.rejects(
      updateDocument(id, { ...short, ackPolicy: "keep", ackKeepReasonRequired: true }),
      AckReasonRequiredError
    );
    await assert.rejects(
      updateDocument(id, { ...short, ackPolicy: "reset", ackKeepReasonRequired: false }),
      AckReasonRequiredError,
      "the reset side is never excused"
    );
    assert.equal((await listVersions(id)).length, 1, "nothing was written");

    const kept = await updateDocument(id, { ...short, ackPolicy: "keep", ackKeepReasonRequired: false });
    assert.ok(kept);
    assert.equal(kept.ack_outcome!.substantive, true);
    assert.equal(kept.ack_outcome!.reset, false);
    assert.equal(kept.ack_outcome!.policy, "keep");
    assert.equal(await acked(id), 1);
    const [decision] = await listAckDecisions(id);
    assert.equal(decision.outcome, "kept");
    assert.equal(decision.reason, "typo", "whatever was typed is still recorded");
    assert.equal(decision.source, "edit");
  });

  test("'material' decides for an approval too: an editorial request is kept from source 'default', a material one resets", async () => {
    const title = `${STAMP} a5 approval`;
    const { id, v1 } = await confirmedPolicy(title, "material");
    const propose = (content: string, note: string) =>
      createChangeRequest({
        document_id: id,
        kind: "edit",
        title,
        content,
        summary: "",
        tags: [],
        type: "policy",
        target_status: "published",
        note,
        created_by: otherId,
      });

    const kept = await approveChangeRequest(await propose(BODY, "Fixed a typo"), approverId, "Rev Approver");
    assert.ok(kept);
    assert.equal(kept.version_written, true);
    assert.equal(kept.ack_outcome.substantive, true);
    assert.equal(kept.ack_outcome.reset, false, "looks editorial with high confidence: kept without asking");
    assert.equal(kept.ack_outcome.policy, "auto");
    assert.equal(kept.ack_outcome.source, "default", "the document's setting decided, not the approval");
    assert.equal((await pool().query(stamps, [id])).rows[0].ack_version_id, v1, "the marker stays");
    assert.equal(await acked(id), 1);
    assert.ok(await getCurrentAck(id, readerId));
    assert.equal((await listVersions(id)).length, 2, "the approved version is still written");
    const [decision] = await listAckDecisions(id);
    assert.equal(decision.id, kept.ack_outcome.decision_id);
    assert.equal(decision.outcome, "kept");
    assert.equal(decision.source, "default");
    assert.equal(decision.suggested, "keep");
    assert.equal(decision.submitted_policy, "");
    assert.equal(decision.reason, "Fixed a typo", "the request's change note");
    assert.equal(decision.decided_by, approverId);
    assert.equal(decision.submitted_by, otherId);
    assert.equal(decision.version_id, await latestVersionId(id), "the decision cites the approved text");
    assert.equal(decision.confirmations_affected, 1);

    const reset = await approveChangeRequest(await propose(NUMBER, "Threshold raised"), approverId, "Rev Approver");
    assert.ok(reset);
    assert.equal(reset.ack_outcome.reset, true, "a number changed: material, so it resets");
    assert.equal(reset.ack_outcome.source, "approval");
    assert.equal(reset.ack_outcome.confirmations_reset, 1);
    assert.equal(await acked(id), 0);
    const [newest] = await listAckDecisions(id);
    assert.equal(newest.outcome, "reset");
    assert.equal(newest.source, "approval");
    assert.equal(newest.suggested, "reset");
    assert.equal((await pool().query(stamps, [id])).rows[0].ack_version_id, await latestVersionId(id));
  });

  test("'material' decides for a scheduled publish too: a draft whose only drift is a typo fix is kept from source 'default'", async () => {
    const { id, v1 } = await confirmedPolicy(`${STAMP} a5 schedule`, "material");
    await updateDocument(id, { status: "draft", ackActor: actor, ackSource: "edit" });
    await updateDocument(id, { content: BODY, versionNote: "Fixed a typo", ackActor: actor, ackSource: "edit" });
    const v2 = await latestVersionId(id);
    assert.equal((await pool().query(stamps, [id])).rows[0].ack_version_id, v1, "the marker waits while it is a draft");
    assert.equal((await listAckDecisions(id)).length, 0);
    await setDocSchedule(id, { publishAt: new Date(Date.now() - 60_000).toISOString() });

    await runDueDocSchedules();

    const row = (await pool().query("SELECT status, publish_at, ack_version_id FROM documents WHERE id = $1", [id])).rows[0];
    assert.equal(row.status, "published");
    assert.equal(row.publish_at, null);
    assert.equal(row.ack_version_id, v1, "the marker stays on the confirmed text");
    assert.ok(await getCurrentAck(id, readerId));
    assert.equal(await acked(id), 1);
    const decisions = await listAckDecisions(id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, "kept");
    assert.equal(decisions[0].source, "default");
    assert.equal(decisions[0].version_id, v2, "the decision cites the published text");
    assert.equal(decisions[0].suggested, "keep");
    assert.equal(decisions[0].decided_by, null);
    assert.equal(decisions[0].decided_by_name, "", "no person: the History page says Automatic");
    assert.equal(decisions[0].reason, "Published on schedule");
    assert.equal(decisions[0].confirmations_affected, 1);
    const echo = await pool().query(
      "SELECT details FROM audit_log WHERE action = 'ack.confirmations_kept' AND target_id = $1 ORDER BY id DESC LIMIT 1",
      [String(id)]
    );
    assert.equal(echo.rows.length, 1, "the kept decision is echoed to the audit log");
    assert.equal(echo.rows[0].details.source, "default");
  });
});

describe("a confirmation cannot land inside a reset", () => {
  test("a confirmation that waits on an open reset is refused once the reset commits", async () => {
    const id = await newPolicy(`${STAMP} race`, "Old words");
    const v1 = await latestVersionId(id);

    // The editor's transaction: the new version is inserted and the marker
    // moved, but nothing is committed yet. The documents row is locked.
    const editor = await pool().connect();
    await editor.query("BEGIN");
    const v2 = (
      await editor.query<{ id: number }>(
        "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1, $2, 'New words', 'test', 'Edited') RETURNING id",
        [id, `${STAMP} race`]
      )
    ).rows[0].id;
    await editor.query("UPDATE documents SET content = 'New words', updated_at = now() WHERE id = $1", [id]);
    await resetAcknowledgements(editor, id, {
      versionId: v2,
      actor: { id: otherId, name: "Rev Other" },
      source: "edit",
      reason: "Everything changed, read it again",
    });

    // The reader confirms the version they are looking at, v1, while the
    // reset is open: the call must block on the row lock, not insert.
    let settled = false;
    const confirming = recordAcknowledgement(id, readerId, "", v1).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(settled, false, "the confirmation waits for the reset to commit");

    await editor.query("COMMIT");
    editor.release();
    assert.deepEqual(await confirming, { recorded: false, stale: true }, "refused: v1 is no longer the version to confirm");
    const rows = await pool().query("SELECT COUNT(*)::int AS n FROM acknowledgements WHERE document_id = $1", [id]);
    assert.equal(rows.rows[0].n, 0, "no row cites the old words");
    assert.equal(await getCurrentAck(id, readerId), undefined);
    // After the reset the reader confirms the new words as usual.
    assert.deepEqual(await recordAcknowledgement(id, readerId, "", v2), { recorded: true, stale: false });
    assert.equal((await getCurrentAck(id, readerId))!.content_sha256, sha("New words"));
  });

  test("the marker is the wall clock when it moves, not the transaction start, and the decision row carries the same stamp", async () => {
    const id = await newPolicy(`${STAMP} clock`, "Words");
    await recordAcknowledgement(id, readerId, "", await latestVersionId(id));
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const started = (await client.query<{ t: string }>("SELECT now()::text AS t")).rows[0].t;
      await client.query("SELECT pg_sleep(0.05)");
      // A reader whose transaction took the lock first would have committed
      // a row stamped after `started`; the marker must land after that row.
      const r = await resetAcknowledgements(client, id, {
        versionId: await latestVersionId(id),
        actor: { id: approverId, name: "Rev Approver" },
        source: "manual",
        reason: "Annual re-confirmation",
      });
      const row = (
        await client.query<{ later: boolean; same: boolean }>(
          `SELECT (d.ack_revision_at > $2::timestamptz) AS later, (x.decided_at = d.ack_revision_at) AS same
           FROM documents d JOIN ack_decisions x ON x.id = $3 WHERE d.id = $1`,
          [id, started, r.decision_id]
        )
      ).rows[0];
      assert.equal(row.later, true, "the marker is later than the transaction's start");
      assert.equal(row.same, true, "the decision row and the marker share the stamp");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    assert.equal(await getCurrentAck(id, readerId), undefined);
  });
});
