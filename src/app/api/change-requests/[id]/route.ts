import { NextResponse } from "next/server";
import { approveChangeRequest, rejectChangeRequest } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
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
    return NextResponse.json({ ok: true, result: "rejected" });
  }
  return NextResponse.json({ error: "action must be 'approve' or 'reject'." }, { status: 400 });
}
