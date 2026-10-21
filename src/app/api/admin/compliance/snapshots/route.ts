import { NextResponse } from "next/server";
import { complianceGuard, type ComplianceKey } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { listComplianceSnapshots, takeComplianceSnapshot } from "@/lib/compliance-audit";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Point-in-time snapshots of the read confirmation programme (F2, 1.14.0):
// list what is stored (compliance.export: the hashes are evidence handles),
// or take one now (compliance.program_manage). The orchestrator adds one per
// calendar month on its own, and a retire writes one for the policy.

async function gated(key: ComplianceKey): Promise<{ denied: NextResponse } | { user: SessionUser }> {
  const gate = await complianceGuard(key);
  if (gate instanceof NextResponse) return { denied: gate };
  if (!(await featureEnabled("policy_ack"))) {
    return {
      denied: NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 }),
    };
  }
  return { user: gate };
}

/** GET → { rows: [{ id, taken_at, kind, period, document_id, document_title, taken_by_name, sha256 }] }, newest first (100 at most). */
export async function GET() {
  const gate = await gated("compliance.export");
  if ("denied" in gate) return gate.denied;
  const rows = (await listComplianceSnapshots(100)).map((s) => ({
    id: s.id,
    taken_at: s.taken_at,
    kind: s.kind,
    period: s.period,
    document_id: s.document_id,
    document_title: s.document_title,
    taken_by_name: s.taken_by_name,
    sha256: s.sha256,
  }));
  return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
}

/** POST → takes a manual snapshot now → { ok, id, sha256 }; audited as ack.snapshot. */
export async function POST(req: Request) {
  const gate = await gated("compliance.program_manage");
  if ("denied" in gate) return gate.denied;
  const { user } = gate;
  const by = { id: user.id, name: user.name || user.username };
  const snap = await takeComplianceSnapshot("manual", { by });
  if (!snap) {
    return NextResponse.json({ error: "Could not store the snapshot." }, { status: 500 });
  }
  await audit({
    actor: actorFrom(user),
    action: "ack.snapshot",
    targetType: "compliance",
    targetId: snap.id,
    targetLabel: `Snapshot #${snap.id}`,
    details: { snapshot_id: snap.id, kind: "manual", sha256: snap.sha256 },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, id: snap.id, sha256: snap.sha256 });
}
