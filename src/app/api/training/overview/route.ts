import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { trainingOverview, trainingOrgRows, listTrainingDecks } from "@/lib/db";

export const dynamic = "force-dynamic";

// Org-wide training rollup: KPIs, per-deck stats, overdue list, and a
// whole-program CSV for auditors.
export async function GET(req: Request) {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }

  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    const rows = await trainingOrgRows();
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      "training,name,username,email,assigned_at,due_at,completed_at,confirmed_version,quiz_score,quiz_total,prior_completions,status",
    ];
    for (const r of rows) {
      const status = r.completed_at ? (r.source === "waived" ? "waived" : "completed") : "open";
      lines.push(
        [r.deck, r.name, r.username, r.email, r.assigned_at, r.due_at ?? "", r.completed_at ?? "", r.confirmed_version ?? "", r.quiz_score ?? "", r.quiz_total ?? "", r.prior_completions, status]
          .map(esc)
          .join(",")
      );
    }
    return new Response(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="training-all.csv"`,
      },
    });
  }

  const [overview, decks] = await Promise.all([trainingOverview(), listTrainingDecks()]);
  return NextResponse.json({ overview, decks });
}
