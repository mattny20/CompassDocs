import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { updateField, deleteField, reapplyMappings } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readFieldBody } from "../body";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "directory.field_manage");
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

  const input = readFieldBody(body);
  const field = await updateField(id, input);
  if (!field) return NextResponse.json({ error: "Not found." }, { status: 404 });

  // Mappings, options and direction all change what the stored records mean;
  // re-derive the synced layer so the admin sees the effect immediately.
  const touchesData =
    input.mappings !== undefined ||
    input.graph_path !== undefined ||
    input.google_path !== undefined ||
    input.link_direction !== undefined ||
    input.multi !== undefined;
  const applied = touchesData ? await reapplyMappings() : null;

  await audit({
    actor: actorFrom(gate),
    action: "directory.field_updated",
    targetType: "directory_field",
    targetId: String(id),
    targetLabel: field.label,
    details: { keys: Object.keys(input) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ field, applied });
}

/** Delete a field definition and scrub its values from every person. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "directory.field_manage");
  if (gate instanceof NextResponse) return gate;

  const { id: idRaw } = await ctx.params;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  let ok: boolean;
  try {
    ok = await deleteField(id);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Could not delete the field." }, { status: 400 });
  }
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
