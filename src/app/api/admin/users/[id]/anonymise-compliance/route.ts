import { NextResponse } from "next/server";
import { getUserById, anonymiseComplianceRecord } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// POST — the erasure path for a person's attestation records (C5). Replaces
// their name, email and IP on every confirmation and decision with "Former
// staff #id"; counts, dates, versions and hashes stay. Irreversible, so the
// UI asks with a typed confirmation. Needs both the account-deletion right
// and the compliance program right: neither alone should be able to rewrite
// evidence. Licence-gated like every other read-confirmation endpoint, so
// the API and the Users page (which hides the button unlicensed) agree.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "user.delete");
  if (gate instanceof NextResponse) return gate;
  const admin = gate as SessionUser;

  const { grantsFor, admits, legacyAuthzEnforcement } = await import("@/lib/authz");
  if (!legacyAuthzEnforcement() && !admits(await grantsFor(admin.id), "compliance.program_manage")) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Read confirmations are not included in your license." },
      { status: 402 }
    );
  }

  const { id } = await params;
  const target = await getUserById(Number(id));
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (target.id === admin.id) {
    return NextResponse.json({ error: "You can't anonymise your own compliance record." }, { status: 400 });
  }

  const { rows, snapshots_rewritten } = await anonymiseComplianceRecord(target.id);
  await audit({
    actor: actorFrom(admin),
    action: "ack.anonymised",
    targetType: "user",
    targetId: target.id,
    targetLabel: target.username,
    // Stored snapshots that named the person are re-serialised with a new
    // hash (F2, later), so their original hashes no longer verify.
    details: { user_id: target.id, rows, snapshots_rewritten },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, rows, snapshots_rewritten });
}
