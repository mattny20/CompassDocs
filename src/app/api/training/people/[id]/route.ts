import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { getUserById, userTrainingTranscript } from "@/lib/db";

export const dynamic = "force-dynamic";

// One person's full training record (live assignments + closed cycles) —
// what an auditor asks for when they sample an employee. JSON or CSV.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  const { id } = await params;
  const person = await getUserById(Number(id));
  if (!person) return NextResponse.json({ error: "No such person." }, { status: 404 });
  const transcript = await userTrainingTranscript(person.id);

  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      "record,training,assigned_at,due_at,completed_at,confirmed_version,quiz_score,quiz_total,status",
    ];
    for (const r of transcript.current) {
      const status = r.completed_at ? (r.source === "waived" ? "waived" : "completed") : "open";
      lines.push(
        ["current", r.deck, r.assigned_at, r.due_at ?? "", r.completed_at ?? "", r.confirmed_version ?? "", r.quiz_score ?? "", r.quiz_total ?? "", status]
          .map(esc)
          .join(",")
      );
    }
    for (const h of transcript.history) {
      const status = h.completed_at ? (h.source === "waived" ? "waived" : "completed") : "open";
      lines.push(
        ["history", h.deck_title, h.assigned_at, "", h.completed_at ?? "", h.confirmed_version ?? "", h.quiz_score ?? "", h.quiz_total ?? "", status]
          .map(esc)
          .join(",")
      );
    }
    return new Response(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="training-${person.username}.csv"`,
      },
    });
  }

  return NextResponse.json({
    person: { id: person.id, name: person.name, username: person.username },
    ...transcript,
  });
}
