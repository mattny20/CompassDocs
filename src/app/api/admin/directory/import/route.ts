// CSV import: analyse a file (columns and suggested targets), plan it
// (what every row would do), or apply it. One endpoint, three modes.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listFields } from "@/lib/directory";
import { analyzeCsv, importCsv } from "@/lib/directory-import";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

const MAX_CHARS = 4 * 1024 * 1024;

export async function POST(req: Request) {
  const gate = await apiGuard("admin", "directory.person_manage");
  if (gate instanceof NextResponse) return gate;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const csv = typeof body?.csv === "string" ? body.csv : "";
  if (!csv.trim()) return NextResponse.json({ error: "Paste or upload a CSV first." }, { status: 400 });
  if (csv.length > MAX_CHARS) return NextResponse.json({ error: "That file is over 4 MB." }, { status: 413 });
  const mode = body?.mode === "apply" ? "apply" : body?.mode === "plan" ? "plan" : "analyze";

  if (mode === "analyze") {
    return NextResponse.json(analyzeCsv(csv, await listFields()));
  }
  const mapping: Record<string, string> = {};
  if (body?.mapping && typeof body.mapping === "object") {
    for (const [k, v] of Object.entries(body.mapping as Record<string, unknown>)) mapping[k] = String(v ?? "");
  }
  const plan = await importCsv(csv, mapping, { apply: mode === "apply" });
  if (mode === "apply") {
    await audit({
      actor: actorFrom(gate),
      action: "directory.imported",
      details: plan.counts,
      ip: ipFrom(req),
    });
  }
  return NextResponse.json(plan);
}
