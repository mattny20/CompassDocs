import { NextResponse } from "next/server";
import { getDocument } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { canEditSpace } from "@/lib/access";
import { getAppSettings } from "@/lib/settings-store";
import { moveSibling } from "@/lib/doc-tree";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Reorder a sub-page among its siblings (nested pages must be enabled).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  if (!(await getAppSettings()).nested_pages_enabled) {
    return NextResponse.json({ error: "Nested pages are disabled." }, { status: 400 });
  }
  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!(await canEditSpace(user, doc.space_id))) {
    return NextResponse.json({ error: "You don't have edit access to this space." }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const dir = body?.dir === -1 ? -1 : body?.dir === 1 ? 1 : undefined;
  if (!dir) return NextResponse.json({ error: "dir must be -1 or 1." }, { status: 400 });

  const ok = await moveSibling(doc.id, dir);
  return NextResponse.json({ ok });
}
