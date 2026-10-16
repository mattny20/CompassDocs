import { NextResponse } from "next/server";
import { getDocument, claimReconfirmation, ACK_REASON_MIN } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

/** A reason longer than this is cut, as PUT /api/documents/[id] cuts ack_reason. */
const REASON_MAX = 500;

// POST { reason, user_ids? }: ask everyone to re-confirm without an edit
// (A7, 1.10.1). The whole reset is one atomic claim in lib/db
// (claimReconfirmation): a single UPDATE moves the confirmation marker to the
// newest version and stamps the reminder cooldown, with the one-hour guard in
// its WHERE, so two managers, two tabs or two instances cannot double-reset;
// the 'reset' decision row (source 'manual', the reason, the confirmations
// counted before the marker moved) and the immediate 'updated' notice are
// written in the same transaction. No version row: the text did not change.
// Prior confirmations stay in the ledger.
//
// Guards, in order: session and CSRF (apiGuard), the viewer's space scope
// (404, so a hidden document stays hidden), document.ack_require on the
// space OR compliance.program_manage (apiGuard takes one permission, so the
// OR is written out), the licence (402), published and required (400), the
// reason (400), then the claim (429 inside the hour: "Readers were asked
// again 12 minutes ago.", the same hour the portal's Remind keeps).
//
// `user_ids` is the per-person re-ask (D4): the route accepts the key now
// and answers 400 until audiences ship, so a client built against D4 gets a
// sentence rather than a whole-audience reset it did not ask for.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const allowed =
    (await userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" })) ||
    (await userHolds(user, "compliance.program_manage", { legacyMin: "admin" }));
  if (!allowed) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Read confirmations are not included in your license." },
      { status: 402 }
    );
  }
  if (doc.status !== "published" || doc.ack_required !== 1) {
    return NextResponse.json({ error: "This document doesn't ask for a read confirmation." }, { status: 400 });
  }

  let body: { reason?: unknown; user_ids?: unknown } | null = null;
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
  if (body?.user_ids !== undefined && body?.user_ids !== null) {
    return NextResponse.json({ error: "Per-person re-asks arrive with audiences." }, { status: 400 });
  }

  const claim = await claimReconfirmation(null, doc.id, {
    source: "manual",
    reason,
    // The outbox row's actor: the same name the audit row carries.
    actor: { id: user.id, name: user.name || user.username },
  });
  if (!claim.claimed) {
    if (!claim.last_asked_at) {
      // The document stopped taking confirmations between the check above
      // and the claim (unpublished, trashed, switched off).
      return NextResponse.json({ error: "This document doesn't ask for a read confirmation." }, { status: 400 });
    }
    const minutes = Math.max(1, Math.round((Date.now() - new Date(claim.last_asked_at).getTime()) / 60_000));
    return NextResponse.json(
      { error: `Readers were asked again ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago.` },
      { status: 429 }
    );
  }

  // The ledger row is the record; this is its echo with the same version,
  // count and reason (C1). The drain writes ack.reset_notified once the
  // notices have gone out.
  await auditAck("ack.reconfirmation_requested", doc, {
    actor: actorFrom(user),
    ip: ipFrom(req),
    version_id: claim.version_id,
    version: claim.rev,
    source: "manual",
    reason,
    details: {
      reset: claim.confirmations_reset,
      eligible: claim.eligible,
      queued: claim.eligible,
      decision_id: claim.decision_id,
      outbox_id: claim.outbox_id,
    },
  });
  // `queued` is everyone pending now, which after the reset is the whole
  // audience; the drain resolves the list again at delivery.
  return NextResponse.json({ ok: true, reset: claim.confirmations_reset, queued: claim.eligible });
}
