import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDocument, getSpaceById } from "@/lib/db";
import { recordView, touchView } from "@/lib/analytics";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { getPublicSiteConfig } from "@/lib/public-site";
import { roleAtLeast } from "@/lib/types";

export const dynamic = "force-dynamic";

// View tracking for KB analytics. The doc page mounts a small client tracker:
// one POST {docId} when the page opens (returns a view id), then heartbeat
// POSTs {viewId, seconds} every 15s while the tab is visible, so duration
// reflects real reading time. Anonymous tracking is allowed only for
// documents actually visible on the public site.

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const user = await getCurrentUser();

  // Heartbeat: extend an existing view's duration.
  if (body?.viewId !== undefined) {
    const viewId = Number(body.viewId);
    const seconds = Number(body.seconds);
    if (!Number.isInteger(viewId) || !Number.isFinite(seconds)) {
      return NextResponse.json({ error: "Invalid heartbeat." }, { status: 400 });
    }
    await touchView(viewId, user?.id ?? null, seconds);
    return NextResponse.json({ ok: true });
  }

  const docId = Number(body?.docId);
  if (!Number.isInteger(docId) || docId <= 0) {
    return NextResponse.json({ error: "docId required." }, { status: 400 });
  }
  const doc = await getDocument(docId);
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });

  if (user) {
    if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (doc.status === "draft" && !roleAtLeast(user.role, "editor")) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const viewId = await recordView(doc.id, user.id, "app");
    return NextResponse.json({ viewId });
  }

  // Anonymous: only for docs actually served by the public site.
  const [site, space] = await Promise.all([getPublicSiteConfig(), getSpaceById(doc.space_id)]);
  if (!site.enabled || space?.visibility !== "public" || doc.status !== "published") {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const viewId = await recordView(doc.id, null, "public");
  return NextResponse.json({ viewId });
}
