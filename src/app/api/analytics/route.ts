import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor } from "@/lib/access";
import { listSpaces, listSpaceCategories, listAuthors } from "@/lib/db";
import {
  overview,
  viewsOverTime,
  topDocuments,
  leastViewed,
  trendingDocuments,
  topSearches,
  zeroResultSearches,
  topReaders,
  authorStats,
  recentActivity,
  type AnalyticsFilters,
} from "@/lib/analytics";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const RANGES = new Set([7, 30, 90, 365]);

// The whole dashboard in one round trip. Approvers and admins only; results
// honor the caller's space scope on top of any explicit filters.

export async function GET(req: Request) {
  const gate = await apiGuard("approver");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const url = new URL(req.url);
  const days = RANGES.has(Number(url.searchParams.get("days")))
    ? Number(url.searchParams.get("days"))
    : 30;
  const f: AnalyticsFilters = {
    days,
    scope: await spaceScopeFor(user),
    spaceId: Number(url.searchParams.get("space")) || undefined,
    categoryId: Number(url.searchParams.get("category")) || undefined,
    author: url.searchParams.get("author")?.trim() || undefined,
    tag: url.searchParams.get("tag")?.trim() || undefined,
  };

  const [
    kpis,
    series,
    top,
    least,
    trending,
    searches,
    zeroSearches,
    readers,
    authors,
    activity,
    spaces,
    authorOptions,
  ] = await Promise.all([
    overview(f),
    viewsOverTime(f),
    topDocuments(f),
    leastViewed(f),
    trendingDocuments(f),
    topSearches(days),
    zeroResultSearches(days),
    topReaders(f),
    authorStats(f),
    recentActivity(f),
    listSpaces(f.scope),
    listAuthors(),
  ]);

  const categories = f.spaceId ? await listSpaceCategories(f.spaceId) : [];

  return NextResponse.json({
    days,
    kpis,
    series,
    top,
    least,
    trending,
    searches,
    zeroSearches,
    readers,
    authors,
    activity,
    options: {
      spaces: spaces.map((s: any) => ({ id: s.id, name: s.name, icon: s.icon })),
      categories: categories.map((c: any) => ({ id: c.id, name: c.name })),
      authors: authorOptions,
    },
  });
}
