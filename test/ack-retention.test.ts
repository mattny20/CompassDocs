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
import { fixtureQuery } from "./support/retry";
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
import {
  ROSTER_CSV_HEADER,
  MATRIX_CSV_HEADER,
  LEDGER_CSV_HEADER,
  ATTESTATION_CSV_COLUMNS,
  EXEMPTION_CSV_COLUMNS,
  personalDataCells,
  personalDataForViewer,
  ledgerCsvCells,
  attestationCsvCells,
  recertCsvCells,
  exemptionCsvCells,
  rosterStatus,
  type LedgerCsvRow,
} from "../src/lib/read-evidence";

const STAMP = `ackret-${Date.now()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let spaceId = 0;
const userIds: number[] = [];
const docIds: number[] = [];

async function newUser(tag: string, status: "active" | "disabled" = "active"): Promise<number> {
  const r = await fixtureQuery(
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
    const sp = await fixtureQuery(
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

    // Purging again is a no-op.
    assert.equal(await purgeDocument(id), false, "already gone");
  });

  test("purging a document that is not in the Trash does nothing, not even the archive", async () => {
    const reader = await newUser("live");
    const { id, v1 } = await newPolicy(`${STAMP} live`, "Live policy text");
    await recordAcknowledgement(id, reader, "", v1);
    assert.equal(await purgeDocument(id), false, "a live document cannot be purged");
    const archived = await pool().query("SELECT 1 FROM attested_texts WHERE version_id = $1", [v1]);
    assert.equal(archived.rows.length, 0, "its versions were not copied into the archive");
    const still = await pool().query("SELECT deleted_at FROM documents WHERE id = $1", [id]);
    assert.equal(still.rows.length, 1);
    assert.equal(still.rows[0].deleted_at, null);
    assert.equal((await getAttestedVersion(v1))!.source, "live");
  });

  test("the automatic purge leaves a document with confirmations alone (G3, 1.12.0), archives only the cited versions of what it removes, and Delete forever still archives the rest", async () => {
    const reader = await newUser("auto");
    const { id, v1 } = await newPolicy(`${STAMP} auto`, "First text");
    await recordAcknowledgement(id, reader, "", v1);
    // The same policy with nobody's confirmation: only its marker cites v1.
    const bare = await newPolicy(`${STAMP} auto bare`, "Bare first text");
    // On each, a version nobody confirmed, no marker and no decision cites:
    // inserted directly, because updateDocument now records a decision (A2/C1).
    for (const [docId, title] of [
      [id, `${STAMP} auto`],
      [bare.id, `${STAMP} auto bare`],
    ] as const) {
      await pool().query(
        "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1, $2, 'Second text', 'test', 'Edited')",
        [docId, title]
      );
    }
    const v2 = (await listVersions(id))[0].id;
    const bareV2 = (await listVersions(bare.id))[0].id;
    assert.notEqual(v2, v1);
    assert.notEqual(bareV2, bare.v1);
    await pool().query("UPDATE documents SET deleted_at = now() - interval '40 days' WHERE id = ANY($1)", [[id, bare.id]]);

    // No assertion on the count: test/ack-retire.test.ts sweeps the same
    // Trash in parallel and may purge this file's expired document first.
    // The rows below prove the sweep ran.
    await purgeExpiredTrash(30);
    const stayed = await pool().query("SELECT 1 FROM documents WHERE id = $1", [id]);
    assert.equal(stayed.rows.length, 1, "a document with confirmations on record is never auto-purged: it waits for Delete forever");
    const notYet = await pool().query("SELECT 1 FROM attested_texts WHERE document_id = $1", [id]);
    assert.equal(notYet.rows.length, 0, "and nothing of it was archived yet");
    const gone = await pool().query("SELECT 1 FROM documents WHERE id = $1", [bare.id]);
    assert.equal(gone.rows.length, 0, "the one without confirmations was purged");
    const bareKept = await pool().query("SELECT version_id FROM attested_texts WHERE document_id = $1 ORDER BY version_id", [bare.id]);
    assert.deepEqual(bareKept.rows.map((r) => r.version_id), [bare.v1], "its v1 (the marker) is archived; v2 (cited by nothing) is not");
    assert.equal(await getAttestedVersion(bareV2), undefined);

    // The deliberate purge takes the confirmed one, archiving what the
    // record cites and nothing else.
    assert.equal(await purgeDocument(id), true);
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
    await recordAcknowledgement(id, person, "203.0.113.9", v1, { signedName: "Ret anon", userAgent: "Mozilla/5.0 (test)" });
    const before = (await getCurrentAck(id, person))!;

    const result = await anonymiseComplianceRecord(person);
    assert.deepEqual(result, { rows: 1, snapshots_rewritten: 0 });

    const row = await pool().query(
      "SELECT user_id, user_name, user_email, ip, signed_name, user_agent, acknowledged_at, version_id, content_sha256 FROM acknowledgements WHERE user_id = $1",
      [person]
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].user_name, `Former staff #${person}`);
    assert.equal(row.rows[0].user_email, "");
    assert.equal(row.rows[0].ip, "");
    assert.equal(row.rows[0].signed_name, "", "the typed signature is the person's name: blank (1.14.0)");
    assert.equal(row.rows[0].user_agent, "", "and the browser string goes with it");
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

// The CSV contracts (C4, 1.12.0): existing columns stay in place, the six
// new ones close the line, the ledger header is the documented one, and the
// two personal-data columns are blank for a caller without
// compliance.export. Pure: no database.
describe("CSV headers and the personal-data rule", () => {
  const ROSTER_1110 =
    "name,username,email,role,status,acknowledged_at,document,revision_as_of,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked,ip,user_agent,version_published_by,version_approved_by,read_seconds,reached_end_self_reported";
  const MATRIX_1101 =
    "document,space,revision_as_of,name,username,email,role,acknowledged_at,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked,version_published_by,version_approved_by";
  const SIX = ",statement,signed_name,identity_proof,recert_months,effective_at,next_recert_at";
  /** The five 1.13.0 (D2) columns: after the six, on both files. */
  const FIVE = ",exempt_reason,exempt_by,exempt_until,snoozed_until,due_at";
  /** The two 1.14.0 columns (F1 status, D3 set): after the five, on the matrix. */
  const TWO = ",status,set";

  const ledgerRow: LedgerCsvRow = {
    document_title: "Expenses",
    document_id: 7,
    space_name: "HR",
    name: "Dana Writer",
    username: "dana",
    email: "dana@example.test",
    role: "viewer",
    acknowledged_at: "2026-03-03T10:00:00.000Z",
    superseded: true,
    rev: 12,
    version_id: 99,
    content_sha256: "abc",
    version_source: "recorded",
    statement_text: "I confirm that I have read and understood this document.",
    signed_name: "Dana Writer",
    identity_proof: "password",
    read_seconds: 240,
    reached_end: true,
    ip: "203.0.113.9",
    user_agent: "Mozilla/5.0",
    account_removed: false,
  };

  test("both export headers keep their legacy prefix, then the six 1.12.0 columns, then the five 1.13.0 columns; the matrix then the two of 1.14.0", () => {
    assert.ok(ROSTER_CSV_HEADER.startsWith(ROSTER_1110), "the roster header starts with the 1.11.0 columns");
    assert.ok(ROSTER_CSV_HEADER.startsWith(ROSTER_1110 + SIX), "the 1.12.0 columns are still in place");
    assert.equal(ROSTER_CSV_HEADER, ROSTER_1110 + SIX + FIVE + ",set", "the 1.14.0 roster appends the policy's sets");
    assert.ok(MATRIX_CSV_HEADER.startsWith(MATRIX_1101), "the matrix header starts with the 1.10.1 columns");
    assert.ok(MATRIX_CSV_HEADER.startsWith(MATRIX_1101 + SIX));
    assert.ok(MATRIX_CSV_HEADER.startsWith(MATRIX_1101 + SIX + FIVE), "the 1.13.0 columns are still in place");
    assert.equal(MATRIX_CSV_HEADER, MATRIX_1101 + SIX + FIVE + TWO);
    assert.equal(`,${ATTESTATION_CSV_COLUMNS}`, SIX);
    assert.equal(`,${EXEMPTION_CSV_COLUMNS}`, FIVE);
  });

  test("the status column and the five exemption cells (1.13.0, D2): 'exempt' outranks a confirmation; the three exemption cells only on an exempt row; five blanks for a former staff member", () => {
    assert.equal(rosterStatus({ acknowledged_at: null }), "pending");
    assert.equal(rosterStatus({ acknowledged_at: "2026-03-03T10:00:00.000Z" }), "acknowledged");
    assert.equal(rosterStatus({ acknowledged_at: "2026-03-03T10:00:00.000Z", exempt: true }), "exempt");
    assert.equal(rosterStatus({ acknowledged_at: null, exempt: false }), "pending");
    assert.deepEqual(exemptionCsvCells({}), ["", "", "", "", ""], "a former-staff row, or a row type without the fields");
    assert.deepEqual(
      exemptionCsvCells({
        exempt: true,
        exempt_reason: "On leave",
        exempt_by_name: "Priya Shah",
        exempt_until: "2026-12-01T00:00:00.000Z",
        snoozed_until: null,
        due_at: "2026-10-29T00:00:00.000Z",
      }),
      ["On leave", "Priya Shah", "2026-12-01T00:00:00.000Z", "", "2026-10-29T00:00:00.000Z"]
    );
    assert.deepEqual(
      exemptionCsvCells({ exempt: false, exempt_reason: "stale", exempt_by_name: "stale", exempt_until: "2026-12-01T00:00:00.000Z", snoozed_until: "2026-10-22T09:00:00.000Z", due_at: null }),
      ["", "", "", "2026-10-22T09:00:00.000Z", ""],
      "not exempt: the three exemption cells are blank whatever the columns hold; a snooze shows"
    );
    assert.deepEqual(
      exemptionCsvCells({ exempt: true, exempt_reason: "Standing", exempt_by_name: "", exempt_until: null, due_at: new Date("2026-10-29T00:00:00.000Z") }),
      ["Standing", "", "", "", "2026-10-29T00:00:00.000Z"],
      "a standing exemption has no until; a pg Date is written as ISO"
    );
    const header = ROSTER_CSV_HEADER.split(",");
    assert.equal(header.indexOf("exempt_reason"), header.indexOf("next_recert_at") + 1, "the five follow the six");
    assert.equal(header[header.length - 2], "due_at", "the five close 1.13.0's line");
    assert.equal(header[header.length - 1], "set", "the policy's sets close the line since 1.14.0 (D3)");
  });

  test("the ledger header is the documented one, and a ledger line has one cell per column", () => {
    assert.equal(
      LEDGER_CSV_HEADER,
      "document,document_id,space,name,username,email,role,acknowledged_at,superseded,version,version_id,content_sha256,version_source,statement,signed_name,identity_proof,read_seconds,reached_end_self_reported,ip,user_agent,account_removed"
    );
    const header = LEDGER_CSV_HEADER.split(",");
    const cells = ledgerCsvCells(ledgerRow, true);
    assert.equal(cells.length, header.length);
    assert.equal(cells[header.indexOf("superseded")], "yes");
    assert.equal(cells[header.indexOf("version")], "v12");
    assert.equal(cells[header.indexOf("statement")], ledgerRow.statement_text);
    assert.equal(cells[header.indexOf("signed_name")], "Dana Writer");
    assert.equal(cells[header.indexOf("identity_proof")], "password");
    assert.equal(cells[header.indexOf("read_seconds")], 240);
    assert.equal(cells[header.indexOf("reached_end_self_reported")], "yes");
    assert.equal(cells[header.indexOf("ip")], "203.0.113.9");
    assert.equal(cells[header.indexOf("user_agent")], "Mozilla/5.0");
    assert.equal(cells[header.indexOf("account_removed")], "no");
  });

  test("ip and user_agent are blank without compliance.export, on the cells and on the row", () => {
    assert.deepEqual(personalDataCells(ledgerRow, false), ["", ""]);
    assert.deepEqual(personalDataCells(ledgerRow, true), ["203.0.113.9", "Mozilla/5.0"]);
    assert.deepEqual(personalDataCells(null, true), ["", ""], "no recorded access, nothing to show");
    const header = LEDGER_CSV_HEADER.split(",");
    const cells = ledgerCsvCells(ledgerRow, false);
    assert.equal(cells[header.indexOf("ip")], "");
    assert.equal(cells[header.indexOf("user_agent")], "");
    assert.equal(cells[header.indexOf("name")], "Dana Writer", "only the two personal-data cells change");
    const blanked = personalDataForViewer(ledgerRow, false);
    assert.equal(blanked.ip, "");
    assert.equal(blanked.user_agent, "");
    assert.equal(blanked.signed_name, "Dana Writer");
    assert.equal(personalDataForViewer(ledgerRow, true), ledgerRow, "an exporter gets the row as recorded");
  });

  test("attestation and re-confirmation cells: blank while pending or unset, YYYY-MM-DD for a date", () => {
    assert.deepEqual(attestationCsvCells({ acknowledged_at: null, statement_text: "x", signed_name: "y", identity_proof: "z" }), ["", "", ""]);
    assert.deepEqual(attestationCsvCells({ acknowledged_at: "2026-03-03T10:00:00.000Z" }), ["", "", ""], "a row type without the fields still writes three cells");
    assert.deepEqual(
      attestationCsvCells({ acknowledged_at: "2026-03-03T10:00:00.000Z", statement_text: "I confirm", signed_name: "Dana Writer", identity_proof: "sso_session" }),
      ["I confirm", "Dana Writer", "sso_session"]
    );
    assert.deepEqual(recertCsvCells({}), ["", "", ""]);
    assert.deepEqual(recertCsvCells({ ack_recert_months: null, ack_effective_at: null, ack_next_recert_at: null }), ["", "", ""]);
    assert.deepEqual(
      recertCsvCells({ ack_recert_months: 12, ack_effective_at: new Date("2026-01-01T00:00:00.000Z"), ack_next_recert_at: "2027-01-01T00:00:00.000Z" }),
      [12, "2026-01-01", "2027-01-01T00:00:00.000Z"],
      "a pg Date becomes its calendar day; a timestamp string is written as is"
    );
  });
});
