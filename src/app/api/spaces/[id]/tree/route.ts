import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getSpaceById } from "@/lib/db";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { getAppSettings } from "@/lib/settings-store";
import { treeForSpace } from "@/lib/doc-tree";
import { roleAtLeast } from "@/lib/types";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The nested page tree for one space (sidebar navigation). Viewer-safe:
// scope-checked, drafts included only for staff.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  if (!(await getAppSettings()).nested_pages_enabled) {
    return NextResponse.json({ error: "Nested pages are disabled." }, { status: 400 });
  }
  const { id } = await params;
  const space = await getSpaceById(Number(id));
  if (!space || !scopeAllows(await spaceScopeFor(user), space.id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const tree = await treeForSpace(space.id, roleAtLeast(user.role, "editor"));
  return NextResponse.json({ tree });
}
