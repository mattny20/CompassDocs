import { NextResponse } from "next/server";
import { listGroups, createGroup } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ groups: await listGroups() });
}

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
  if (name.length < 2 || name.length > 80) {
    return NextResponse.json({ error: "Group name must be 2–80 characters." }, { status: 400 });
  }
  if ((await listGroups()).some((g) => g.name.toLowerCase() === name.toLowerCase())) {
    return NextResponse.json({ error: "A group with that name already exists." }, { status: 409 });
  }

  const group = await createGroup({ name });
  await audit({
    actor: actorFrom(gate),
    action: "group.create",
    targetType: "group",
    targetId: group.id,
    targetLabel: group.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ group }, { status: 201 });
}
