import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { buildTrainingMatrix, matrixCsv } from "@/lib/training-audit";

export const dynamic = "force-dynamic";

// The compliance matrix: people × decks, one status per cell (JSON, or CSV
// with ?format=csv). Managers only.
export async function GET(req: Request) {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  const matrix = await buildTrainingMatrix();
  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    return new Response(matrixCsv(matrix), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="training-matrix.csv"`,
      },
    });
  }
  return NextResponse.json(matrix);
}
