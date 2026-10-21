import { NextResponse } from "next/server";
import { complianceGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { getComplianceSnapshot, verifyComplianceSnapshot, snapshotFileLabel } from "@/lib/compliance-audit";

export const dynamic = "force-dynamic";

// One snapshot (F2, 1.14.0), for compliance.export holders. The download is
// the exact canonical text the SHA-256 was computed over, with the hash in
// X-Content-SHA256, so `sha256sum` on the file reproduces it; `?verify=1`
// recomputes the hash over the stored text instead and answers whether it
// still matches ({ ok, stored, computed }).

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await complianceGuard("compliance.export");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 });
  }
  const { id } = await params;
  const snapshotId = Number(id);
  if (!Number.isInteger(snapshotId) || snapshotId <= 0) {
    return NextResponse.json({ error: "No such snapshot." }, { status: 404 });
  }
  const url = new URL(req.url);
  if (url.searchParams.get("verify") === "1") {
    const result = await verifyComplianceSnapshot(snapshotId);
    if (!result) return NextResponse.json({ error: "No such snapshot." }, { status: 404 });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  }
  const snap = await getComplianceSnapshot(snapshotId);
  if (!snap) return NextResponse.json({ error: "No such snapshot." }, { status: 404 });
  return new Response(snap.data, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="compliance-snapshot-${snapshotFileLabel(snap)}.json"`,
      "X-Content-SHA256": snap.sha256,
      "Cache-Control": "no-store",
    },
  });
}
