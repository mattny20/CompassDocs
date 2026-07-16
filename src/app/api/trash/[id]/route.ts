import { NextResponse } from "next/server";
import { restoreDocument, purgeDocument, getTrashedDocumentSpaceId } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { canEditSpace } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Restore a trashed document back to its space. Editors and up, with edit
// rights on the space it returns to.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const spaceId = await getTrashedDocumentSpaceId(Number(id));
  if (!spaceId) return NextResponse.json({ error: "Not found in Trash." }, { status: 404 });
  if (!(await canEditSpace(user, spaceId))) {
    return NextResponse.json(
      { error: "You don't have edit access to this space." },
      { status: 403 }
    );
  }

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
