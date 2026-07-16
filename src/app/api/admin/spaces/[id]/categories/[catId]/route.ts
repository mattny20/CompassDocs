import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getSpaceCategory, updateSpaceCategory, deleteSpaceCategory } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function load(params: Promise<{ id: string; catId: string }>) {
  const { id, catId } = await params;
  const cat = await getSpaceCategory(Number(catId));
  return cat && cat.space_id === Number(id) ? cat : undefined;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; catId: string }> }
) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const cat = await load(params);
  if (!cat) return NextResponse.json({ error: "Category not found." }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const patch: { name?: string; position?: number } = {};
  if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name;
  if (Number.isInteger(body?.position)) patch.position = body.position;
  await updateSpaceCategory(cat.id, patch);

  await audit({
    actor: actorFrom(gate),
    action: "space_category.updated",
    targetType: "space",
    targetId: cat.space_id,
    targetLabel: patch.name ?? cat.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

// Deleting a category keeps its documents — they return to "General".
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; catId: string }> }
) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const cat = await load(params);
  if (!cat) return NextResponse.json({ error: "Category not found." }, { status: 404 });

  await deleteSpaceCategory(cat.id);
  await audit({
    actor: actorFrom(gate),
    action: "space_category.deleted",
    targetType: "space",
    targetId: cat.space_id,
    targetLabel: cat.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
