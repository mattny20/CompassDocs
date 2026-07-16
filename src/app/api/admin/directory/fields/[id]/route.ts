import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { updateField, deleteField } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const { id: idRaw } = await ctx.params;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const field = await updateField(id, {
    ...(body?.label !== undefined ? { label: String(body.label) } : {}),
    ...(body?.graph_path !== undefined ? { graph_path: String(body.graph_path) } : {}),
    ...(body?.show_in_card !== undefined ? { show_in_card: Boolean(body.show_in_card) } : {}),
    ...(body?.display !== undefined ? { display: body.display === "tag" ? ("tag" as const) : ("field" as const) } : {}),
    ...(body?.sort !== undefined ? { sort: Number(body.sort) } : {}),
  });
  if (!field) return NextResponse.json({ error: "Not found." }, { status: 404 });

  await audit({
    actor: actorFrom(gate),
    action: "directory.field_updated",
    targetType: "directory_field",
    targetId: String(id),
    targetLabel: field.label,
    ip: ipFrom(req),
  });
  return NextResponse.json({ field });
}

/** Delete a field definition and scrub its values from every person. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const { id: idRaw } = await ctx.params;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const ok = await deleteField(id);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });

  await audit({
    actor: actorFrom(gate),
    action: "directory.field_deleted",
    targetType: "directory_field",
    targetId: String(id),
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
