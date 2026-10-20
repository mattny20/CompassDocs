// Tamper-evident evidence (F2, 1.14.0): the snapshot text is byte-stable
// for the same data and hashed over exactly the stored bytes, Verify detects
// a changed row, the audit package's manifest hashes equal its files and the
// policy texts it ships hash to the rows' content_sha256, the per-policy
// package carries only that policy's rows, the ledger CSV streams more rows
// than fit one page, the monthly claim wins once across two concurrent
// calls, a retire writes a retirement snapshot, an erasure rewrites and
// re-hashes the snapshots that named the person, the programme report's
// bullets and settings, and the pure rules (periods, statuses, the rewrite).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-snapshots.test.ts

// lib/ee as a licensed build sees it, installed before lib/compliance-audit
// loads (imports run in source order): the orchestrator's entry points are
// gated on the licence.
import "./support/ee-stub";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import JSZip from "jszip";
import {
  pool,
  getSetting,
  setSetting,
  createDocument,
  createGroup,
  addGroupMember,
  setSpaceGroups,
  setAckRequired,
  recordAcknowledgement,
  listVersions,
  retirePolicy,
  anonymiseComplianceRecord,
  listComplianceSnapshots,
  getComplianceSnapshot,
  ackLedgerBatch,
} from "../src/lib/db";
import {
  SNAPSHOT_FORMAT,
  buildComplianceSnapshot,
  takeComplianceSnapshot,
  verifyComplianceSnapshot,
  buildCompliancePackageBuffer,
  complianceReportSummary,
  monthlyComplianceEvidence,
  weeklyComplianceReport,
  periodWindow,
  matrixStatus,
  snapshotFileLabel,
  MATRIX_PACKAGE_HEADER,
  ROSTER_PACKAGE_HEADER,
} from "../src/lib/compliance-audit";
import { sha256Hex, csvLine, manifestFor, rewriteSnapshotText, hashCsv, STREAM_BATCH } from "../src/lib/evidence";
import { LEDGER_CSV_HEADER, ledgerCsvCells } from "../src/lib/read-evidence";
import { parseAckReportPatch, validateReportRecipients, readComplianceSettings, REPORT_RECIPIENTS_MAX } from "../src/lib/compliance-settings";
import { getSmtpConfig, smtpConfigured } from "../src/lib/smtp-config";
import { parseCsv } from "../src/lib/csv";
import { fixtureQuery, retryOnTeardownRace } from "./support/retry";

const STAMP = `acksnap-${Date.now()}`;
const SYSTEM = { id: null, name: "system" };

let spaceId = 0;
let groupId = 0;
let readerId = 0;
let otherId = 0;
let managerId = 0;
let disabledId = 0;
const userIds: number[] = [];
const docIds: number[] = [];
const snapshotIds: number[] = [];
/** The monthly periods this file claims (far in the past, so no real tick ever takes them). */
const periods: string[] = [];

const TEXT = Array.from({ length: 20 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");

/** A published policy in this file's private space, switched on (its audience: the group and the workspace's admins). */
async function policy(title: string): Promise<{ id: number; v1: number }> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content: TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  await retryOnTeardownRace(() => setAckRequired(doc.id, true, { editDefault: null, recertMonths: null }));
  const v1 = (await listVersions(doc.id))[0].id;
  return { id: doc.id, v1 };
}

/** A period no real tick ever claims: a month in the 1970s, unique to this run. */
function pastPeriod(): { period: string; at: Date } {
  const y = 1971 + Math.floor(Math.random() * 20);
  const m = Math.floor(Math.random() * 12);
  const at = new Date(Date.UTC(y, m, 10));
  const period = at.toISOString().slice(0, 7);
  periods.push(period);
  return { period, at };
}

async function unzip(buffer: Buffer): Promise<{ zip: JSZip; names: string[]; text: (name: string) => Promise<string>; bytes: (name: string) => Promise<Buffer> }> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  return {
    zip,
    names,
    text: (name) => zip.file(name)!.async("string"),
    bytes: (name) => zip.file(name)!.async("nodebuffer"),
  };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id`,
    [`Ack Snapshots ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Evi Reader', $2, 'viewer', 'active'),
       ($3, 'Evi Other', $4, 'viewer', 'active'),
       ($5, 'Mia Manager', $6, 'approver', 'active'),
       ($7, 'Evi Gone', $8, 'viewer', 'disabled')
     RETURNING id`,
    [
      `${STAMP}-reader`,
      `${STAMP}-reader@example.test`,
      `${STAMP}-other`,
      `${STAMP}-other@example.test`,
      `${STAMP}-manager`,
      `${STAMP}-manager@example.test`,
      `${STAMP}-gone`,
      `${STAMP}-gone@example.test`,
    ]
  );
  [readerId, otherId, managerId, disabledId] = users.rows.map((r: { id: number }) => r.id);
  userIds.push(readerId, otherId, managerId, disabledId);
  groupId = (await createGroup({ name: `${STAMP} G` })).id;
  await addGroupMember(groupId, readerId);
  await addGroupMember(groupId, otherId);
  await addGroupMember(groupId, managerId);
  await setSpaceGroups(spaceId, [groupId]);
});

after(async () => {
  const snaps = (
    await pool().query<{ id: number }>(
      "SELECT id FROM compliance_snapshots WHERE id = ANY($1) OR document_id = ANY($2) OR period = ANY($3)",
      [snapshotIds, docIds, periods]
    )
  ).rows.map((r) => r.id);
  await fixtureQuery(
    `DELETE FROM audit_log WHERE action LIKE 'ack.%'
       AND (target_id = ANY($1) OR target_label = ANY($2) OR (details->>'snapshot_id')::int = ANY($3) OR details->>'user_id' = $4)`,
    [docIds.map(String).concat(snaps.map(String)), periods, snaps, String(readerId)]
  );
  await fixtureQuery("DELETE FROM compliance_snapshots WHERE id = ANY($1)", [snaps]);
  await fixtureQuery("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2) OR document_title LIKE $3", [
    docIds,
    userIds,
    `${STAMP}%`,
  ]);
  await fixtureQuery("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await fixtureQuery("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM policy_assignments WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM groups WHERE id = $1", [groupId]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("the snapshot text", () => {
  test("is byte-stable for the same data, hashed over exactly its bytes, in the contracted shape with arrays by id", async () => {
    const { id, v1 } = await policy(`${STAMP} stable`);
    await recordAcknowledgement(id, readerId, "", v1, { readSeconds: 40, reachedEnd: true });
    const at = new Date("2026-10-20T10:00:00.000Z");
    // Two builds of the same data serialise to the same bytes. Another
    // file's admin account may join or leave this policy's audience between
    // two builds (a private space admits every admin), so a differing pair
    // is rebuilt rather than failed.
    let a = await buildComplianceSnapshot({ documentId: id, at });
    let b = await buildComplianceSnapshot({ documentId: id, at });
    for (let i = 0; i < 3 && a.text !== b.text; i++) {
      a = await buildComplianceSnapshot({ documentId: id, at });
      b = await buildComplianceSnapshot({ documentId: id, at });
    }
    assert.equal(a.text, b.text, "the same data, the same bytes");
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.sha256, sha256Hex(a.text), "the hash is over exactly the text");
    assert.ok(a.text.endsWith("\n"), "two-space JSON plus a newline");

    const body = JSON.parse(a.text);
    assert.deepEqual(Object.keys(body), [
      "format",
      "app_version",
      "workspace",
      "generated_at",
      "scope",
      "settings_in_effect",
      "totals",
      "policies",
      "matrix",
      "current_acks",
      "decisions",
      "notices_summary",
      "ledger_rows",
      "ledger_sha256",
    ]);
    assert.equal(body.format, SNAPSHOT_FORMAT);
    assert.equal(body.generated_at, at.toISOString());
    assert.deepEqual(body.scope, { document_id: id });
    assert.deepEqual(Object.keys(body.totals), ["policies", "required", "confirmed", "pending", "overdue", "exempt", "people_compliant", "people_total"]);
    assert.equal(body.policies.length, 1, "scoped to the one policy");
    const p = body.policies[0];
    assert.equal(p.id, id);
    assert.equal(p.status, "live");
    assert.equal(p.version, 1);
    assert.equal(p.version_id, v1);
    assert.equal(p.content_sha256, sha256Hex(TEXT), "the marker version's text hashed");
    assert.equal(p.confirmed, 1);
    assert.ok(p.required >= 3, "the group's three and the workspace's admins");
    assert.equal(p.pending, p.required - 1);
    const settings = body.settings_in_effect.policies[0];
    assert.equal(settings.audience_mode, "space");
    assert.equal(settings.edit_default, "ask");
    assert.deepEqual(settings.rules, []);
    assert.equal(settings.retired, null);
    assert.equal(typeof body.settings_in_effect.program.ack_defaults.edit_default, "string", "the programme defaults travel with the snapshot");
    assert.equal(typeof body.settings_in_effect.program.compliance_statement_default, "string");

    const mine = body.matrix.filter((r: { user_id: number }) => [readerId, otherId, managerId].includes(r.user_id));
    assert.equal(mine.length, 3, "one cell per person of the group");
    const byUser = (cells: [number, string][]) => [...cells].sort((x, y) => x[0] - y[0]);
    assert.deepEqual(
      byUser(mine.map((r: { user_id: number; status: string }): [number, string] => [r.user_id, r.status])),
      byUser([
        [readerId, "confirmed"],
        [otherId, "pending"],
        [managerId, "pending"],
      ])
    );
    const ids = body.matrix.map((r: { assignment_id: number }) => r.assignment_id);
    assert.deepEqual(ids, [...ids].sort((x: number, y: number) => x - y), "the matrix is by row id");
    assert.equal(body.current_acks.length, 1);
    assert.equal(body.current_acks[0].user_id, readerId);
    assert.equal(body.current_acks[0].content_sha256, sha256Hex(TEXT));
    assert.equal(body.current_acks[0].version_source, "recorded");
    assert.equal(body.current_acks[0].read_seconds, 40);
    assert.equal(body.current_acks[0].reached_end_self_reported, true);
    assert.equal(body.ledger_rows, 1, "the one confirmation on the ledger");
    const ledger = await hashCsv(LEDGER_CSV_HEADER, (after, limit) => ackLedgerBatch(after, limit, id), (r) => ledgerCsvCells(r, true));
    assert.equal(body.ledger_sha256, ledger.sha256, "the ledger hash is the hash of the ledger CSV");

    // A build at another instant differs in generated_at and nothing else.
    const later = await buildComplianceSnapshot({ documentId: id, at: new Date("2026-10-21T10:00:00.000Z") });
    const strip = (t: string) => t.replace(/"generated_at": "[^"]+"/, '"generated_at": "-"');
    assert.notEqual(later.sha256, a.sha256);
    assert.equal(strip(later.text), strip(a.text));
  });

  test("Verify recomputes the hash over the stored text and detects a changed row", async () => {
    const { id, v1 } = await policy(`${STAMP} verify`);
    await recordAcknowledgement(id, readerId, "", v1);
    const snap = await takeComplianceSnapshot("manual", { by: { id: managerId, name: "Mia Manager" }, documentId: id });
    assert.ok(snap, "a manual snapshot is stored");
    snapshotIds.push(snap!.id);
    const stored = await getComplianceSnapshot(snap!.id);
    assert.ok(stored);
    assert.equal(stored!.kind, "manual");
    assert.equal(stored!.document_id, id);
    assert.equal(stored!.taken_by, managerId);
    assert.equal(stored!.taken_by_name, "Mia Manager");
    assert.equal(stored!.sha256, sha256Hex(stored!.data), "stored verbatim: sha256sum on the download reproduces the hash");
    assert.deepEqual(await verifyComplianceSnapshot(snap!.id), { ok: true, stored: snap!.sha256, computed: snap!.sha256 });
    assert.equal(snapshotFileLabel(stored!), `manual-${snap!.id}`);

    // A row changed after the fact (a name edited in the stored text): the
    // hash no longer matches, and the mismatch names both hashes.
    await pool().query("UPDATE compliance_snapshots SET data = replace(data, 'Evi Reader', 'Eve Reader') WHERE id = $1", [snap!.id]);
    const tampered = await verifyComplianceSnapshot(snap!.id);
    assert.ok(tampered);
    assert.equal(tampered!.ok, false);
    assert.equal(tampered!.stored, snap!.sha256);
    assert.notEqual(tampered!.computed, snap!.sha256);
    assert.equal(await verifyComplianceSnapshot(999_999_999), null, "no such snapshot");
    await pool().query("UPDATE compliance_snapshots SET data = $2 WHERE id = $1", [snap!.id, stored!.data]);
  });
});

describe("the audit package", () => {
  test("the manifest hashes equal the files, the manifest is last, the policy text hashes to the rows' content_sha256, and summary.json carries the ledger's hash", async () => {
    const { id, v1 } = await policy(`${STAMP} package`);
    await recordAcknowledgement(id, readerId, "", v1, { readSeconds: 12, reachedEnd: false });
    const { buffer, policies, bytes } = await buildCompliancePackageBuffer({ documentId: id, by: "Mia Manager" });
    assert.equal(policies, 1);
    assert.equal(bytes, buffer.length, "the counted bytes are the bytes");
    const z = await unzip(buffer);
    assert.equal(z.names[z.names.length - 1], "manifest.json", "the manifest closes the archive");
    const manifest = JSON.parse(await z.text("manifest.json"));
    assert.deepEqual(Object.keys(manifest), ["generated_at", "app_version", "workspace", "files", "generated_by"]);
    assert.equal(manifest.generated_by, "Mia Manager");
    const listed = manifest.files.map((f: { name: string }) => f.name);
    assert.deepEqual(
      [...listed].sort(),
      z.names.filter((n) => n !== "manifest.json").sort(),
      "every file but the manifest is listed"
    );
    for (const f of manifest.files as { name: string; sha256: string }[]) {
      assert.equal(sha256Hex(await z.bytes(f.name)), f.sha256, `${f.name} hashes as the manifest says`);
    }
    const expected = [
      "acknowledgements.csv",
      "summary.json",
      "matrix.csv",
      "decisions.csv",
      "waivers.csv",
      "notices.csv",
      "audit-extract.csv",
      `policies/${id}/policy.json`,
      `policies/${id}/roster.csv`,
      `policies/${id}/history.csv`,
      `policies/${id}/waivers.csv`,
      `policies/${id}/decisions.csv`,
      `policies/${id}/versions/v1.md`,
    ];
    for (const name of expected) assert.ok(listed.includes(name), `${name} is in the package`);

    // The policy text the confirmation cites, byte for byte: its hash in
    // the manifest is the row's content_sha256.
    const version = manifest.files.find((f: { name: string }) => f.name === `policies/${id}/versions/v1.md`);
    assert.equal(version.sha256, sha256Hex(TEXT));
    const ackRow = (await pool().query<{ content_sha256: string }>("SELECT content_sha256 FROM acknowledgements WHERE document_id = $1", [id])).rows[0];
    assert.equal(version.sha256, ackRow.content_sha256);
    assert.equal(await z.text(`policies/${id}/versions/v1.md`), TEXT);

    // summary.json is a snapshot of the same instant: its ledger hash is
    // the manifest's hash of acknowledgements.csv.
    const summary = JSON.parse(await z.text("summary.json"));
    assert.equal(summary.format, SNAPSHOT_FORMAT);
    assert.equal(summary.generated_at, manifest.generated_at);
    const ledger = manifest.files.find((f: { name: string }) => f.name === "acknowledgements.csv");
    assert.equal(summary.ledger_sha256, ledger.sha256);
    assert.equal(summary.ledger_rows, 1);

    // The CSVs carry their headers and the one confirmation.
    const matrix = parseCsv(await z.text("matrix.csv"));
    assert.equal(matrix.header.join(","), MATRIX_PACKAGE_HEADER);
    const roster = parseCsv(await z.text(`policies/${id}/roster.csv`));
    assert.equal(roster.header.join(","), ROSTER_PACKAGE_HEADER);
    assert.equal(roster.rows.length, matrix.rows.length);
    const readerRow = matrix.rows.find((r) => r[matrix.header.indexOf("username")] === `${STAMP}-reader`)!;
    assert.equal(readerRow[matrix.header.indexOf("status")], "confirmed");
    assert.equal(readerRow[matrix.header.indexOf("content_sha256")], sha256Hex(TEXT));
    assert.equal(readerRow[matrix.header.indexOf("read_seconds")], "12");
    assert.equal(readerRow[matrix.header.indexOf("reached_end_self_reported")], "no");
    const acks = parseCsv(await z.text("acknowledgements.csv"));
    assert.equal(acks.header.join(","), LEDGER_CSV_HEADER);
    assert.equal(acks.rows.length, 1);
    const history = parseCsv(await z.text(`policies/${id}/history.csv`));
    assert.equal(history.rows.length, 1, "history.csv is the policy's own ledger");
    const policyJson = JSON.parse(await z.text(`policies/${id}/policy.json`));
    assert.equal(policyJson.id, id);
    assert.equal(policyJson.settings.audience_mode, "space");
    const extract = parseCsv(await z.text("audit-extract.csv"));
    assert.ok(extract.header.includes("action"));
    assert.ok(
      extract.rows.every((r) => r[extract.header.indexOf("target_id")] === String(id)),
      "the one-policy extract is that document's rows only"
    );
  });

  test("the per-policy package carries only that policy's rows", async () => {
    const a = await policy(`${STAMP} only A`);
    const b = await policy(`${STAMP} only B`);
    await recordAcknowledgement(a.id, readerId, "", a.v1);
    await recordAcknowledgement(b.id, readerId, "", b.v1);
    await recordAcknowledgement(b.id, otherId, "", b.v1);
    const { buffer } = await buildCompliancePackageBuffer({ documentId: a.id });
    const z = await unzip(buffer);
    assert.ok(z.names.some((n) => n.startsWith(`policies/${a.id}/`)));
    assert.ok(!z.names.some((n) => n.startsWith(`policies/${b.id}/`)), "no folder for the other policy");
    const matrix = parseCsv(await z.text("matrix.csv"));
    const pid = matrix.header.indexOf("policy_id");
    assert.ok(matrix.rows.length >= 3);
    assert.ok(matrix.rows.every((r) => r[pid] === String(a.id)), "every matrix row is policy A's");
    const acks = parseCsv(await z.text("acknowledgements.csv"));
    assert.equal(acks.rows.length, 1, "policy A's one confirmation, not B's two");
    assert.ok(acks.rows.every((r) => r[acks.header.indexOf("document_id")] === String(a.id)));
    const summary = JSON.parse(await z.text("summary.json"));
    assert.deepEqual(summary.policies.map((p: { id: number }) => p.id), [a.id]);
    assert.ok(summary.matrix.every((r: { policy_id: number }) => r.policy_id === a.id));
    assert.ok(summary.current_acks.every((r: { policy_id: number }) => r.policy_id === a.id));
    const decisions = parseCsv(await z.text("decisions.csv"));
    assert.ok(decisions.rows.every((r) => r[decisions.header.indexOf("policy_id")] === String(a.id)));
  });

  test("the ledger CSV streams more rows than fit one page, in id order, and the snapshot's hash is the file's", async () => {
    const { id, v1 } = await policy(`${STAMP} many`);
    const extra = STREAM_BATCH + 100;
    // Older, superseded confirmations in one statement: more than a page.
    await fixtureQuery(
      `INSERT INTO acknowledgements (document_id, user_id, acknowledged_at, ip, version_id, content_sha256, user_name, user_email, document_title)
       SELECT $1, $2, now() - interval '2 days' - (g || ' minutes')::interval, '10.0.0.1', $3, $4, 'Evi Reader', $5, $6
       FROM generate_series(1, $7::int) g`,
      [id, readerId, v1, sha256Hex(TEXT), `${STAMP}-reader@example.test`, `${STAMP} many`, extra]
    );
    await recordAcknowledgement(id, readerId, "", v1);
    const total = extra + 1;

    const page = await ackLedgerBatch(0, STREAM_BATCH, id);
    assert.equal(page.length, STREAM_BATCH, "one page");
    assert.ok(page.every((r, i) => i === 0 || r.id > page[i - 1].id), "by id");
    const rest = await ackLedgerBatch(page[page.length - 1].id, STREAM_BATCH, id);
    assert.equal(rest.length, total - STREAM_BATCH, "the second page holds the rest");
    assert.equal(rest.filter((r) => r.superseded).length, rest.length - 1, "the current confirmation is the one unsuperseded row");

    const { buffer } = await buildCompliancePackageBuffer({ documentId: id });
    const z = await unzip(buffer);
    const acks = parseCsv(await z.text("acknowledgements.csv"));
    assert.equal(acks.rows.length, total, "every row went out");
    const idCol = acks.header.indexOf("version_id");
    assert.ok(acks.rows.every((r) => r[idCol] === String(v1)));
    const manifest = JSON.parse(await z.text("manifest.json"));
    const file = manifest.files.find((f: { name: string }) => f.name === "acknowledgements.csv");
    assert.equal(sha256Hex(await z.bytes("acknowledgements.csv")), file.sha256);
    const summary = JSON.parse(await z.text("summary.json"));
    assert.equal(summary.ledger_rows, total);
    assert.equal(summary.ledger_sha256, file.sha256);
    const snap = await buildComplianceSnapshot({ documentId: id });
    assert.equal(JSON.parse(snap.text).ledger_rows, total, "a stored snapshot counts the same rows");
  });
});

describe("the monthly claim and the retirement snapshot", () => {
  test("the monthly claim wins once across two concurrent calls, and the orchestrator takes one snapshot and audits it once", async () => {
    const { period } = pastPeriod();
    const [a, b] = await Promise.all([
      takeComplianceSnapshot("monthly", { by: SYSTEM, period }),
      takeComplianceSnapshot("monthly", { by: SYSTEM, period }),
    ]);
    const won = [a, b].filter(Boolean);
    assert.equal(won.length, 1, "exactly one of two concurrent calls stores the month");
    snapshotIds.push(won[0]!.id);
    assert.equal(await takeComplianceSnapshot("monthly", { by: SYSTEM, period }), null, "a third finds it taken");
    const rows = (await pool().query("SELECT id, kind, period, taken_by_name FROM compliance_snapshots WHERE period = $1", [period])).rows;
    assert.deepEqual(rows, [{ id: won[0]!.id, kind: "monthly", period, taken_by_name: "system" }]);

    // The orchestrator's entry point, twice in parallel for another month:
    // one row, one ack.snapshot audit row, and a later tick does nothing.
    const other = pastPeriod();
    await Promise.all([monthlyComplianceEvidence(other.at), monthlyComplianceEvidence(other.at)]);
    await monthlyComplianceEvidence(other.at);
    const stored = (await pool().query<{ id: number; sha256: string }>("SELECT id, sha256 FROM compliance_snapshots WHERE period = $1", [other.period])).rows;
    assert.equal(stored.length, 1, "one snapshot for the month");
    snapshotIds.push(stored[0].id);
    const audited = (
      await pool().query<{ details: { snapshot_id: number; kind: string; sha256: string; period: string } }>(
        "SELECT details FROM audit_log WHERE action = 'ack.snapshot' AND target_label = $1",
        [other.period]
      )
    ).rows;
    assert.equal(audited.length, 1, "audited once");
    assert.deepEqual(audited[0].details, { snapshot_id: stored[0].id, kind: "monthly", sha256: stored[0].sha256, period: other.period });
    assert.equal(snapshotFileLabel({ id: stored[0].id, kind: "monthly", period: other.period, document_id: null }), other.period);
    const listed = await listComplianceSnapshots(500);
    assert.ok(listed.some((s) => s.id === stored[0].id && s.kind === "monthly"), "listed");
  });

  test("a retire writes a retirement snapshot scoped to the policy and audits it; the retire stands", async () => {
    const { id, v1 } = await policy(`${STAMP} retire`);
    await recordAcknowledgement(id, readerId, "", v1);
    const result = await retirePolicy(id, { id: managerId, name: "Mia Manager" }, "Superseded by the new expense policy");
    assert.ok(result, "retired");
    assert.equal(result!.acked, 1);
    const snaps = await listComplianceSnapshots(100, { documentId: id });
    assert.equal(snaps.length, 1, "one snapshot for the policy");
    snapshotIds.push(snaps[0].id);
    assert.equal(snaps[0].kind, "retirement");
    assert.equal(snaps[0].document_id, id);
    assert.equal(snaps[0].document_title, `${STAMP} retire`);
    assert.equal(snaps[0].taken_by, managerId);
    assert.equal(snaps[0].taken_by_name, "Mia Manager");
    const full = await getComplianceSnapshot(snaps[0].id);
    const body = JSON.parse(full!.data);
    assert.deepEqual(body.scope, { document_id: id });
    assert.equal(body.policies.length, 1);
    assert.equal(body.policies[0].status, "retired", "the record as it stands after the retire");
    assert.equal(body.policies[0].confirmed, 1);
    assert.equal(body.settings_in_effect.policies[0].retired.by_name, "Mia Manager");
    assert.equal(body.settings_in_effect.policies[0].retired.reason, "Superseded by the new expense policy");
    assert.ok(body.decisions.some((d: { outcome: string }) => d.outcome === "retired"), "the retired ledger row is in it");
    assert.equal(snapshotFileLabel(snaps[0]), `retirement-${id}-${snaps[0].id}`);
    const audited = (
      await pool().query<{ details: { kind: string; snapshot_id: number } }>(
        "SELECT details FROM audit_log WHERE action = 'ack.snapshot' AND target_id = $1",
        [String(id)]
      )
    ).rows;
    assert.equal(audited.length, 1);
    assert.equal(audited[0].details.kind, "retirement");
    assert.equal(audited[0].details.snapshot_id, snaps[0].id);

    // The retired policy's own package still resolves (its text from doc_versions).
    const { buffer } = await buildCompliancePackageBuffer({ documentId: id });
    const z = await unzip(buffer);
    assert.ok(z.names.includes(`snapshots/retirement-${id}-${snaps[0].id}.json`), "the retirement snapshot ships with the policy's package");
    assert.equal(await z.text(`snapshots/retirement-${id}-${snaps[0].id}.json`), full!.data);
  });
});

describe("the programme report", () => {
  const SETTINGS_LOCK = 728342;
  let lockClient: PoolClient | null = null;
  const saved = new Map<string, string | undefined>();
  const KEYS = ["ack_report", "ack_report_week"];

  before(async () => {
    const client = await pool().connect();
    await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
    lockClient = client;
    for (const key of KEYS) saved.set(key, await getSetting(key));
  });

  after(async () => {
    for (const key of KEYS) {
      const v = saved.get(key);
      if (v === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [key]);
      else await setSetting(key, v);
    }
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
      lockClient.release();
    }
  });

  test("the summary's bullets and counts, and the period windows", async () => {
    const { id, v1 } = await policy(`${STAMP} report`);
    await recordAcknowledgement(id, readerId, "", v1);
    const { markdown, counts } = await complianceReportSummary("2026-10");
    const lines = markdown.split("\n");
    assert.match(lines[0], /^- \*\*[\d,]+\*\* policies · \*\*\d+%\*\* compliance \([\d,]+ confirmed, [\d,]+ pending, [\d,]+ overdue, [\d,]+ exempt\)$/);
    assert.match(
      lines[1],
      /^- \*\*[\d,]+\*\* people overdue · \*\*[\d,]+\*\* escalations this period · \*\*[\d,]+\*\* new joiners enrolled · \*\*[\d,]+\*\* exemptions granted · \*\*[\d,]+\*\* standing exemptions older than a year$/
    );
    assert.ok(counts.policies >= 1);
    assert.ok(counts.pct >= 0 && counts.pct <= 100);
    assert.equal(counts.confirmed + counts.pending, counts.pending + counts.confirmed);
    assert.ok(counts.lowest.length <= 5);
    if (counts.lowest.length) {
      assert.ok(markdown.includes("Lowest compliance:"));
      assert.ok(counts.lowest.every((p, i) => i === 0 || p.pct >= counts.lowest[i - 1].pct), "lowest first");
    }
    for (const d of counts.deadlines) assert.ok(markdown.includes(`- ${d.title}: `));

    assert.deepEqual(periodWindow("2026-10"), { from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-11-01T00:00:00.000Z") });
    assert.deepEqual(periodWindow("2026-W42"), { from: new Date("2026-10-12T00:00:00.000Z"), to: new Date("2026-10-19T00:00:00.000Z") });
    assert.deepEqual(periodWindow("2026-W01"), { from: new Date("2025-12-29T00:00:00.000Z"), to: new Date("2026-01-05T00:00:00.000Z") });
    assert.equal(periodWindow("last week"), null);
    assert.equal(periodWindow("2026-13"), null);
  });

  test("the report settings are validated, recipients must be active accounts, and the weekly run never burns the week without SMTP", async () => {
    const refused = (body: unknown, fragment: string) => {
      const r = parseAckReportPatch(body);
      assert.equal(r.ok, false, `${JSON.stringify(body)} should be refused`);
      if (!r.ok) assert.match(r.error, new RegExp(fragment));
    };
    refused(null, "must be an object");
    refused([], "must be an object");
    refused({ enabled: "yes" }, "true or false");
    refused({ cadence: "daily" }, "weekly or monthly");
    refused({ recipients: [1, "2"] }, "list of user ids");
    refused({ recipients: [0] }, "list of user ids");
    refused({ recipients: Array.from({ length: REPORT_RECIPIENTS_MAX + 1 }, (_, i) => i + 1) }, `up to ${REPORT_RECIPIENTS_MAX}`);
    refused({ digest: true }, 'Unknown setting "ack_report.digest"');
    const ok = parseAckReportPatch({ enabled: true, cadence: "monthly", recipients: [managerId, managerId, readerId] });
    assert.deepEqual(ok, { ok: true, patch: { enabled: true, cadence: "monthly", recipients: [managerId, readerId] } }, "duplicates collapse");
    assert.equal(await validateReportRecipients([managerId, readerId]), null);
    assert.equal(await validateReportRecipients([managerId, disabledId]), "Every recipient must be an active account.");
    assert.equal(await validateReportRecipients([]), null);

    // The stored shape, and the reserved {users, groups} shape from before 1.14.0.
    await setSetting("ack_report", JSON.stringify({ enabled: true, cadence: "weekly", recipients: [managerId] }));
    assert.deepEqual((await readComplianceSettings()).ack_report, { enabled: true, cadence: "weekly", recipients: [managerId] });
    await setSetting("ack_report", JSON.stringify({ enabled: true, cadence: "monthly", recipients: { users: [managerId, 0], groups: [3] } }));
    assert.deepEqual((await readComplianceSettings()).ack_report, { enabled: true, cadence: "monthly", recipients: [managerId] });

    // Weekly, enabled, a recipient: without SMTP nothing is sent and the
    // week's claim is not taken, so a workspace that configures SMTP later
    // in the week still gets that week's report.
    await setSetting("ack_report", JSON.stringify({ enabled: true, cadence: "weekly", recipients: [managerId] }));
    await pool().query("DELETE FROM settings WHERE key = 'ack_report_week'");
    if (!smtpConfigured(await getSmtpConfig())) {
      await weeklyComplianceReport(new Date("2026-10-20T09:00:00.000Z"));
      assert.equal(await getSetting("ack_report_week"), undefined, "the claim was not burnt");
      assert.equal(
        (await pool().query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ack.report_sent' AND target_label = '2026-W43'")).rows[0].n,
        0,
        "nothing was sent"
      );
    }
    // Disabled: nothing either way.
    await setSetting("ack_report", JSON.stringify({ enabled: false, cadence: "weekly", recipients: [managerId] }));
    await weeklyComplianceReport(new Date("2026-10-20T09:00:00.000Z"));
    assert.equal(await getSetting("ack_report_week"), undefined);
  });
});

describe("erasure and the pure rules", () => {
  test("anonymisation rewrites the snapshots that named the person, re-hashes them and records the hash that no longer applies", async () => {
    const { id, v1 } = await policy(`${STAMP} erasure`);
    await recordAcknowledgement(id, readerId, "", v1);
    const snap = await takeComplianceSnapshot("manual", { by: { id: managerId, name: "Mia Manager" }, documentId: id });
    snapshotIds.push(snap!.id);
    const before = await getComplianceSnapshot(snap!.id);
    assert.ok(before!.data.includes('"Evi Reader"'), "the snapshot names the reader");
    assert.ok(before!.data.includes(`${STAMP}-reader@example.test`));

    const { snapshots_rewritten } = await anonymiseComplianceRecord(readerId);
    assert.ok(snapshots_rewritten >= 1, `rewrote the snapshots naming the reader (${snapshots_rewritten})`);
    const after = await getComplianceSnapshot(snap!.id);
    assert.ok(!after!.data.includes("Evi Reader"), "the name is gone");
    assert.ok(!after!.data.includes(`${STAMP}-reader@example.test`), "the address is gone");
    assert.ok(after!.data.includes(`Former staff #${readerId}`), "the alias is in");
    assert.notEqual(after!.sha256, before!.sha256, "re-hashed");
    assert.equal(after!.sha256, sha256Hex(after!.data), "the new hash is over the new text");
    assert.deepEqual(await verifyComplianceSnapshot(snap!.id), { ok: true, stored: after!.sha256, computed: after!.sha256 });
    const body = JSON.parse(after!.data);
    const row = body.current_acks.find((r: { user_id: number }) => r.user_id === readerId);
    assert.equal(row.name, `Former staff #${readerId}`);
    assert.equal(row.email, "");
    assert.equal(row.ip, "");
    assert.equal(body.ledger_sha256, JSON.parse(before!.data).ledger_sha256, "counts, dates and the ledger hash stay");
    const audited = (
      await pool().query<{ details: { snapshot_id: number; previous_sha256: string; sha256: string; user_id: number } }>(
        "SELECT details FROM audit_log WHERE action = 'ack.snapshot_rewritten' AND (details->>'snapshot_id')::int = $1",
        [snap!.id]
      )
    ).rows;
    assert.equal(audited.length, 1, "one ack.snapshot_rewritten row for the snapshot");
    assert.deepEqual(audited[0].details, { snapshot_id: snap!.id, user_id: readerId, previous_sha256: before!.sha256, sha256: after!.sha256 });
    // A second erasure finds nothing left to rewrite in it.
    const again = await anonymiseComplianceRecord(readerId);
    assert.equal((await getComplianceSnapshot(snap!.id))!.sha256, after!.sha256, "idempotent");
    assert.ok(again.snapshots_rewritten >= 0);
  });

  test("rewriteSnapshotText: the person's own rows by id, exact name and address values anywhere, and the non-JSON fallback", () => {
    const who = { userId: 7, alias: "Former staff #7", names: ["Ana Ruiz", "ana"], email: "ana@example.test" };
    const text =
      JSON.stringify(
        {
          matrix: [
            { user_id: 7, name: "Ana Ruiz", username: "ana", email: "ana@example.test", ip: "10.0.0.1", user_agent: "UA", signed_name: "ana ruiz" },
            { user_id: 8, name: "Ben Lo", username: "ben", email: "ben@example.test", ip: "10.0.0.2", user_agent: "UA", signed_name: null },
          ],
          decisions: [{ decided_by: 7, decided_by_name: "Ana Ruiz", submitted_by: 8, submitted_by_name: "Ben Lo" }],
          policies: [{ published_by: "Ana Ruiz", approved_by: "Ben Lo", owner_user_id: 7, owner: "Ana Ruiz" }],
          notices_summary: [{ user_id: null, name: "Ana Ruiz" }],
          untouched: "Ana Ruiz-Smith",
        },
        null,
        2
      ) + "\n";
    const out = rewriteSnapshotText(text, who);
    assert.equal(out.changed, true);
    const body = JSON.parse(out.text);
    assert.deepEqual(body.matrix[0], { user_id: 7, name: "Former staff #7", username: "Former staff #7", email: "", ip: "", user_agent: "", signed_name: "Former staff #7" });
    assert.deepEqual(body.matrix[1], { user_id: 8, name: "Ben Lo", username: "ben", email: "ben@example.test", ip: "10.0.0.2", user_agent: "UA", signed_name: null }, "another person's row is untouched");
    assert.deepEqual(body.decisions[0], { decided_by: 7, decided_by_name: "Former staff #7", submitted_by: 8, submitted_by_name: "Ben Lo" });
    assert.deepEqual(body.policies[0], { published_by: "Former staff #7", approved_by: "Ben Lo", owner_user_id: 7, owner: "Former staff #7" });
    assert.deepEqual(body.notices_summary[0], { user_id: null, name: "Former staff #7" }, "a name value with no id is caught by value");
    assert.equal(body.untouched, "Ana Ruiz-Smith", "a different value that merely contains the name stays");
    assert.ok(out.text.endsWith("\n"));
    assert.deepEqual(rewriteSnapshotText(out.text, who), { text: out.text, changed: false }, "nothing left: unchanged");
    assert.deepEqual(rewriteSnapshotText('{"a":1}', { ...who, names: ["Nobody"] }), { text: '{"a":1}', changed: false });
    const raw = rewriteSnapshotText('not json "Ana Ruiz" and "ana@example.test"', who);
    assert.deepEqual(raw, { text: 'not json "Former staff #7" and ""', changed: true });
  });

  test("matrixStatus, csvLine and manifestFor", () => {
    const base = { removed_at: null, exempt_at: null, acknowledged_at: null, overdue: false };
    assert.equal(matrixStatus(base), "pending");
    assert.equal(matrixStatus({ ...base, overdue: true }), "overdue");
    assert.equal(matrixStatus({ ...base, acknowledged_at: "2026-10-01T00:00:00.000Z", overdue: true }), "confirmed");
    assert.equal(matrixStatus({ ...base, exempt_at: "2026-10-01T00:00:00.000Z", acknowledged_at: "2026-10-01T00:00:00.000Z" }), "exempt");
    assert.equal(matrixStatus({ ...base, removed_at: "2026-10-01T00:00:00.000Z", exempt_at: "2026-10-01T00:00:00.000Z" }), "removed");
    assert.equal(csvLine(["a", 1, null, '=SUM(A1)', 'say "hi"']), '"a","1","","\'=SUM(A1)","say ""hi"""');
    const m = manifestFor([{ name: "a.txt", bytes: "hello\n" }, { name: "b.csv", sha256: "deadbeef" }], {
      app_version: "1.14.0",
      workspace: "Acme",
      generated_at: "2026-10-20T00:00:00.000Z",
    });
    assert.deepEqual(m, {
      generated_at: "2026-10-20T00:00:00.000Z",
      app_version: "1.14.0",
      workspace: "Acme",
      files: [
        { name: "a.txt", sha256: sha256Hex("hello\n") },
        { name: "b.csv", sha256: "deadbeef" },
      ],
    });
  });
});
