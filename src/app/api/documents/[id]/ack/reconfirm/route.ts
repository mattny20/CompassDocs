import { NextResponse } from "next/server";
import { getDocument, claimReconfirmation, ACK_REASON_MIN } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, canSeeDrafts, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

/** A reason longer than this is cut, as PUT /api/documents/[id] cuts ack_reason. */
const REASON_MAX = 500;
/** The most people one per-person re-ask names (D4); the assignments endpoints keep the same cap. (Not exported: a route file may only export handlers.) */
const USER_IDS_MAX = 200;

/**
 * The per-person list as the body sends it: an array of positive integers,
 * duplicates collapsed, at least one and at most USER_IDS_MAX. The first
 * problem is named; a list that is not a list is refused rather than read
 * as "everyone", so a client bug never widens a re-ask.
 */
function parseUserIds(raw: unknown): { ok: true; ids: number[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0)) {
    return { ok: false, error: "user_ids must be a list of user ids." };
  }
  const ids = [...new Set(raw as number[])];
  if (ids.length === 0) return { ok: false, error: "Choose at least one person." };
  if (ids.length > USER_IDS_MAX) return { ok: false, error: `Ask up to ${USER_IDS_MAX} people at a time.` };
  return { ok: true, ids };
}

/** 400 when nobody named has an open row: they are exempt, removed, or not asked at all. */
function nobodyOpenError(n: number): string {
  return n === 1
    ? "This person isn't asked to confirm this document."
    : "None of these people are asked to confirm this document.";
}

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
// (404, so a hidden document stays hidden), the draft rule (404 for a draft
// the caller may not read, as GET /api/documents/[id] and the ack GET
// answer), document.ack_require on the space OR compliance.program_manage
// (apiGuard takes one permission, so the OR is written out), the licence
// (402), published and required (400), the reason (400), then the claim
// (429 inside the hour: "Readers were asked again 12 minutes ago.", the
// same hour the portal's Remind keeps).
//
// `user_ids` is the per-person re-ask (D4, 1.13.0): the same guards and the
// same reason rule, but the document marker stays where it is. One
// statement restarts the named people's confirmation cycle
// (policy_assignments.cycle_started_at, with a fresh deadline and cleared
// reminder stamps), so their confirmation lapses and nobody else's does; the
// ledger gets one 'reset' row of scope 'users' and only those people are
// notified. People named who are exempt, removed or not assigned are
// skipped and listed in the answer; when nobody named has an open row the
// answer is 400 and nothing is written. No hour guard and no Remind stamp:
// asking one person again blocks nothing. The list takes up to
// USER_IDS_MAX positive integers (duplicates collapse).
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
  let userIds: number[] | null = null;
  if (body?.user_ids !== undefined && body?.user_ids !== null) {
    const parsed = parseUserIds(body.user_ids);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    userIds = parsed.ids;
  }

  const claim = await claimReconfirmation(null, doc.id, {
    source: "manual",
    reason,
    userIds,
    // The outbox row's actor: the same name the audit row carries.
    actor: { id: user.id, name: user.name || user.username },
    // And the request's origin, so the notice's links are absolute on a
    // workspace without custom_domain.
    origin: requestOrigin(req),
  });
  if (!claim.claimed) {
    if (claim.skipped) {
      // A per-person list in which nobody has an open row: nothing was written.
      return NextResponse.json({ error: nobodyOpenError(claim.skipped.length), skipped: claim.skipped }, { status: 400 });
    }
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
  // notices have gone out. A per-person ask (D4) carries the people whose
  // cycle restarted and the ids it skipped; a whole-audience ask writes
  // user_ids null so an export always has the column.
  const personal = claim.scope === "users";
  await auditAck("ack.reconfirmation_requested", doc, {
    actor: actorFrom(user),
    ip: ipFrom(req),
    version_id: claim.version_id,
    version: claim.rev,
    source: "manual",
    reason,
    details: {
      scope: claim.scope,
      reset: claim.confirmations_reset,
      eligible: claim.eligible,
      queued: personal ? claim.user_ids.length : claim.eligible,
      user_ids: personal ? claim.user_ids : null,
      skipped: personal ? claim.skipped : null,
      decision_id: claim.decision_id,
      outbox_id: claim.outbox_id,
    },
  });
  if (personal) {
    // The people re-asked are the people notified; the rest of the list had
    // no open row (exempt, removed, never assigned) and is reported as such.
    return NextResponse.json({
      ok: true,
      reset: claim.confirmations_reset,
      queued: claim.user_ids.length,
      user_ids: claim.user_ids,
      skipped: claim.skipped,
    });
  }
  // `queued` is everyone pending now, which after the reset is the whole
  // audience; the drain resolves the list again at delivery.
  return NextResponse.json({ ok: true, reset: claim.confirmations_reset, queued: claim.eligible });
}
