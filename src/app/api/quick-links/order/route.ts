// Reorder the viewer's own Quick links (1.17.0): PATCH { pinIds } in the new
// order → { pinned }. Ids that are not theirs are ignored; pins left out keep
// their order after the listed ones.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { MAX_USER_QUICK_LINKS, reorderUserQuickLinks } from "@/lib/db";
import { getPinnedQuickLinks } from "@/lib/quick-links";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  const gate = await apiGuard("viewer", "link.read");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: { pinIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const ids = body?.pinIds;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_USER_QUICK_LINKS * 4 ||
    !ids.every((v) => Number.isInteger(v) && v > 0)
  ) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  await reorderUserQuickLinks(user.id, ids as number[]);
  return NextResponse.json({ pinned: await getPinnedQuickLinks(user) });
}
