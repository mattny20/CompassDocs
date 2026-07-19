import { NextResponse } from "next/server";
import { searchDocuments } from "@/lib/db";
import { recordSearch } from "@/lib/analytics";
import { getCurrentUser } from "@/lib/auth";
import { roleAtLeast } from "@/lib/types";
import { spaceScopeFor, scopeAllows } from "@/lib/access";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Number(searchParams.get("limit")) || 25, 50);
  if (!q) return NextResponse.json({ hits: [] });

  const includeDrafts = roleAtLeast(user.role, "editor");
  const scope = await spaceScopeFor(user);

  // Optional in-space search: the space must be within the user's scope.
  const spaceParam = Number(searchParams.get("space_id")) || undefined;
  if (spaceParam && !scopeAllows(scope, spaceParam)) {
    return NextResponse.json({ hits: [] });
  }
  const hits = await searchDocuments(q, limit, includeDrafts, scope, spaceParam);
  // Fire-and-forget analytics (prefix bursts are collapsed server-side).
  void recordSearch(user.id, q, hits.length, "search").catch(() => {});
  return NextResponse.json({ hits });
}
