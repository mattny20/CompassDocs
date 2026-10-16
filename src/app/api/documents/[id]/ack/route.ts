import { NextResponse } from "next/server";
import { getDocument, recordAcknowledgement, getCurrentAck, setAckRequired } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

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
    await audit({
      actor: actorFrom(user),
      action: "document.acknowledge",
      targetType: "document",
      targetId: doc.id,
      targetLabel: doc.title,
      details: { version_id: versionId, rev: ack?.rev ?? null, content_sha256: ack?.content_sha256 ?? null },
      ip: ipFrom(req),
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
  await setAckRequired(doc.id, body.required);
  await audit({
    actor: actorFrom(user),
    action: body.required ? "document.ack_required" : "document.ack_removed",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, ack_required: body.required });
}
