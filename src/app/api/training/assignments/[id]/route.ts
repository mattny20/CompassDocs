import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { getMyTrainingAssignment, setTrainingProgress, completeTraining } from "@/lib/db";
import { audit, actorFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Progress + completion for the signed-in assignee. The assignment itself is
// the access grant: training must be completable even when the deck's doc
// lives in a space the assignee can't browse.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json({ error: "Training is not included in your license." }, { status: 402 });
  }

  const { id } = await params;
  const assignment = await getMyTrainingAssignment(Number(id), user.id);
  if (!assignment) {
    return NextResponse.json({ error: "No such training assignment." }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string; slide?: number };
  if (body.action === "progress") {
    await setTrainingProgress(assignment.assignment_id, user.id, Number(body.slide) || 0);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "confirm") {
    const done = await completeTraining(assignment.assignment_id, user.id);
    if (!done) return NextResponse.json({ ok: true, already: true });
    await audit({
      actor: actorFrom(user),
      action: "training.completed",
      targetType: "document",
      targetId: assignment.document_id,
      targetLabel: assignment.title,
      details: { confirmed_version: done.confirmed_version },
    });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "action must be progress or confirm." }, { status: 400 });
}
