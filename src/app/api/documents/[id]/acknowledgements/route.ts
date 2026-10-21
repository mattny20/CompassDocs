import { NextResponse } from "next/server";
import {
  pool,
  getDocument,
  ackStatusForDocument,
  ackFormerStaffRows,
  getAckVersionInfo,
  lastAckDecision,
  keptSinceLastReset,
  listAckLedger,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, canSeeDrafts, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { resolvePolicyDefaults } from "@/lib/compliance";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";
import { versionProvenance, provenanceCells } from "@/lib/version-provenance";
import { csvCell } from "@/lib/csv";
import { policySetNames } from "@/lib/db";
import { policySetCsvCell } from "@/lib/policy-sets";
import {
  ROSTER_CSV_HEADER,
  LEDGER_CSV_HEADER,
  evidenceCsvCells,
  attestationCsvCells,
  recertCsvCells,
  personalDataCells,
  personalDataForViewer,
  ledgerCsvCells,
  rosterStatus,
  exemptionCsvCells,
} from "@/lib/read-evidence";

export const dynamic = "force-dynamic";

// The attestation record: who has (and hasn't) confirmed the version everyone
// is asked to confirm. Approver+; ?format=csv downloads it, ?view=all answers
// the ledger (every confirmation ever recorded for the document, superseded
// rows included) as JSON, and ?format=ledger downloads that ledger as CSV
// for a caller who also holds compliance.export (C4, 1.12.0).
//
// CSV columns (existing ones stay in place, new ones are appended — never
// rename): name,username,email,role,status,acknowledged_at,document,
// revision_as_of (the marker date since 1.10.0; was updated_at),
// version ("v12"), version_id, content_sha256, version_source
// (recorded | inferred), former_staff (left | disabled | empty), from the
// decision ledger (C1) asked_at (the marker date), asked_by, reason (who
// last asked everyone and why; empty when the marker predates the ledger)
// and kept_since_asked (edits kept without re-asking since then), and
// (1.10.1, F6) ip and user_agent, filled only for a caller who also holds
// compliance.export (user_agent is recorded from 1.12.0; blank on older
// rows). The space-scoped document.ack_roster_read gate stays: version, hash
// and signed-name columns are the verification handles a steward hands an
// auditor; the IP and the user agent are personal data and belong to
// exporters. After them, version_published_by and version_approved_by (C6):
// who published and approved the version each row cites. After those
// (1.11.0, C3) the reading evidence: read_seconds and
// reached_end_self_reported. Closing the line (1.12.0, C4): statement (the
// confirmation statement the person saw), signed_name and identity_proof
// (C2), then recert_months, effective_at and next_recert_at from the
// documents row (G1). After those (1.13.0, D2) the assignment's exemption
// and deadline: exempt_reason, exempt_by, exempt_until (filled on a row
// whose status is 'exempt'; such a row is in no count), snoozed_until and
// due_at. The headers live in src/lib/read-evidence.ts beside the cell
// rules. Every cell goes through csvCell (quotes doubled, a
// formula-leading value prefixed with a quote), so a name or a note that
// starts with = never runs when the sheet opens.
//
// The JSON rows (the Record tab and the portal's expand row, AckRoster) are
// AckStatusRow as is: with 1.13.0 each carries its assignment (D2:
// assignment_id, due_at, exempt, exempt_reason, exempt_by_name, exempt_at,
// exempt_until, snoozed_until) and the per-person re-ask (D4:
// asked_again_at, asked_again_reason, asked_again_by); `defaults` beside
// them carries the policy's resolved overdue_grace_days (E1), which the
// roster's Overdue chip needs and the portal cannot resolve on its own.
//
// Guards: apiGuard admits a holder of the space-scoped key anywhere, so the
// key is checked again on the document's own space (403); a draft the
// caller may not read is 404, as GET /api/documents/[id] and the ack GET
// answer, because an unpublished policy keeps its title, rows and reasons.
// Every download writes audit ack.export before the response streams.

interface RecordedAccess {
  ip: string;
  user_agent: string;
}

/**
 * The IP and user agent recorded on each confirmation the roster cites,
 * keyed so the match is exact and the currency rule stays in one place
 * (db.ts): the live roster row by (user id, acknowledged_at), the
 * former-staff row by its own id. Timestamps come back as normalised ISO
 * strings on both sides. Read only for an exporter.
 */
async function recordedAccess(docId: number): Promise<{ byUserAt: Map<string, RecordedAccess>; byId: Map<number, RecordedAccess> }> {
  const r = await pool().query<{ id: number; user_id: number | null; acknowledged_at: string; ip: string; user_agent: string }>(
    `SELECT id, user_id, acknowledged_at, ip, user_agent FROM acknowledgements
     WHERE document_id = $1 AND (ip <> '' OR user_agent <> '')`,
    [docId]
  );
  const byUserAt = new Map<string, RecordedAccess>();
  const byId = new Map<number, RecordedAccess>();
  for (const row of r.rows) {
    const access = { ip: row.ip, user_agent: row.user_agent };
    byId.set(row.id, access);
    if (row.user_id != null) byUserAt.set(`${row.user_id}|${row.acknowledged_at}`, access);
  }
  return { byUserAt, byId };
}

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("approver", "document.ack_roster_read");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Read confirmations are not included in your license." },
      { status: 402 }
    );
  }

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!(await userHolds(user, "document.ack_roster_read", { spaceId: doc.space_id, legacyMin: "approver" }))) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }

  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  const view = url.searchParams.get("view");
  const [version, canExport] = await Promise.all([
    getAckVersionInfo(doc.id),
    userHolds(user, "compliance.export", { legacyMin: "admin" }),
  ]);
  const esc = csvCell;

  if (format === "ledger") {
    // The ledger carries the IP and user agent of every confirmation: the
    // roster permission opens the page, compliance.export opens this file.
    if (!canExport) {
      return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
    }
    const ledger = await listAckLedger(doc.id);
    const csv = [LEDGER_CSV_HEADER, ...ledger.map((r) => ledgerCsvCells(r, true).map(esc).join(","))].join("\n");
    await auditAck("ack.export", doc, {
      actor: actorFrom(user),
      ip: ipFrom(req),
      version_id: version.version_id,
      version: version.rev,
      details: { format: "ledger", rows: ledger.length, with_ip: true },
    });
    return csvResponse(csv, `acknowledgements-ledger-doc-${doc.id}.csv`);
  }

  if (format === "package") {
    // The one-policy audit package (F2, 1.14.0): the same ZIP the programme
    // exports, scoped to this policy (its rows, its ledger, its decisions,
    // its notices, its audit rows, its retirement snapshot and the texts
    // its confirmations cite). The roster permission opened the record; the
    // file carries the IP and the user agent of every confirmation, the
    // recipients' addresses and the actors' IPs, so it takes
    // compliance.export, exactly as the ledger CSV above. Audited as
    // ack.audit_export once the stream has closed, with the bytes sent.
    if (!canExport) {
      return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
    }
    const { buildCompliancePackage } = await import("@/lib/compliance-audit");
    const pkg = await buildCompliancePackage({ documentId: doc.id, by: user.name || user.username });
    const actor = actorFrom(user);
    const ip = ipFrom(req);
    pkg.done
      .then(({ bytes, policies }) =>
        auditAck("ack.audit_export", doc, {
          actor,
          ip,
          version_id: version.version_id,
          version: version.rev,
          details: { format: "package", document_id: doc.id, bytes, policies },
        })
      )
      .catch((e) => console.error(`[ack] audit package of document ${doc.id}:`, e));
    return new Response(pkg.stream, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${pkg.filename}"`,
        "cache-control": "no-store",
      },
    });
  }

  if (view === "all") {
    // The ledger as JSON for the All confirmations view: every row, with
    // the two personal-data fields blank unless the caller may export.
    const ledger = await listAckLedger(doc.id);
    return NextResponse.json({
      doc: {
        id: doc.id,
        title: doc.title,
        updated_at: doc.updated_at,
        ack_required: doc.ack_required,
        version: { version_id: version.version_id, rev: version.rev, reset_at: doc.ack_revision_at },
      },
      rows: ledger.map((r) => personalDataForViewer(r, canExport)),
      can: { export: canExport },
    });
  }

  const [rows, former, lastDecision, lastReset, kept, defaults] = await Promise.all([
    ackStatusForDocument(doc.id),
    ackFormerStaffRows(doc.id),
    lastAckDecision(doc.id),
    lastAckDecision(doc.id, { outcome: "reset" }),
    keptSinceLastReset(doc.id),
    resolvePolicyDefaults(doc.id),
  ]);
  const access = canExport ? await recordedAccess(doc.id) : null;
  const accessOfRow = (r: { id: number; acknowledged_at: string | null }): RecordedAccess | null =>
    r.acknowledged_at ? (access?.byUserAt.get(`${r.id}|${r.acknowledged_at}`) ?? null) : null;
  const accessOfFormer = (r: { id: number }): RecordedAccess | null => access?.byId.get(r.id) ?? null;

  if (format === "csv") {
    const provenance = await versionProvenance(doc.id);
    // The policy's sets (D3, 1.14.0): the last column, the same on every row.
    const setCell = esc(policySetCsvCell((await policySetNames([doc.id])).get(doc.id) ?? []));
    const asked = [
      esc(doc.ack_revision_at),
      esc(lastReset?.decided_by_name ?? ""),
      esc(lastReset?.reason ?? ""),
      esc(kept.count),
    ];
    // The policy's re-confirmation settings (G1) are the same on every row.
    const recert = recertCsvCells(doc).map(esc);
    const csv = [
      ROSTER_CSV_HEADER,
      ...rows.map((r) =>
        [
          esc(r.name),
          esc(r.username),
          esc(r.email),
          esc(r.role),
          esc(rosterStatus(r)),
          esc(r.acknowledged_at ?? ""),
          esc(doc.title),
          esc(doc.ack_revision_at),
          esc(r.rev ? `v${r.rev}` : ""),
          esc(r.version_id ?? ""),
          esc(r.content_sha256 ?? ""),
          esc(r.version_source ?? ""),
          esc(""),
          ...asked,
          ...personalDataCells(accessOfRow(r), canExport).map(esc),
          ...provenanceCells(provenance, r.version_id).map(esc),
          ...evidenceCsvCells(r).map(esc),
          ...attestationCsvCells(r).map(esc),
          ...recert,
          ...exemptionCsvCells(r).map(esc),
          setCell,
        ].join(",")
      ),
      ...former.map((r) =>
        [
          esc(r.name),
          esc(r.username),
          esc(r.email),
          esc(r.role),
          esc("acknowledged"),
          esc(r.acknowledged_at),
          esc(doc.title),
          esc(doc.ack_revision_at),
          esc(r.rev ? `v${r.rev}` : ""),
          esc(r.version_id ?? ""),
          esc(r.content_sha256 ?? ""),
          esc(r.version_source),
          esc(r.reason),
          ...asked,
          ...personalDataCells(accessOfFormer(r), canExport).map(esc),
          ...provenanceCells(provenance, r.version_id).map(esc),
          ...evidenceCsvCells(r).map(esc),
          ...attestationCsvCells(r).map(esc),
          ...recert,
          // No assignment row travels with a former staff member: five blanks.
          ...exemptionCsvCells({}).map(esc),
          setCell,
        ].join(",")
      ),
    ].join("\n");
    // On the record before the response streams (F6).
    await auditAck("ack.export", doc, {
      actor: actorFrom(user),
      ip: ipFrom(req),
      version_id: version.version_id,
      version: version.rev,
      details: { format: "roster", rows: rows.length + former.length, with_ip: canExport },
    });
    return csvResponse(csv, `acknowledgements-doc-${doc.id}.csv`);
  }
  return NextResponse.json({
    doc: {
      id: doc.id,
      title: doc.title,
      updated_at: doc.updated_at,
      ack_required: doc.ack_required,
      version: { version_id: version.version_id, rev: version.rev, reset_at: doc.ack_revision_at },
    },
    // The IP and user agent travel with the JSON row only for an exporter,
    // as in the CSV.
    rows: canExport ? rows.map((r) => ({ ...r, ...(accessOfRow(r) ?? { ip: "", user_agent: "" }) })) : rows,
    // The policy's resolved grace (E1): the roster's Overdue chip and filter.
    defaults: { overdue_grace_days: defaults.values.overdue_grace_days },
    former_staff: canExport
      ? former.map((r) => ({ ...r, ...(accessOfFormer(r) ?? { ip: "", user_agent: "" }) }))
      : former,
    // The decision ledger's headline (C1): who last asked everyone and why,
    // the newest decision of either outcome, and the drift kept since.
    decisions: {
      last: lastDecision,
      last_reset: lastReset,
      kept_since_reset: kept.count,
      drift_pct: kept.drift_pct,
    },
    can: { export: canExport },
  });
}
