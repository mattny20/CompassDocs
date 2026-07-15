import { NextResponse } from "next/server";
import { approveChangeRequest, rejectChangeRequest, getChangeRequest, getDocument } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { notifyWebhooks } from "@/lib/webhooks";
import { requestOrigin } from "@/lib/oauth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("approver");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = body?.action;
  const note = String(body?.note ?? "").trim();
  // Snapshot the title/space before the decision mutates the row.
  const cr = await getChangeRequest(Number(id));
  const crDoc = cr ? await getDocument(cr.document_id) : undefined;

  if (action === "approve") {
    const ok = await approveChangeRequest(Number(id), user.id, user.name || user.username, note);
    if (!ok) return NextResponse.json({ error: "Already reviewed or not found." }, { status: 409 });
    await audit({
      actor: actorFrom(user),
      action: "change_request.approve",
      targetType: "change_request",
      targetId: id,
      ip: ipFrom(req),
    });
    void notifyWebhooks("change_request.approved", {
      title: cr?.title || `change request #${id}`,
      actor: user.name || user.username,
      note,
      url: `${requestOrigin(req)}/review`,
      spaceId: crDoc?.space_id,
      spaceName: crDoc?.space_name,
    });
    return NextResponse.json({ ok: true, result: "approved" });
  }
  if (action === "reject") {
    const ok = await rejectChangeRequest(Number(id), user.id, note);
    if (!ok) return NextResponse.json({ error: "Already reviewed or not found." }, { status: 409 });
    await audit({
      actor: actorFrom(user),
      action: "change_request.reject",
      targetType: "change_request",
      targetId: id,
      ip: ipFrom(req),
    });
    void notifyWebhooks("change_request.rejected", {
      title: cr?.title || `change request #${id}`,
      actor: user.name || user.username,
      note,
      url: `${requestOrigin(req)}/review`,
      spaceId: crDoc?.space_id,
      spaceName: crDoc?.space_name,
    });
    return NextResponse.json({ ok: true, result: "rejected" });
  }
  return NextResponse.json({ error: "action must be 'approve' or 'reject'." }, { status: 400 });
}
