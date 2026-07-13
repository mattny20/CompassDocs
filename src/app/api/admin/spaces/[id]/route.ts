import { NextResponse } from "next/server";
import { updateSpace, deleteSpace, getSpaceById } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || !(await getSpaceById(id))) {
    return NextResponse.json({ error: "Space not found." }, { status: 404 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const patch: { name?: string; description?: string; icon?: string; color?: string } = {};
  if (body?.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 2 || name.length > 60) {
      return NextResponse.json({ error: "Space name must be 2–60 characters." }, { status: 400 });
    }
    patch.name = name;
  }
  if (body?.description !== undefined) patch.description = String(body.description).trim().slice(0, 280);
  if (body?.icon !== undefined) patch.icon = String(body.icon).trim().slice(0, 8) || "📁";
  if (body?.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(body.color)) {
      return NextResponse.json({ error: "Color must be a hex value like #2e75bd." }, { status: 400 });
    }
    patch.color = body.color;
  }

  const space = await updateSpace(id, patch);
  return NextResponse.json({ space });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || !(await getSpaceById(id))) {
    return NextResponse.json({ error: "Space not found." }, { status: 404 });
  }

  const res = await deleteSpace(id);
  if (!res.ok) {
    return NextResponse.json(
      {
        error: `This space still has ${res.docCount} document${res.docCount === 1 ? "" : "s"}. Move or delete them first.`,
      },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
