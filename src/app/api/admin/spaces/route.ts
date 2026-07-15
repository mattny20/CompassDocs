import { NextResponse } from "next/server";
import {
  listSpaces,
  createSpace,
  uniqueSpaceSlug,
  listAllSpaceGroups,
  setSpaceGroups,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ spaces: await listSpaces(), spaceGroups: await listAllSpaceGroups() });
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
  if (name.length < 2 || name.length > 60) {
    return NextResponse.json({ error: "Space name must be 2–60 characters." }, { status: 400 });
  }

  const slug = await uniqueSpaceSlug(name);
  const visibility = ["public", "internal", "private"].includes(body?.visibility)
    ? body.visibility
    : "internal";
  const space = await createSpace({
    slug,
    name,
    description: String(body?.description ?? "").trim().slice(0, 280),
    icon: String(body?.icon ?? "").trim().slice(0, 8) || "📁",
    color: /^#[0-9a-fA-F]{6}$/.test(body?.color) ? body.color : "#2e75bd",
    visibility,
  });
  if (visibility === "private" && Array.isArray(body?.groupIds)) {
    await setSpaceGroups(
      space.id,
      body.groupIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    );
  }
  await audit({
    actor: actorFrom(gate),
    action: "space.create",
    targetType: "space",
    targetId: space.id,
    targetLabel: space.name,
    details: { visibility },
    ip: ipFrom(req),
  });
  return NextResponse.json({ space }, { status: 201 });
}
