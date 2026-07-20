import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getCurrentUser } from "./auth";
import { roleAtLeast } from "./types";
import type { Role, SessionUser } from "./types";

/**
 * Cross-origin check, layered on top of SameSite=Lax cookies: when a browser
 * sends an Origin header, its host must match the host the request arrived
 * at. Requests without an Origin (same-origin GETs, curl, server-to-server)
 * pass — this only rejects a browser explicitly declaring another origin,
 * which is exactly the CSRF shape. Returns null when OK.
 */
export async function crossOriginRejection(): Promise<NextResponse | null> {
  const h = await headers();
  const origin = h.get("origin");
  if (!origin || origin === "null") {
    // "null" origins come from sandboxed frames/redirect chains — for a
    // cookie-authenticated JSON API there's no legitimate case for them.
    if (origin === "null") {
      return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
    }
    return null;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const requestHost = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  if (originHost.toLowerCase() !== requestHost.toLowerCase()) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  return null;
}

/**
 * Guard for API route handlers. Returns either the authenticated user or a
 * ready-to-return NextResponse (401/403). Usage:
 *   const gate = await apiGuard("editor");
 *   if (gate instanceof NextResponse) return gate;
 *   const user = gate;
 */
export async function apiGuard(min: Role = "viewer"): Promise<SessionUser | NextResponse> {
  const cross = await crossOriginRejection();
  if (cross) return cross;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (!roleAtLeast(user.role, min)) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  return user;
}

/**
 * Guard for delegated operational sections (Announcements, Compliance):
 * admins always pass; other users pass when granted the section directly or
 * via a group (Settings → Section access).
 */
export async function sectionApiGuard(
  section: import("./section-access").Section
): Promise<SessionUser | NextResponse> {
  const cross = await crossOriginRejection();
  if (cross) return cross;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { canAccessSection } = await import("./section-access");
  if (!(await canAccessSection(user, section))) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  return user;
}
