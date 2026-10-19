// The confirmation ledger behind the Record tab's All confirmations view and
// the ledger exports (C4, 1.12.0): every acknowledgements row ever written
// for a document, newest first, with the rows the current view no longer
// shows marked superseded, a removed account shown from its snapshot, and a
// purged document from its title snapshot.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { fixtureQuery } from "./support/retry";
import {
  pool,
  getSetting,
  createDocument,
  setAckRequired,
  recordAcknowledgement,
  ackStatusForDocument,
  listAckLedger,
  listAckLedgerAll,
  deleteUser,
  deleteDocument,
  purgeDocument,
  listVersions,
} from "../src/lib/db";

const STAMP = `ackledv-${Date.now()}`;

let spaceId = 0;
let stayer = 0;
let leaver = 0;
let docId = 0;
let title = "";
let v1 = 0;
let v2 = 0;
let v3 = 0;
const userIds: number[] = [];

async function newUser(tag: string, name: string): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP}-${tag}`, name, `${STAMP}-${tag}@example.test`]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

/** A version written straight into doc_versions: the ledger test is about confirmations, not decisions. */
async function newVersion(content: string): Promise<number> {
  const r = await pool().query<{ id: number }>(
    "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1, $2, $3, 'test', 'Edited') RETURNING id",
    [docId, title, content]
  );
  return r.rows[0].id;
}

describe("the confirmation ledger (All confirmations view, ledger exports)", () => {
  before(async () => {
    await getSetting("__schema_bootstrap__"); // run the schema and migrations first
    const sp = await fixtureQuery(
      `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
      [`Ack Ledger View ${STAMP}`, STAMP]
    );
    spaceId = sp.rows[0].id;
    stayer = await newUser("stayer", "Led Stayer");
    leaver = await newUser("leaver", "Led Leaver");
    title = `${STAMP} policy`;
    const doc = await createDocument({
      space_id: spaceId,
      title,
      type: "policy",
      status: "published",
      content: "Policy body v1",
      summary: "",
      tags: [],
      author: "test",
    });
    docId = doc.id;
    await setAckRequired(docId, true);
    v1 = (await listVersions(docId))[0].id;
  });

  after(async () => {
    await pool().query("DELETE FROM acknowledgements WHERE document_id = $1 OR document_title = $2", [docId, title]);
    await pool().query("DELETE FROM attested_texts WHERE document_id = $1", [docId]);
    await pool().query("DELETE FROM ack_decisions WHERE document_id = $1", [docId]);
    await pool().query("DELETE FROM documents WHERE id = $1", [docId]);
    await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
    await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
  });

  test("superseded rows appear in the ledger, newest first, and not in the current view", async () => {
    // Both confirm v1. Then everyone is asked again for v2 (the marker
    // moves), the stayer confirms v2, and after a kept edit (v3, marker
    // unchanged) confirms the current text once more.
    assert.equal((await recordAcknowledgement(docId, stayer, "203.0.113.1", v1)).recorded, true);
    assert.equal((await recordAcknowledgement(docId, leaver, "203.0.113.2", v1)).recorded, true);
    v2 = await newVersion("Policy body v2");
    await pool().query("UPDATE documents SET ack_revision_at = clock_timestamp(), ack_version_id = $2 WHERE id = $1", [docId, v2]);
    assert.equal((await recordAcknowledgement(docId, stayer, "203.0.113.3", v2)).recorded, true);
    v3 = await newVersion("Policy body v3");
    assert.equal((await recordAcknowledgement(docId, stayer, "203.0.113.4", v3)).recorded, true);

    // The current view: one row per person, the stayer on v3, the leaver pending.
    const current = await ackStatusForDocument(docId);
    const mine = current.filter((r) => r.id === stayer || r.id === leaver);
    assert.deepEqual(
      mine.map((r) => [r.id, r.rev, Boolean(r.acknowledged_at)]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        [stayer, 3, true],
        [leaver, null, false],
      ].sort((a, b) => Number(a[0]) - Number(b[0]))
    );
    assert.ok(!current.some((r) => r.rev === 1), "no current row cites v1");

    // The ledger: all four rows, newest first.
    const ledger = await listAckLedger(docId);
    assert.deepEqual(
      ledger.map((r) => [r.name, r.rev]),
      [
        ["Led Stayer", 3],
        ["Led Stayer", 2],
        ["Led Leaver", 1],
        ["Led Stayer", 1],
      ],
      "every row, newest first"
    );
    assert.deepEqual(
      ledger.map((r) => r.superseded),
      [false, true, true, true],
      "the stayer's v2 row is superseded by v3 (still current, no longer shown); both v1 rows by the marker"
    );
    assert.deepEqual(ledger.map((r) => r.current), [true, true, false, false]);
    assert.deepEqual(ledger.map((r) => r.ip), ["203.0.113.4", "203.0.113.3", "203.0.113.2", "203.0.113.1"], "the db row carries the recorded address; the routes blank it for a non-exporter");
    assert.deepEqual(ledger.map((r) => r.account_removed), [false, false, false, false]);
    assert.deepEqual(ledger.map((r) => r.version_source), ["recorded", "recorded", "recorded", "recorded"]);
    assert.ok(ledger.every((r) => r.content_sha256), "every row carries its hash");
    assert.deepEqual(ledger.map((r) => r.version_id), [v3, v2, v1, v1]);
    // The live account: name, username, email and role from the users row.
    assert.equal(ledger[0].user_id, stayer);
    assert.equal(ledger[0].username, `${STAMP}-stayer`);
    assert.equal(ledger[0].email, `${STAMP}-stayer@example.test`);
    assert.equal(ledger[0].role, "viewer");
    assert.equal(ledger[0].document_id, docId);
    assert.equal(ledger[0].document_title, title);
    assert.equal(ledger[0].space_name, `Ack Ledger View ${STAMP}`);
    // The C2 fields travel with the row (blank on an unsigned confirmation).
    assert.equal(ledger[0].statement_text, "");
    assert.equal(ledger[0].signed_name, null);
    assert.equal(ledger[0].identity_proof, "");
    assert.equal(typeof ledger[0].user_agent, "string");
    assert.equal(ledger[0].reached_end, false);
    assert.equal(ledger[0].read_seconds, null);
  });

  test("a removed account shows the snapshot name with account_removed, and leaves the current view", async () => {
    assert.equal(await deleteUser(leaver), true);
    const ledger = await listAckLedger(docId);
    const gone = ledger.find((r) => r.account_removed);
    assert.ok(gone, "the leaver's row is still in the ledger");
    assert.equal(gone.user_id, null);
    assert.equal(gone.name, "Led Leaver", "shown from the row's snapshot");
    assert.equal(gone.email, `${STAMP}-leaver@example.test`);
    assert.equal(gone.username, "");
    assert.equal(gone.role, "");
    assert.equal(gone.rev, 1);
    assert.equal(gone.superseded, true, "the marker moved past it");
    assert.equal(ledger.filter((r) => r.account_removed).length, 1);
    assert.equal(ledger.length, 4, "nothing was lost");
    assert.ok(!(await ackStatusForDocument(docId)).some((r) => r.id === leaver), "the current view no longer lists the account");
  });

  test("the every-document ledger carries the same rows, grouped by document", async () => {
    const all = (await listAckLedgerAll()).filter((r) => r.document_id === docId);
    const one = await listAckLedger(docId);
    assert.deepEqual(
      all.map((r) => r.id),
      one.map((r) => r.id),
      "the same rows in the same order within the document"
    );
    assert.ok(all.every((r) => r.document_title === title && r.space_name === `Ack Ledger View ${STAMP}`));
  });

  test("a purged document's rows stay in the every-document ledger under the title snapshot", async () => {
    assert.equal(await deleteDocument(docId), true);
    assert.equal(await purgeDocument(docId), true);
    const rows = (await listAckLedgerAll()).filter((r) => r.document_title === title);
    assert.equal(rows.length, 4, "the four confirmations survived the purge");
    assert.ok(rows.every((r) => r.document_id === null && r.space_name === ""), "no document, no space");
    assert.ok(rows.every((r) => r.rev === null && r.version_id !== null), "the numbering went with the versions; the ids stay");
    assert.deepEqual(rows.map((r) => r.current), [false, false, false, false], "no marker to be current against");
    assert.deepEqual(
      rows.map((r) => [r.name, r.superseded]),
      [
        ["Led Stayer", false],
        ["Led Stayer", true],
        ["Led Leaver", false],
        ["Led Stayer", true],
      ],
      "superseded only by a later row of the same person"
    );
  });
});
