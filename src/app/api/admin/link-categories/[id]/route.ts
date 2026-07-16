import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { updateLinkCategory, deleteLinkCategory } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const patch: { name?: string; position?: number } = {};
  if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name;
  if (Number.isInteger(body?.position)) patch.position = body.position;
  await updateLinkCategory(Number(id), patch);

  await audit({
    actor: actorFrom(gate),
    action: "link_category.updated",
    targetLabel: patch.name ?? `#${id}`,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

// Deleting a category keeps its links — they fall back to "General".
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const gone = await deleteLinkCategory(Number(id));
  if (!gone) return NextResponse.json({ error: "Category not found." }, { status: 404 });

  await audit({
    actor: actorFrom(gate),
    action: "link_category.deleted",
    targetLabel: `#${id}`,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
