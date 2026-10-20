import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listFields, updateField, deleteField, reapplyMappings, type DirectoryField } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readFieldBody } from "../body";

export const dynamic = "force-dynamic";

/** Who heads which option, as one string, so a save can say whether it changed the heads. */
function headsSignature(options: DirectoryField["options"]): string {
  return JSON.stringify(options.filter((o) => o.heads?.length).map((o) => [o.value.toLowerCase(), o.heads]));
}

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
  // The heads as they were, for the audit: did this save change who heads a section?
  const headsBefore = input.options === undefined ? undefined : headsSignature((await listFields()).find((f) => f.id === id)?.options ?? []);
  let field: DirectoryField | undefined;
  try {
    field = await updateField(id, input);
  } catch (e: any) {
    // A heads list that is malformed, over the limit, or names someone the
    // directory does not have is refused by name, never trimmed and saved.
    return NextResponse.json({ error: e?.message || "Could not save the field." }, { status: 400 });
  }
  if (!field) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const headsChanged = headsBefore !== undefined && headsSignature(field.options) !== headsBefore;

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
    details: { keys: Object.keys(input), ...(headsChanged ? { heads_changed: true } : {}) },
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
