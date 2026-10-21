import { NextResponse } from "next/server";
import { complianceGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { buildCompliancePackage } from "@/lib/compliance-audit";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// The one-click audit package (F2, 1.14.0): a ZIP of everything an auditor
// asks for, streamed (the ledger is written from a cursor in pages and never
// built in memory), with a hash manifest last. compliance.export, as every
// export of personal data. The audit row is written once the stream has
// closed, with the size that actually went out and the policies covered.

export async function GET(req: Request) {
  const gate = await complianceGuard("compliance.export");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 });
  }
  const user = gate;
  const actor = actorFrom(user);
  const ip = ipFrom(req);
  const pkg = await buildCompliancePackage({ by: user.name || user.username });
  pkg.done
    .then(({ bytes, policies }) =>
      audit({
        actor,
        action: "ack.audit_export",
        targetType: "compliance",
        targetId: null,
        targetLabel: "All policies",
        details: { format: "package", scope: "all", bytes, policies },
        ip,
      })
    )
    .catch((e) => console.error("[ack] audit package:", e));
  return new Response(pkg.stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${pkg.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
