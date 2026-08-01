import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { getTrainingSnapshot } from "@/lib/db";

export const dynamic = "force-dynamic";

// Download one snapshot — the exact canonical text the SHA-256 was computed
// over, so `sha256sum` on the file reproduces the stored hash.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  const { id } = await params;
  const snap = await getTrainingSnapshot(Number(id));
  if (!snap) {
    return NextResponse.json({ error: "No such snapshot." }, { status: 404 });
  }
  const label = snap.kind === "monthly" ? snap.period : `manual-${snap.id}`;
  return new Response(snap.data, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="training-snapshot-${label}.json"`,
      "X-Content-SHA256": snap.sha256,
    },
  });
}
