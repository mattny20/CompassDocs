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
  exemptAssignments,
  insertAckNotices,
  runDbMaintenance,
  complianceReportCounts,
  saveAudienceRules,
  createPolicySet,
  assignPolicySet,
  autoAssignPolicies,
  createRole,
  assignRole,
  createSession,
} from "../src/lib/db";
import { sanitizeRules } from "../src/lib/audience";
import { isoWeekId } from "../src/lib/periodic";
import { newToken } from "../src/lib/password";
import type { Mailer } from "../src/lib/compliance";
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
const setIds: number[] = [];
const extraGroupIds: number[] = [];
/** The monthly and weekly periods this file claims (far in the past, so no real tick ever takes them). */
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

/** An ISO week no real tick ever claims, unique to this run (the weekly report's period). */
function pastWeek(): { week: string; at: Date } {
  const at = new Date(Date.UTC(1971 + Math.floor(Math.random() * 20), Math.floor(Math.random() * 12), 10, 9));
  const week = isoWeekId(at);
  periods.push(week);
  return { week, at };
}

/** A person of this file's own, active, with an address. */
async function newUser(tag: string, name: string, createdAt?: string): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, created_at) VALUES ($1, $2, $3, 'viewer', 'active', COALESCE($4::timestamptz, now())) RETURNING id`,
    [`${STAMP}-${tag}`, name, `${STAMP}-${tag}@example.test`, createdAt ?? null]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

/** The assignment row of a person on a policy. */
async function rowOf(docId: number, userId: number): Promise<{ id: number; source: string }> {
  return (await pool().query("SELECT id, source FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [docId, userId])).rows[0];
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
  // Each id list paired with the target_type it names: documents, snapshots
  // and sets are separate sequences, so a bare target_id would also match
  // another file's row on another table with the same number.
  await fixtureQuery(
    `DELETE FROM audit_log WHERE action LIKE 'ack.%' AND (
          (target_type = 'document' AND target_id = ANY($1))
       OR (target_type = 'compliance' AND (target_id = ANY($2) OR target_label = ANY($3) OR (details->>'snapshot_id')::int = ANY($4)))
       OR (target_type = 'compliance_snapshot' AND (target_id = ANY($2) OR details->>'user_id' = $5))
       OR (target_type = 'policy_set' AND target_id = ANY($6))
       OR (target_type = 'user' AND target_id = ANY($7)))`,
    [docIds.map(String), snaps.map(String), periods, snaps, String(readerId), setIds.map(String), userIds.map(String)]
  );
  await fixtureQuery("DELETE FROM compliance_snapshots WHERE id = ANY($1)", [snaps]);
  await fixtureQuery("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  // A joiner's welcome row (notifyWelcome: mode 'welcome', or 'request' for
  // one policy, naming that one person) is keyed to their earliest-due
  // policy, which may be another file's: by person too, and only a row that
  // names one of these people alone.
  for (const id of userIds) {
    await fixtureQuery("DELETE FROM ack_outbox WHERE mode IN ('welcome', 'request') AND user_ids = $1::jsonb", [JSON.stringify([id])]);
  }
  await fixtureQuery("DELETE FROM policy_sets WHERE id = ANY($1)", [setIds]);
  await fixtureQuery("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2) OR document_title LIKE $3", [
    docIds,
    userIds,
    `${STAMP}%`,
  ]);
  await fixtureQuery("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await fixtureQuery("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM policy_assignments WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM groups WHERE id = ANY($1)", [[groupId, ...extraGroupIds]]);
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

    // Exempt rows stay outside the counts (beside them), and a snooze hides
    // nothing: Evi Other is exempted, Mia Manager is long overdue with her
    // reminders snoozed.
    const exempted = await exemptAssignments(id, [(await rowOf(id, otherId)).id], { id: readerId, name: "Evi Reader" }, { reason: "On leave", until: null });
    assert.equal(exempted.changed.length, 1);
    await pool().query(
      "UPDATE policy_assignments SET due_at = now() - interval '100 days', snoozed_until = now() + interval '7 days' WHERE document_id = $1 AND user_id = $2",
      [id, managerId]
    );
    const now = JSON.parse((await buildComplianceSnapshot({ documentId: id })).text);
    const q = now.policies[0];
    assert.equal(q.exempt, 1, "the exempt row is counted beside the others");
    assert.equal(q.overdue, 1, "the snoozed row is overdue all the same");
    assert.equal(q.confirmed, 1);
    assert.equal(q.pending, q.required - 1, "the exempt row is not in required");
    const live = now.matrix.filter((r: { account_status: string; removed_at: string | null }) => r.account_status === "active" && !r.removed_at);
    assert.equal(q.required + q.exempt, live.length, "every live row is required or exempt, never both");
    const cell = (userId: number) => now.matrix.find((r: { user_id: number }) => r.user_id === userId);
    assert.equal(cell(otherId).status, "exempt");
    assert.equal(cell(managerId).status, "overdue");
    assert.ok(cell(managerId).snoozed_until, "the snooze is on the row");
    assert.equal(now.totals.exempt, 1);
    assert.equal(now.totals.overdue, 1);
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
    // An exemption, a notice and an audit row on each policy: A's package
    // carries A's and nothing of B's in the three org-wide files too.
    const by = { id: readerId, name: "Evi Reader" };
    for (const p of [a, b]) {
      const ex = await exemptAssignments(p.id, [(await rowOf(p.id, managerId)).id], by, { reason: "On leave", until: null });
      assert.equal(ex.changed.length, 1);
      await fixtureQuery(
        `INSERT INTO audit_log (actor_name, action, target_type, target_id, target_label, details)
         VALUES ('system', 'ack.export', 'document', $1, $2, '{}'::jsonb)`,
        [String(p.id), `${STAMP} audit ${p.id}`]
      );
    }
    await insertAckNotices(
      [a, b].map((p) => ({
        user_id: otherId,
        user_name: "Evi Other",
        user_email: `${STAMP}-other@example.test`,
        document_id: p.id,
        document_title: p === a ? `${STAMP} only A` : `${STAMP} only B`,
        kind: "reminder" as const,
        channels: ["email" as const],
      }))
    );
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
    const waivers = parseCsv(await z.text("waivers.csv"));
    assert.ok(waivers.rows.length >= 1, "A's exemption is there");
    assert.ok(waivers.rows.every((r) => r[waivers.header.indexOf("policy_id")] === String(a.id)), "no exemption of B");
    const notices = parseCsv(await z.text("notices.csv"));
    assert.ok(notices.rows.length >= 1, "A's notice is there");
    assert.ok(notices.rows.every((r) => r[notices.header.indexOf("policy_id")] === String(a.id)), "no notice of B");
    const extract = parseCsv(await z.text("audit-extract.csv"));
    const tid = extract.header.indexOf("target_id");
    assert.ok(extract.rows.some((r) => r[tid] === String(a.id)), "A's audit row is there");
    assert.ok(extract.rows.every((r) => r[tid] === String(a.id)), "no audit row of B");
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
    // The exempt and the snoozed-overdue rows of 'the snapshot text' above.
    assert.ok(counts.exempt >= 1, "exempt rows are reported beside the counts");
    assert.ok(counts.overdue >= 1, "a snoozed row that is overdue is reported overdue");
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

    // Weekly, enabled, a recipient: without SMTP (mailer null, whatever the
    // test database's SMTP settings) nothing is sent and the week's claim is
    // not taken, so a workspace that configures SMTP later in the week still
    // gets that week's report.
    await setSetting("ack_report", JSON.stringify({ enabled: true, cadence: "weekly", recipients: [managerId] }));
    await pool().query("DELETE FROM settings WHERE key = 'ack_report_week'");
    await weeklyComplianceReport(new Date("2026-10-20T09:00:00.000Z"), { mailer: null });
    assert.equal(await getSetting("ack_report_week"), undefined, "the claim was not burnt");
    assert.equal(
      (await pool().query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ack.report_sent' AND target_label = '2026-W43'")).rows[0].n,
      0,
      "nothing was sent"
    );
    // Disabled: nothing either way.
    await setSetting("ack_report", JSON.stringify({ enabled: false, cadence: "weekly", recipients: [managerId] }));
    await weeklyComplianceReport(new Date("2026-10-20T09:00:00.000Z"));
    assert.equal(await getSetting("ack_report_week"), undefined);
  });

  test("the weekly report: a list nobody on it can receive burns nothing; two instances in parallel send once and audit once; a third finds the week taken", async () => {
    const { week, at } = pastWeek();
    const sent: string[] = [];
    const mailer: Mailer = async (to) => {
      sent.push(...to);
    };
    const reportsSent = async () =>
      (
        await pool().query<{ details: { period: string; cadence: string; recipients: number[]; sent: number } }>(
          "SELECT details FROM audit_log WHERE action = 'ack.report_sent' AND target_type = 'compliance' AND target_label = $1",
          [week]
        )
      ).rows;

    // Every recipient deactivated since the save (stored directly: both
    // routes refuse it): nothing is sent and the week is not claimed.
    await setSetting("ack_report", JSON.stringify({ enabled: true, cadence: "weekly", recipients: [disabledId] }));
    await pool().query("DELETE FROM settings WHERE key = 'ack_report_week'");
    await weeklyComplianceReport(at, { mailer });
    assert.deepEqual(sent, []);
    assert.equal(await getSetting("ack_report_week"), undefined, "the week is not burnt with nobody to mail");
    assert.equal((await reportsSent()).length, 0);

    // One active recipient beside the disabled one: two ticks at once mail once.
    await setSetting("ack_report", JSON.stringify({ enabled: true, cadence: "weekly", recipients: [managerId, disabledId] }));
    await Promise.all([weeklyComplianceReport(at, { mailer }), weeklyComplianceReport(at, { mailer })]);
    assert.deepEqual(sent, [`${STAMP}-manager@example.test`], "one mail, to the active recipient");
    assert.equal(await getSetting("ack_report_week"), week);
    const audited = await reportsSent();
    assert.equal(audited.length, 1, "one ack.report_sent row");
    assert.deepEqual(
      { period: audited[0].details.period, cadence: audited[0].details.cadence, recipients: audited[0].details.recipients, sent: audited[0].details.sent },
      { period: week, cadence: "weekly", recipients: [managerId], sent: 1 }
    );
    await weeklyComplianceReport(at, { mailer });
    assert.equal(sent.length, 1, "a third call finds the week taken");
    assert.equal((await reportsSent()).length, 1);
  });

  test("new joiners are counted by the account: one admitted by an onboarding set counts, an older account a set admits does not", async () => {
    // A window no other file's rows fall in: a month in the 1960s.
    const y = 1960 + Math.floor(Math.random() * 10);
    const m = Math.floor(Math.random() * 12);
    const from = new Date(Date.UTC(y, m, 1));
    const to = new Date(Date.UTC(y, m + 1, 1));
    const inside = new Date(Date.UTC(y, m, 15, 12)).toISOString();

    // An onboarding set (auto-assign on) over a targeted policy whose rules
    // name a group nobody is in, and a space-mode policy beside it.
    const nobody = (await createGroup({ name: `${STAMP} nobody` })).id;
    extraGroupIds.push(nobody);
    const targeted = await policy(`${STAMP} onboarding`);
    await saveAudienceRules(targeted.id, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "group", ref: nobody }]) });
    const spaceWide = await policy(`${STAMP} space joiner`);
    const set = await createPolicySet(
      { name: `${STAMP} New starter onboarding`, description: "", doc_ids: [targeted.id], assign_new_members: true },
      { id: managerId, name: "Mia Manager" }
    );
    setIds.push(set.id);

    // Two joiners (accounts created now, backdated into the window below)
    // and an account from long before, all able to read the space.
    const viaSet = await newUser("joiner-set", "Jo Set");
    const viaSpace = await newUser("joiner-space", "Jo Space");
    const older = await newUser("older", "Old Hand", "1950-01-01T00:00:00Z");
    // Straight into the group (as test/ack-sets.test.ts adds its joiners), so
    // the rows below are the ones autoAssignPolicies and the set write.
    for (const id of [viaSet, viaSpace, older]) {
      await fixtureQuery("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, id]);
    }
    await retryOnTeardownRace(() => autoAssignPolicies(viaSet));
    await retryOnTeardownRace(() => autoAssignPolicies(viaSpace));
    const assigned = await assignPolicySet(set.id, { user_ids: [older], group_ids: [], everyone: false }, { id: managerId, name: "Mia Manager" });
    assert.equal(assigned.added >= 1, true, JSON.stringify(assigned));
    assert.equal((await rowOf(targeted.id, viaSet)).source, "set", "the set admitted the joiner");
    assert.equal((await rowOf(spaceWide.id, viaSpace)).source, "new_member", "the space admitted the other joiner");
    assert.equal((await rowOf(targeted.id, older)).source, "set", "the set admitted the older account");

    await pool().query("UPDATE users SET created_at = $2 WHERE id = ANY($1)", [[viaSet, viaSpace], inside]);
    for (const [doc, user] of [
      [targeted.id, viaSet],
      [spaceWide.id, viaSpace],
      [targeted.id, older],
    ]) {
      await pool().query("UPDATE policy_assignments SET assigned_at = $3 WHERE document_id = $1 AND user_id = $2", [doc, user, inside]);
    }
    const counts = await complianceReportCounts(from.toISOString(), to.toISOString());
    assert.equal(counts.new_joiners, 2, "the set's joiner and the space's joiner; not the older account");
  });
});

describe("erasure and the pure rules", () => {
  test("anonymisation rewrites the snapshots that named the person, re-hashes them and records the hash that no longer applies", async () => {
    const { id, v1 } = await policy(`${STAMP} erasure`);
    await recordAcknowledgement(id, readerId, "", v1);
    const snap = await takeComplianceSnapshot("manual", { by: { id: managerId, name: "Mia Manager" }, documentId: id });
    snapshotIds.push(snap!.id);
    // And one the reader took themself: its taker's name is personal data too.
    const byReader = await takeComplianceSnapshot("manual", { by: { id: readerId, name: "Evi Reader" }, documentId: id });
    snapshotIds.push(byReader!.id);
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
    // The Evidence page's "by {name}" (taken_by_name) follows the erasure;
    // another person's snapshot keeps its taker.
    const listed = await listComplianceSnapshots(500);
    assert.equal(listed.find((s) => s.id === byReader!.id)?.taken_by_name, `Former staff #${readerId}`);
    assert.equal(listed.find((s) => s.id === snap!.id)?.taken_by_name, "Mia Manager");
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

describe("housekeeping", () => {
  test("runDbMaintenance drops a deadline claim whose policy is gone, and keeps one whose policy exists and any other key", async () => {
    const { id } = await policy(`${STAMP} housekeeping`);
    // An id no document has (documents.id is an int4 and the test database holds far fewer).
    const gone = `ack_deadline_hook_${2_000_000_000 + Math.floor(Math.random() * 100_000_000)}`;
    const kept = `ack_deadline_hook_${id}`;
    const other = `ack_deadline_hook_${STAMP}`;
    try {
      for (const key of [gone, kept, other]) await setSetting(key, "2026-10-21");
      await runDbMaintenance();
      assert.equal(await getSetting(gone), undefined, "the purged policy's claim is gone");
      assert.equal(await getSetting(kept), "2026-10-21", "a live policy's claim stays");
      assert.equal(await getSetting(other), "2026-10-21", "a key without a numeric suffix is not touched");
    } finally {
      await pool().query("DELETE FROM settings WHERE key = ANY($1)", [[gone, kept, other]]);
    }
  });
});

// --- The per-policy package's gate -----------------------------------------------
// GET /api/documents/{id}/acknowledgements is called directly, as
// test/team-policies.test.ts calls its route: next/headers resolves to a stub
// serving the request under test (a session cookie per person), lib/ee to the
// licensed stub installed above. The package carries the IP and user agent of
// every confirmation, so it takes compliance.export exactly as the ledger CSV:
// the roster permission and document.ack_require on the space are not enough.

describe("GET /api/documents/{id}/acknowledgements?format=package", () => {
  let currentRequest: Request | null = null;
  let route: typeof import("../src/app/api/documents/[id]/acknowledgements/route");
  const sessions = new Map<number, string>();
  const roleIds: number[] = [];
  let stewardId = 0;
  let exporterId = 0;

  before(async () => {
    const Module = (await import("node:module")).default;
    const path = (await import("node:path")).default;
    const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.ack-snapshots.virtual.js");
    const jar = () => {
      const out = new Map<string, string>();
      for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
      }
      return out;
    };
    const headers = new Module(HEADERS_STUB);
    headers.filename = HEADERS_STUB;
    headers.loaded = true;
    headers.exports = {
      headers: async () => new Headers(currentRequest?.headers ?? {}),
      cookies: async () => {
        const c = jar();
        return {
          get: (name: string) => (c.has(name) ? { name, value: c.get(name) } : undefined),
          getAll: () => [...c].map(([name, value]) => ({ name, value })),
          has: (name: string) => c.has(name),
        };
      },
      draftMode: async () => ({ isEnabled: false }),
    };
    require.cache[HEADERS_STUB] = headers;
    const loader = Module as unknown as {
      _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
    };
    const resolveFilename = loader._resolveFilename;
    loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
      if (request === "next/headers") return HEADERS_STUB;
      return resolveFilename.call(this, request, parent, ...rest);
    };
    route = await import("../src/app/api/documents/[id]/acknowledgements/route");

    // Two viewers who read the space (the group's grant): a steward holding
    // the roster permission and document.ack_require, and an exporter who
    // also holds compliance.export.
    stewardId = await newUser("steward", "Stu Steward");
    exporterId = await newUser("exporter", "Exa Exporter");
    for (const id of [stewardId, exporterId]) {
      await fixtureQuery("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, id]);
    }
    const steward = await createRole({ name: `Steward ${STAMP}`, permissions: ["document.ack_roster_read", "document.ack_require"] });
    const exporter = await createRole({ name: `Exporter ${STAMP}`, permissions: ["compliance.export"] });
    assert.ok("id" in steward && "id" in exporter, "the custom roles exist");
    roleIds.push((steward as { id: number }).id, (exporter as { id: number }).id);
    await assignRole({ roleId: roleIds[0], userId: stewardId });
    await assignRole({ roleId: roleIds[0], userId: exporterId });
    await assignRole({ roleId: roleIds[1], userId: exporterId });
    for (const id of [stewardId, exporterId]) {
      const token = newToken();
      await createSession(token, id, new Date(Date.now() + 3_600_000).toISOString());
      sessions.set(id, token);
    }
  });

  after(async () => {
    await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [[stewardId, exporterId]]);
    if (roleIds.length) await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  });

  async function get(as: number, docId: number, query: string): Promise<Response> {
    const req = new Request(`http://localhost/api/documents/${docId}/acknowledgements?${query}`, {
      headers: { cookie: `compass_session=${sessions.get(as)}`, "x-forwarded-for": "203.0.113.9" },
    });
    currentRequest = req;
    try {
      return await route.GET(req, { params: Promise.resolve({ id: String(docId) }) });
    } finally {
      currentRequest = null;
    }
  }

  test("the roster permission and document.ack_require open the record but not the package; compliance.export opens it", async () => {
    const { id, v1 } = await policy(`${STAMP} package gate`);
    await recordAcknowledgement(id, readerId, "198.51.100.7", v1, { userAgent: "Mozilla/5.0 (gate)" });

    let res = await get(stewardId, id, "format=csv");
    assert.equal(res.status, 200, "the steward reads the record");
    await res.text();
    for (const format of ["package", "ledger"]) {
      res = await get(stewardId, id, `format=${format}`);
      assert.equal(res.status, 403, `format=${format} needs compliance.export`);
      assert.deepEqual(await res.json(), { error: "You don't have permission for that." });
    }

    res = await get(exporterId, id, "format=package");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    const z = await unzip(Buffer.from(await res.arrayBuffer()));
    assert.ok(z.names.includes(`policies/${id}/roster.csv`), "the policy's own package");
    const acks = parseCsv(await z.text("acknowledgements.csv"));
    assert.equal(acks.rows[0][acks.header.indexOf("ip")], "198.51.100.7", "the personal data the gate protects");
    // Audited once the stream has closed.
    let audited = 0;
    for (let i = 0; i < 20 && audited === 0; i++) {
      audited = (
        await pool().query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ack.audit_export' AND target_type = 'document' AND target_id = $1",
          [String(id)]
        )
      ).rows[0].n;
      if (audited === 0) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(audited, 1, "ack.audit_export");
  });
});
