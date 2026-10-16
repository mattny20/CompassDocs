// Read confirmations are current against the confirmation marker, not
// updated_at (1.10.0, A1): a metadata-only save or a no-op save keeps every
// confirmation, only a moved marker asks again, and each new row cites the
// version it was made against with the SHA-256 of that version's text.
//
// The first describe pins the query semantics (it moves the marker with SQL
// the way resetAcknowledgements does); the second drives the marker through
// updateDocument's ackPolicy (A2): a no-op save writes nothing, a kept text
// edit leaves the marker, a reset moves it, 'auto' resets, and the
// requirement being off advances the marker silently.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { asScope } from "../src/lib/space-scope";
import {
  pool,
  getSetting,
  createDocument,
  updateDocument,
  setAckRequired,
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
  AckReasonRequiredError,
} from "../src/lib/db";

const STAMP = `ackrev-${Date.now()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let spaceId = 0;
let readerId = 0;
let otherId = 0;
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
  await setAckRequired(doc.id, true);
  docIds.push(doc.id);
  return doc.id;
}

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

describe("read confirmation marker and version evidence", () => {
  before(async () => {
    await getSetting("__schema_bootstrap__"); // run the schema and migrations first
    const sp = await pool().query(
      `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
      [`Ack Revision ${STAMP}`, STAMP]
    );
    spaceId = sp.rows[0].id;
    const users = await pool().query(
      `INSERT INTO users (username, name, email, role, status) VALUES
         ($1, 'Rev Reader', $2, 'viewer', 'active'),
         ($3, 'Rev Other', $4, 'viewer', 'active')
       RETURNING id`,
      [`${STAMP}-reader`, `${STAMP}-reader@example.test`, `${STAMP}-other`, `${STAMP}-other@example.test`]
    );
    readerId = users.rows[0].id;
    otherId = users.rows[1].id;
  });

  after(async () => {
    await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [
      docIds,
      [readerId, otherId],
    ]);
    await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [
      docIds,
      `${STAMP}%`,
    ]);
    await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
    await pool().query("DELETE FROM users WHERE id = ANY($1)", [[readerId, otherId]]);
    await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
  });

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
    await setAckRequired(id, true);
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
