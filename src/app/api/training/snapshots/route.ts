import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { listTrainingSnapshots } from "@/lib/db";
import { takeTrainingSnapshot } from "@/lib/training-audit";
import { audit, actorFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Point-in-time snapshots: list what's stored, or take one now. The monthly
// sweep adds one per calendar month on its own.
export async function GET() {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  return NextResponse.json({ snapshots: await listTrainingSnapshots() });
}

export async function POST() {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  const user = gate as SessionUser;
  const snap = await takeTrainingSnapshot("manual", "", user.name || user.username);
  if (!snap) {
    return NextResponse.json({ error: "Could not store the snapshot." }, { status: 500 });
  }
  await audit({
    actor: actorFrom(user),
    action: "training.snapshot",
    details: { snapshot_id: snap.id, sha256: snap.sha256 },
  });
  return NextResponse.json({ ok: true, id: snap.id, sha256: snap.sha256 });
}
