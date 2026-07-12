import { NextResponse } from "next/server";
import { restoreDocument, purgeDocument } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

// Restore a trashed document back to its space. Editors and up.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const ok = await restoreDocument(Number(id));
  if (!ok) return NextResponse.json({ error: "Not found in Trash." }, { status: 404 });
  return NextResponse.json({ ok: true });
}

// Permanently delete a trashed document (irreversible). Admins only.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const ok = await purgeDocument(Number(id));
  if (!ok) return NextResponse.json({ error: "Not found in Trash." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
