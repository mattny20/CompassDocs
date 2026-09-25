import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listPeople, listLinkRows, createPerson } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readPersonBody } from "./body";

export const dynamic = "force-dynamic";

/**
 * Admin view: all directory entries, including hidden ones, plus the raw link
 * rows so the editor can tell a manual link from a synced one (the display
 * aggregates on each person merge both and drop hidden targets).
 */
export async function GET() {
  const gate = await apiGuard("admin", "directory.person_manage");
  if (gate instanceof NextResponse) return gate;
  const [people, links] = await Promise.all([listPeople({ includeHidden: true }), listLinkRows()]);
  return NextResponse.json({ people, links });
}

/** Add a manual directory entry. */
export async function POST(req: Request) {
  const gate = await apiGuard("admin", "directory.person_manage");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const name = String(body?.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Name is required." }, { status: 400 });

  const person = await createPerson({ name, ...readPersonBody(body, "manual") });
  await audit({
    actor: actorFrom(gate),
    action: "directory.person_added",
    targetType: "directory_person",
    targetId: String(person.id),
    targetLabel: person.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ person }, { status: 201 });
}
