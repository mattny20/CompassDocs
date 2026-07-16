import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getSpaceById, listSpaceCategories, createSpaceCategory } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!(await getSpaceById(id))) {
    return NextResponse.json({ error: "Space not found." }, { status: 404 });
  }
  return NextResponse.json({ categories: await listSpaceCategories(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const id = Number((await params).id);
  const space = await getSpaceById(id);
  if (!space) return NextResponse.json({ error: "Space not found." }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "A name is required." }, { status: 400 });

  const category = await createSpaceCategory(id, name);
  await audit({
    actor: actorFrom(gate),
    action: "space_category.created",
    targetType: "space",
    targetId: id,
    targetLabel: `${space.name} / ${category.name}`,
    ip: ipFrom(req),
  });
  return NextResponse.json({ category }, { status: 201 });
}
