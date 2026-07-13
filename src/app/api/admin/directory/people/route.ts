import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listPeople, createPerson } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Admin view: all directory entries, including hidden ones. */
export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ people: await listPeople({ includeHidden: true }) });
}

/** Add a manual directory entry. */
export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const name = String(body?.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Name is required." }, { status: 400 });

  const person = await createPerson({
    name,
    title: String(body?.title ?? ""),
    department: String(body?.department ?? ""),
    email: String(body?.email ?? ""),
    phone: String(body?.phone ?? ""),
    mobile: String(body?.mobile ?? ""),
    office: String(body?.office ?? ""),
    assistant_id: body?.assistant_id != null ? Number(body.assistant_id) : null,
    custom: body?.custom && typeof body.custom === "object" ? body.custom : undefined,
  });
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
