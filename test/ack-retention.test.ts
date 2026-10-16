// Attestation records outlive the person and the policy (1.10.0, C5): a
// deleted account leaves its rows with a name snapshot, a disabled one drops
// out of the count but not the record, a purged policy leaves the attested
// text behind every hash in attested_texts, and anonymising replaces who a
// record names without touching what it says.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  pool,
  getSetting,
  createDocument,
  setAckRequired,
  recordAcknowledgement,
  getCurrentAck,
  ackStatusForDocument,
  ackFormerStaffRows,
  complianceDocs,
  deleteUser,
  countUserAttestations,
  deleteDocument,
  purgeDocument,
  purgeExpiredTrash,
  getAttestedVersion,
  anonymiseComplianceRecord,
  attestationCountsByUser,
  listVersions,
} from "../src/lib/db";

const STAMP = `ackret-${Date.now()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let spaceId = 0;
const userIds: number[] = [];
const docIds: number[] = [];

async function newUser(tag: string, status: "active" | "disabled" = "active"): Promise<number> {
  const r = await pool().query(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', $4) RETURNING id`,
    [`${STAMP}-${tag}`, `Ret ${tag}`, `${STAMP}-${tag}@example.test`, status]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function newPolicy(title: string, content = "Policy body"): Promise<{ id: number; v1: number }> {
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

describe("attestation retention", () => {
  before(async () => {
    await getSetting("__schema_bootstrap__"); // run the schema and migrations first
    const sp = await pool().query(
      `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
      [`Ack Retention ${STAMP}`, STAMP]
    );
    spaceId = sp.rows[0].id;
  });

  after(async () => {
    await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2) OR document_title LIKE $3", [
      docIds,
      userIds,
      `${STAMP}%`,
    ]);
    await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
    await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
    await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
    await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
  });

  test("the foreign keys relax to SET NULL once, and the flags say so", async () => {
    const fks = await pool().query<{ conname: string; confdeltype: string; convalidated: boolean }>(
      "SELECT conname, confdeltype, convalidated FROM pg_constraint WHERE conrelid = 'acknowledgements'::regclass AND contype = 'f' ORDER BY conname"
    );
    assert.deepEqual(
      fks.rows.map((r) => [r.conname, r.confdeltype, r.convalidated]),
      [
        ["acknowledgements_document_id_fkey", "n", true],
        ["acknowledgements_user_id_fkey", "n", true],
      ]
    );
    const flags = await pool().query(
      "SELECT key, value FROM settings WHERE key IN ('ack_retention_schema','ack_marker_schema') ORDER BY key"
    );
    assert.deepEqual(
      flags.rows.map((r) => `${r.key}=${r.value}`),
      ["ack_marker_schema=1", "ack_retention_schema=1"]
    );
  });

  test("deleting a user keeps the record with the name snapshot; the roster lists them as left", async () => {
    const leaver = await newUser("leaver");
    const stayer = await newUser("stayer");
    const { id, v1 } = await newPolicy(`${STAMP} leaver`);
    await recordAcknowledgement(id, leaver, "", v1);
    await recordAcknowledgement(id, stayer, "", v1);
    assert.equal(await countUserAttestations(leaver), 1);

    assert.equal(await deleteUser(leaver), true);

    const rows = await pool().query(
      "SELECT user_id, user_name, user_email, version_id, content_sha256 FROM acknowledgements WHERE document_id = $1 AND user_id IS NULL",
      [id]
    );
    assert.equal(rows.rows.length, 1, "the row survived the account");
    assert.equal(rows.rows[0].user_name, "Ret leaver");
    assert.equal(rows.rows[0].user_email, `${STAMP}-leaver@example.test`);
    assert.equal(rows.rows[0].version_id, v1);
    assert.equal(rows.rows[0].content_sha256, sha("Policy body"));

    const status = await ackStatusForDocument(id);
    assert.ok(status.some((s) => s.id === stayer), "the live audience is in the roster");
    assert.ok(!status.some((s) => s.id === leaver), "the leaver is not");
    const docs = await complianceDocs();
    const mine = docs.find((d) => d.id === id)!;
    assert.equal(mine.required, status.length, "the denominator is the live audience (every active account in the shared database)");
    assert.equal(mine.acked, 1, "only the stayer's confirmation counts");

    const former = await ackFormerStaffRows(id);
    assert.equal(former.length, 1);
    assert.equal(former[0].reason, "left");
    assert.equal(former[0].user_id, null);
    assert.equal(former[0].name, "Ret leaver");
    assert.equal(former[0].rev, 1);
    assert.equal(former[0].version_source, "recorded");
    assert.equal(former[0].current, true);
  });

  test("a disabled account drops out of the count but stays in the record as disabled", async () => {
    const person = await newUser("disabled");
    const { id, v1 } = await newPolicy(`${STAMP} disabled`);
    await recordAcknowledgement(id, person, "", v1);
    await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [person]);

    assert.ok(!(await ackStatusForDocument(id)).some((s) => s.id === person));
    const former = await ackFormerStaffRows(id);
    assert.equal(former.length, 1);
    assert.equal(former[0].reason, "disabled");
    assert.equal(former[0].user_id, person);
    assert.equal(former[0].username, `${STAMP}-disabled`);
  });

  test("purging a trashed policy archives the attested text, and the hash still resolves", async () => {
    const reader = await newUser("purge");
    const { id, v1 } = await newPolicy(`${STAMP} purged`, "Retired policy text");
    await recordAcknowledgement(id, reader, "", v1);
    const ack = await getCurrentAck(id, reader);
    assert.equal(ack!.content_sha256, sha("Retired policy text"));

    const live = await getAttestedVersion(v1);
    assert.equal(live!.source, "live");
    assert.equal(live!.content_sha256, ack!.content_sha256);

    assert.equal(await deleteDocument(id), true);
    assert.equal(await purgeDocument(id), true);

    const gone = await pool().query("SELECT 1 FROM doc_versions WHERE id = $1", [v1]);
    assert.equal(gone.rows.length, 0, "the version row went with the document");
    const row = await pool().query(
      "SELECT document_id, document_title, version_id, content_sha256 FROM acknowledgements WHERE user_id = $1",
      [reader]
    );
    assert.equal(row.rows.length, 1, "the confirmation survived the purge");
    assert.equal(row.rows[0].document_id, null);
    assert.equal(row.rows[0].document_title, `${STAMP} purged`);
    assert.equal(row.rows[0].version_id, v1, "the version id is kept so the archive resolves");

    const archived = await getAttestedVersion(v1);
    assert.ok(archived, "the attested text is in the archive");
    assert.equal(archived.source, "archived");
    assert.equal(archived.content, "Retired policy text");
    assert.equal(archived.content_sha256, row.rows[0].content_sha256, "the archive hash matches the record");
    assert.equal(archived.document_title, `${STAMP} purged`);
    assert.equal(archived.title, `${STAMP} purged`);
    assert.equal(sha(archived.content), archived.content_sha256, "the text verifies against its hash");

    // A version nobody confirmed and no marker cites is not archived.
    assert.equal(await purgeDocument(id), false, "already gone");
  });

  test("the automatic purge archives too, and only the versions a record cites", async () => {
    const reader = await newUser("auto");
    const { id, v1 } = await newPolicy(`${STAMP} auto`, "First text");
    await recordAcknowledgement(id, reader, "", v1);
    // A version nobody confirmed, no marker and no decision cites: inserted
    // directly, because updateDocument now records a decision (A2/C1).
    await pool().query(
      "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1, $2, 'Second text', 'test', 'Edited')",
      [id, `${STAMP} auto`]
    );
    const versions = await listVersions(id);
    const v2 = versions[0].id;
    assert.notEqual(v2, v1);
    await pool().query("UPDATE documents SET deleted_at = now() - interval '40 days' WHERE id = $1", [id]);

    const n = await purgeExpiredTrash(30);
    assert.ok(n >= 1, "the expired document was purged");

    const kept = await pool().query("SELECT version_id FROM attested_texts WHERE document_id = $1 ORDER BY version_id", [id]);
    assert.deepEqual(
      kept.rows.map((r) => r.version_id),
      [v1],
      "v1 (confirmed and the marker) is archived; v2 (cited by nothing) is not"
    );
    assert.equal(await getAttestedVersion(v2), undefined);
  });

  test("anonymising replaces who a record names; counts, dates, versions and hashes stay", async () => {
    const person = await newUser("anon");
    const { id, v1 } = await newPolicy(`${STAMP} anon`);
    await recordAcknowledgement(id, person, "203.0.113.9", v1);
    const before = (await getCurrentAck(id, person))!;

    const result = await anonymiseComplianceRecord(person);
    assert.deepEqual(result, { rows: 1, snapshots_rewritten: 0 });

    const row = await pool().query(
      "SELECT user_id, user_name, user_email, ip, acknowledged_at, version_id, content_sha256 FROM acknowledgements WHERE user_id = $1",
      [person]
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].user_name, `Former staff #${person}`);
    assert.equal(row.rows[0].user_email, "");
    assert.equal(row.rows[0].ip, "");
    assert.equal(new Date(row.rows[0].acknowledged_at).getTime(), new Date(before.acknowledged_at).getTime());
    assert.equal(row.rows[0].version_id, v1);
    assert.equal(row.rows[0].content_sha256, before.content_sha256);
    assert.ok(await getCurrentAck(id, person), "still current while the account exists");
    assert.equal((await attestationCountsByUser()).get(person), 1);

    await deleteUser(person);
    const former = await ackFormerStaffRows(id);
    assert.equal(former.length, 1);
    assert.equal(former[0].name, `Former staff #${person}`);
    assert.equal(former[0].email, "");
  });
});
