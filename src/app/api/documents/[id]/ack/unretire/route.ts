import { NextResponse } from "next/server";
import { getDocument, unretirePolicy } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, canSeeDrafts, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// POST: resume a retired policy (G3, 1.12.0). lib/db's unretirePolicy
// clears the retirement columns and switches the requirement back on; the
// marker is untouched, so confirmations made before it was retired are
// current again unless the text changed meanwhile (a save with the
// requirement off advances the marker silently, so those people are asked
// again). An unpublished document resumes as Paused (G2). No ledger row:
// nothing was asked of anyone; the audit entry carries the standing.
//
// The same guards as POST /ack/retire, then 409 when the policy is not
// retired. Answers { ok, current, eligible }: the confirmations that count
// now, of the audience now, for the toast "Policy resumed: 42 of 50
// confirmations still current".
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Read confirmations are not included in your license." },
      { status: 402 }
    );
  }
  const allowed =
    (await userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" })) ||
    (await userHolds(user, "compliance.program_manage", { legacyMin: "admin" }));
  if (!allowed) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  if (!doc.ack_retired_at) {
    return NextResponse.json({ error: "This policy is not retired." }, { status: 409 });
  }

  const result = await unretirePolicy(doc.id);
  if (!result) {
    // Resumed between the check above and the update (another tab, another manager).
    return NextResponse.json({ error: "This policy is not retired." }, { status: 409 });
  }

  await auditAck("ack.unretired", doc, {
    actor: actorFrom(user),
    ip: ipFrom(req),
    version_id: doc.ack_version_id,
    source: "manual",
    details: { current: result.current, eligible: result.eligible },
  });
  return NextResponse.json({ ok: true, current: result.current, eligible: result.eligible });
}
