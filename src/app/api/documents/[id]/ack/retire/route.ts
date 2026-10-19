import { NextResponse } from "next/server";
import { getDocument, retirePolicy, ACK_REASON_MIN } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, canSeeDrafts, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

/** A reason longer than this is cut, as the re-ask and PUT /api/documents/[id] cut theirs. */
const REASON_MAX = 500;

// POST { reason }: retire a policy (G3, 1.12.0). One UPDATE in lib/db
// (retirePolicy) switches the requirement off and stamps who, when and why,
// guarded on the policy not being retired already; the marker stays where
// it is so the final roster is reproducible from the ledger; the policy's
// queued notices are cancelled and the 'retired' ledger row is written
// with the counts frozen at that moment, all in one transaction. The
// document itself is untouched: unpublish it separately if people should
// no longer read it.
//
// Guards, in order (A7's shape): session and CSRF (apiGuard), the viewer's
// space scope (404, so a hidden document stays hidden), the draft rule
// (404 for a draft the caller may not read), the licence (402),
// document.ack_require on the space OR compliance.program_manage (403;
// apiGuard takes one permission, so the OR is written out), already
// retired (409), not a policy (400), the reason (400).
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
  if (doc.ack_retired_at) {
    return NextResponse.json({ error: "This policy is already retired." }, { status: 409 });
  }
  if (doc.ack_required !== 1) {
    return NextResponse.json({ error: "This document doesn't ask for a read confirmation." }, { status: 400 });
  }

  let body: { reason?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const reason = (typeof body?.reason === "string" ? body.reason : "").trim().slice(0, REASON_MAX);
  if (reason.length < ACK_REASON_MIN) {
    return NextResponse.json(
      { error: `A reason of at least ${ACK_REASON_MIN} characters is required.` },
      { status: 400 }
    );
  }

  const result = await retirePolicy(doc.id, { id: user.id, name: user.name || user.username }, reason);
  if (!result) {
    // Retired between the check above and the claim (another tab, another manager).
    return NextResponse.json({ error: "This policy is already retired." }, { status: 409 });
  }

  // The ledger row is the record; this is its echo with the frozen counts,
  // the version people had been asked to confirm and the replacement.
  await auditAck("ack.retired", doc, {
    actor: actorFrom(user),
    ip: ipFrom(req),
    version_id: result.version_id,
    version: result.rev,
    source: "manual",
    reason,
    details: {
      superseded_by: result.superseded_by,
      acked: result.acked,
      required: result.required,
      decision_id: result.decision_id,
      cancelled: result.cancelled,
    },
  });
  return NextResponse.json({ ok: true, acked: result.acked, required: result.required, rev: result.rev });
}
