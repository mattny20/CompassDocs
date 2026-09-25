import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listFields, createField, reapplyMappings, type FieldInput } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readFieldBody } from "./body";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "directory.field_manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ fields: await listFields() });
}

/** Define a directory field: its kind, options, display, and per-provider mappings. */
export async function POST(req: Request) {
  const gate = await apiGuard("admin", "directory.field_manage");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const label = String(body?.label ?? "").trim();
  if (!label) return NextResponse.json({ error: "Label is required." }, { status: 400 });

  try {
    const input: FieldInput & { label: string } = { ...readFieldBody(body), label };
    const field = await createField(input);
    // A mapping takes effect on the stored records right away — no resync.
    const applied = Object.keys(field.mappings).length ? await reapplyMappings() : null;
    await audit({
      actor: actorFrom(gate),
      action: "directory.field_added",
      targetType: "directory_field",
      targetId: String(field.id),
      targetLabel: field.label,
      ip: ipFrom(req),
    });
    return NextResponse.json({ field, applied }, { status: 201 });
  } catch (e: any) {
    const msg = /duplicate key/.test(String(e?.message))
      ? "A field with that key already exists."
      : e?.message || "Could not create the field.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
