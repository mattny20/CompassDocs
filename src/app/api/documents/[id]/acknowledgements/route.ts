import { NextResponse } from "next/server";
import {
  pool,
  getDocument,
  ackStatusForDocument,
  ackFormerStaffRows,
  getAckVersionInfo,
  lastAckDecision,
  keptSinceLastReset,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, canSeeDrafts, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";
import { versionProvenance, provenanceCells } from "@/lib/version-provenance";
import { csvCell } from "@/lib/csv";
import { ROSTER_CSV_HEADER, evidenceCsvCells } from "@/lib/read-evidence";

export const dynamic = "force-dynamic";

// The attestation record: who has (and hasn't) confirmed the version everyone
// is asked to confirm. Approver+; ?format=csv downloads it.
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
// compliance.export. The space-scoped document.ack_roster_read gate stays:
// version, hash and signed-name columns are the verification handles a
// steward hands an auditor; the IP is personal data and belongs to exporters.
// user_agent is reserved: the record does not store it yet (the audit row
// for the confirmation does), so the column is blank for everyone. After
// them, version_published_by and version_approved_by (C6): who published and
// approved the version each row cites. After those (1.11.0, C3) the reading
// evidence: read_seconds (how long the document was open on screen for the
// person since everyone was last asked, summed on the server when they
// confirmed; blank when unknown) and reached_end_self_reported (yes / no on
// a confirmed row, from the card's own report; blank while pending). The
// header lives in src/lib/read-evidence.ts beside the cell rule. Every cell
// goes through csvCell (quotes doubled, a formula-leading value prefixed with
// a quote), so a name or a note that starts with = never runs when the sheet
// opens.
//
// Guards: apiGuard admits a holder of the space-scoped key anywhere, so the
// key is checked again on the document's own space (403); a draft the
// caller may not read is 404, as GET /api/documents/[id] and the ack GET
// answer, because an unpublished policy keeps its title, rows and reasons.

/**
 * The IP recorded on each confirmation the roster cites, keyed so the match
 * is exact and the currency rule stays in one place (db.ts): the live roster
 * row by (user id, acknowledged_at), the former-staff row by its own id.
 * Timestamps come back as normalised ISO strings on both sides.
 */
async function recordedIps(docId: number): Promise<{ byUserAt: Map<string, string>; byId: Map<number, string> }> {
  const r = await pool().query<{ id: number; user_id: number | null; acknowledged_at: string; ip: string }>(
    `SELECT id, user_id, acknowledged_at, ip FROM acknowledgements WHERE document_id = $1 AND ip <> ''`,
    [docId]
  );
  const byUserAt = new Map<string, string>();
  const byId = new Map<number, string>();
  for (const row of r.rows) {
    byId.set(row.id, row.ip);
    if (row.user_id != null) byUserAt.set(`${row.user_id}|${row.acknowledged_at}`, row.ip);
  }
  return { byUserAt, byId };
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

  const [rows, former, version, lastDecision, lastReset, kept, canExport] = await Promise.all([
    ackStatusForDocument(doc.id),
    ackFormerStaffRows(doc.id),
    getAckVersionInfo(doc.id),
    lastAckDecision(doc.id),
    lastAckDecision(doc.id, { outcome: "reset" }),
    keptSinceLastReset(doc.id),
    userHolds(user, "compliance.export", { legacyMin: "admin" }),
  ]);
  const ips = canExport ? await recordedIps(doc.id) : null;
  const ipOfRow = (r: { id: number; acknowledged_at: string | null }) =>
    r.acknowledged_at ? (ips?.byUserAt.get(`${r.id}|${r.acknowledged_at}`) ?? "") : "";
  const ipOfFormer = (r: { id: number }) => ips?.byId.get(r.id) ?? "";

  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    const esc = csvCell;
    const provenance = await versionProvenance(doc.id);
    const asked = [
      esc(doc.ack_revision_at),
      esc(lastReset?.decided_by_name ?? ""),
      esc(lastReset?.reason ?? ""),
      esc(kept.count),
    ];
    const csv = [
      ROSTER_CSV_HEADER,
      ...rows.map((r) =>
        [
          esc(r.name),
          esc(r.username),
          esc(r.email),
          esc(r.role),
          esc(r.acknowledged_at ? "acknowledged" : "pending"),
          esc(r.acknowledged_at ?? ""),
          esc(doc.title),
          esc(doc.ack_revision_at),
          esc(r.rev ? `v${r.rev}` : ""),
          esc(r.version_id ?? ""),
          esc(r.content_sha256 ?? ""),
          esc(r.version_source ?? ""),
          esc(""),
          ...asked,
          esc(ipOfRow(r)),
          esc(""),
          ...provenanceCells(provenance, r.version_id).map(esc),
          ...evidenceCsvCells(r).map(esc),
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
          esc(ipOfFormer(r)),
          esc(""),
          ...provenanceCells(provenance, r.version_id).map(esc),
          ...evidenceCsvCells(r).map(esc),
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
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="acknowledgements-doc-${doc.id}.csv"`,
      },
    });
  }
  return NextResponse.json({
    doc: {
      id: doc.id,
      title: doc.title,
      updated_at: doc.updated_at,
      ack_required: doc.ack_required,
      version: { version_id: version.version_id, rev: version.rev, reset_at: doc.ack_revision_at },
    },
    // The IP travels with the JSON row only for an exporter, as in the CSV.
    rows: canExport ? rows.map((r) => ({ ...r, ip: ipOfRow(r) })) : rows,
    former_staff: canExport ? former.map((r) => ({ ...r, ip: ipOfFormer(r) })) : former,
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
