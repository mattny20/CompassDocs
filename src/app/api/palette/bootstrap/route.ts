import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor } from "@/lib/access";
import { listRecentlyViewedBy } from "@/lib/db";
import { shareLinksEnabled } from "@/lib/shares";
import { roleAtLeast } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The small payload the command palette needs the first time it opens: what
 * this user was last reading, plus the cheap workspace flags the rows depend
 * on. One idle fetch per session beats paying these queries as props on every
 * navigation.
 *
 * Everything here is re-scoped per request — listRecentlyViewedBy is already
 * space-scope and draft aware — so the response is per-user and never shared.
 * Capabilities are NOT here: they arrive as server props, so the palette's
 * gated rows are correct on first paint with no optimistic default.
 */
export async function GET(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(12, Math.max(1, Number(searchParams.get("limit")) || 8));

  const scope = await spaceScopeFor(gate);
  const [docs, shareLinks] = await Promise.all([
    listRecentlyViewedBy(gate.id, scope, roleAtLeast(gate.role, "editor"), limit),
    shareLinksEnabled(),
  ]);

  const recent_docs = docs.map((d) => ({
    id: d.id,
    title: d.title,
    type: d.type,
    status: d.status,
    space_name: d.space_name,
    space_slug: d.space_slug,
    space_icon: d.space_icon,
    updated_at: d.updated_at,
  }));

  return NextResponse.json(
    { recent_docs, share_links_enabled: shareLinks },
    { headers: { "Cache-Control": "private, max-age=30" } }
  );
}
