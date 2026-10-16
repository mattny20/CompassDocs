// Read confirmations are current against the confirmation marker, not
// updated_at (1.10.0, A1): a metadata-only save or a no-op save keeps every
// confirmation, only a moved marker asks again, and each new row cites the
// version it was made against with the SHA-256 of that version's text.
//
// updateDocument does not move the marker in this wave (that is A2's
// ackPolicy); the "asks again" cases here move it the way resetAcknowledgements
// will, so they pin the query semantics rather than the editor's choice.
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
    await updateDocument(id, { content: "Second text" });
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
