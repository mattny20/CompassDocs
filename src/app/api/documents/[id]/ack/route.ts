import { NextResponse } from "next/server";
import { getDocument, recordAcknowledgement, getCurrentAck, setAckRequired } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { roleAtLeast } from "@/lib/types";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// POST — the signed-in reader confirms they've read this document.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Policy acknowledgements are not included in your license." },
      { status: 402 }
    );
  }

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (doc.status !== "published" || doc.ack_required !== 1) {
    return NextResponse.json({ error: "This document doesn't require acknowledgement." }, { status: 400 });
  }

  const { recorded } = await recordAcknowledgement(doc.id, user.id, ipFrom(req) ?? "");
  if (recorded) {
    await audit({
      actor: actorFrom(user),
      action: "document.acknowledge",
      targetType: "document",
      targetId: doc.id,
      targetLabel: doc.title,
      ip: ipFrom(req),
    });
  }
  const ack = await getCurrentAck(doc.id, user.id);
  return NextResponse.json({ ok: true, acknowledged_at: ack?.acknowledged_at ?? null });
}

// PATCH — approver+ toggles whether the doc requires acknowledgement.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("approver");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Policy acknowledgements are not included in your license." },
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
      { error: "Publish the document before requiring acknowledgement." },
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
