import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listFields, createField } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ fields: await listFields() });
}

/** Define a custom directory field (optionally mapped to a Graph property). */
export async function POST(req: Request) {
  const gate = await apiGuard("admin");
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
    const field = await createField({
      label,
      key: body?.key ? String(body.key) : undefined,
      graph_path: String(body?.graph_path ?? ""),
      show_in_card: Boolean(body?.show_in_card),
    });
    await audit({
      actor: actorFrom(gate),
      action: "directory.field_added",
      targetType: "directory_field",
      targetId: String(field.id),
      targetLabel: field.label,
      ip: ipFrom(req),
    });
    return NextResponse.json({ field }, { status: 201 });
  } catch (e: any) {
    const msg = /duplicate key/.test(String(e?.message))
      ? "A field with that key already exists."
      : e?.message || "Could not create the field.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
