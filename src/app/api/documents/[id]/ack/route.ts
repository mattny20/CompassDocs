import { NextResponse } from "next/server";
import { getDocument, recordAcknowledgement, getCurrentAck, setAckRequired } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { ackSummary } from "@/lib/db";
import { userHolds } from "@/lib/access";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET — the read-confirmation summary for a document (A3, 1.10.0): the
// counts, the marker's version, the edit default and the last decision, as
// `ackSummary` computes them for every surface (the editor's question, the
// merge/restore dialogs, the review card). It never names pending people.
// With ?baseline=1 it adds the text readers last confirmed, so the editor
// can measure the drift since then on the client. Anyone who may edit the
// document or read its roster may ask; apiGuard takes one permission, so the
// OR is written with userHolds.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const allowed =
    (await userHolds(user, "document.update", { spaceId: doc.space_id, legacyMin: "editor" })) ||
    (await userHolds(user, "document.ack_roster_read", { spaceId: doc.space_id, legacyMin: "approver" }));
  if (!allowed) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Read confirmations are not included in your license." },
      { status: 402 }
    );
  }

  const baseline = new URL(req.url).searchParams.get("baseline") === "1";
  const summary = await ackSummary(doc.id, { baseline });
  return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
}

// POST — the signed-in reader confirms they've read this document.
//
// Body: { version_id: number; reached_end?: boolean }. The reader declares the
// version they read; the row is recorded only when that is still the
// document's latest version and the marker has not moved past it (1.10.0).
// Otherwise 409 { stale: true } — the same shape as the editor's conflict —
// and the page reloads into what changed. The hash on the row comes from that
// version's text, never from the live document. `reached_end` is accepted and
// ignored for now (C3 is a later release).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer", "document.ack_submit");
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
  if (doc.status !== "published" || doc.ack_required !== 1) {
    return NextResponse.json({ error: "This document doesn't ask for a read confirmation." }, { status: 400 });
  }

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const versionId = Number(body?.version_id);
  if (body?.version_id === undefined || body?.version_id === null || !Number.isInteger(versionId)) {
    return NextResponse.json({ error: "version_id is required." }, { status: 400 });
  }

  const { recorded, stale } = await recordAcknowledgement(doc.id, user.id, ipFrom(req) ?? "", versionId);
  if (stale) {
    return NextResponse.json(
      { stale: true, error: "This document changed while you were reading it. Reload and read the changes." },
      { status: 409 }
    );
  }
  const ack = await getCurrentAck(doc.id, user.id);
  if (recorded) {
    // The attestation evidence (C1): the version and hash the row cites, and
    // the browser that sent it. signed_name / identity_proof arrive with C3.
    await auditAck("document.acknowledge", doc, {
      actor: actorFrom(user),
      ip: ipFrom(req),
      version_id: ack?.version_id ?? versionId,
      version: ack?.rev ?? null,
      content_sha256: ack?.content_sha256 ?? null,
      details: { user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300) },
    });
  }
  return NextResponse.json({
    ok: true,
    acknowledged_at: ack?.acknowledged_at ?? null,
    version_id: ack?.version_id ?? versionId,
    rev: ack?.rev ?? null,
  });
}

// PATCH — approver+ toggles whether the doc requires a read confirmation.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("approver", "document.ack_require");
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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body?.required !== "boolean") {
    return NextResponse.json({ error: "'required' must be a boolean." }, { status: 400 });
  }
  if (body.required && doc.status !== "published") {
    return NextResponse.json(
      { error: "Publish the document before requiring a read confirmation." },
      { status: 400 }
    );
  }
  // Counted before the flip, so "removed" says what standing the record had
  // at that moment (acked of required). Two literal calls, not a ternary, so
  // each key is greppable (C1).
  const summary = await ackSummary(doc.id);
  await setAckRequired(doc.id, body.required);
  if (body.required) {
    await auditAck("document.ack_required", doc, {
      actor: actorFrom(user),
      ip: ipFrom(req),
      version_id: summary.latest_version_id,
      version: summary.latest_rev,
      source: "manual",
      details: { required: summary.eligible },
    });
  } else {
    await auditAck("document.ack_removed", doc, {
      actor: actorFrom(user),
      ip: ipFrom(req),
      version_id: summary.version_id,
      version: summary.rev,
      source: "manual",
      details: { acked: summary.current, required: summary.eligible },
    });
  }
  return NextResponse.json({ ok: true, ack_required: body.required });
}
