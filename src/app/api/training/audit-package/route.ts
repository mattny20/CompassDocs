import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { buildAuditPackage } from "@/lib/training-audit";
import { audit, actorFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// One-click audit package: a ZIP with summary, matrix, assignment + history
// CSVs, every stored snapshot, and a manifest of SHA-256 file hashes.
export async function GET() {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  const user = gate as SessionUser;
  const zip = await buildAuditPackage();
  await audit({
    actor: actorFrom(user),
    action: "training.audit_export",
    details: { bytes: zip.length },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="training-audit-${stamp}.zip"`,
    },
  });
}
