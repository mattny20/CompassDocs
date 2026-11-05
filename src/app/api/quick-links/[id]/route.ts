// Unpin one of the viewer's own Quick links (1.17.0). Only their own pins:
// another person's id answers 404.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { deleteUserQuickLink } from "@/lib/db";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer", "link.read");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const pinId = Number((await params).id);
  if (!Number.isInteger(pinId) || !(await deleteUserQuickLink(user.id, pinId))) {
    return NextResponse.json({ error: "Pin not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
