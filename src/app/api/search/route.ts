import { NextResponse } from "next/server";
import { hybridSearchDocuments } from "@/lib/embeddings";
import { recordSearch } from "@/lib/analytics";
import { getCurrentUser } from "@/lib/auth";
import { canSeeDrafts, spaceScopeFor, scopeAllows } from "@/lib/access";
import { searchRateLimited } from "@/lib/rate-limit";
import { metric } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  // The one endpoint that can bill an uncached embeddings call per request.
  if (searchRateLimited(String(user.id))) {
    return NextResponse.json({ error: "Too many requests — slow down a moment." }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  // Clamped at BOTH ends: ?limit=-1 used to reach Postgres as LIMIT -1 and 500.
  const limit = Math.min(50, Math.max(1, Number(searchParams.get("limit")) || 25));
  if (!q) return NextResponse.json({ hits: [] });
  metric("search_requests");

  const includeDrafts = await canSeeDrafts(user);
  const scope = await spaceScopeFor(user);

  // Optional in-space search: the space must be within the user's scope.
  const spaceParam = Number(searchParams.get("space_id")) || undefined;
  if (spaceParam && !scopeAllows(scope, spaceParam)) {
    return NextResponse.json({ hits: [] });
  }
  const hits = await hybridSearchDocuments(q, limit, includeDrafts, scope, spaceParam);
  // Nested pages: attach each hit's ancestor path so results show where a
  // sub-page lives (admin-gated).
  let withPaths: any[] = hits;
  const { getAppSettings } = await import("@/lib/settings-store");
  if ((await getAppSettings()).nested_pages_enabled && hits.length) {
    const { ancestorsOf } = await import("@/lib/doc-tree");
    withPaths = await Promise.all(
      hits.map(async (h: any) => ({
        ...h,
        path: (await ancestorsOf(h.id)).reverse().map((a) => a.title),
      }))
    );
  }
  // Fire-and-forget analytics (prefix bursts are collapsed server-side).
  void recordSearch(user.id, q, hits.length, "search").catch(() => {});
  return NextResponse.json({ hits: withPaths });
}
