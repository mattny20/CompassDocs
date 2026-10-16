import { NextResponse } from "next/server";
import {
  getDocument,
  ackStatusForDocument,
  ackFormerStaffRows,
  getAckVersionInfo,
  lastAckDecision,
  keptSinceLastReset,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The attestation record: who has (and hasn't) confirmed the version everyone
// is asked to confirm. Approver+; ?format=csv downloads it.
//
// CSV columns (existing ones stay in place, new ones are appended — never
// rename): name,username,email,role,status,acknowledged_at,document,
// revision_as_of (the marker date since 1.10.0; was updated_at),
// version ("v12"), version_id, content_sha256, version_source
// (recorded | inferred), former_staff (left | disabled | empty), and from
// the decision ledger (C1) asked_at (the marker date), asked_by, reason (who
// last asked everyone and why; empty when the marker predates the ledger)
// and kept_since_asked (edits kept without re-asking since then).
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

  const [rows, former, version, lastDecision, lastReset, kept] = await Promise.all([
    ackStatusForDocument(doc.id),
    ackFormerStaffRows(doc.id),
    getAckVersionInfo(doc.id),
    lastAckDecision(doc.id),
    lastAckDecision(doc.id, { outcome: "reset" }),
    keptSinceLastReset(doc.id),
  ]);
  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const asked = [
      doc.ack_revision_at,
      esc(lastReset?.decided_by_name ?? ""),
      esc(lastReset?.reason ?? ""),
      kept.count,
    ];
    const csv = [
      "name,username,email,role,status,acknowledged_at,document,revision_as_of,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked",
      ...rows.map((r) =>
        [
          esc(r.name),
          esc(r.username),
          esc(r.email),
          r.role,
          r.acknowledged_at ? "acknowledged" : "pending",
          r.acknowledged_at ?? "",
          esc(doc.title),
          doc.ack_revision_at,
          r.rev ? `v${r.rev}` : "",
          r.version_id ?? "",
          r.content_sha256 ?? "",
          r.version_source ?? "",
          "",
          ...asked,
        ].join(",")
      ),
      ...former.map((r) =>
        [
          esc(r.name),
          esc(r.username),
          esc(r.email),
          r.role,
          "acknowledged",
          r.acknowledged_at,
          esc(doc.title),
          doc.ack_revision_at,
          r.rev ? `v${r.rev}` : "",
          r.version_id ?? "",
          r.content_sha256 ?? "",
          r.version_source,
          r.reason,
          ...asked,
        ].join(",")
      ),
    ].join("\n");
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
    rows,
    former_staff: former,
    // The decision ledger's headline (C1): who last asked everyone and why,
    // the newest decision of either outcome, and the drift kept since.
    decisions: {
      last: lastDecision,
      last_reset: lastReset,
      kept_since_reset: kept.count,
      drift_pct: kept.drift_pct,
    },
  });
}
