import { NextResponse } from "next/server";
import { getCurrentUser } from "./auth";
import { roleAtLeast } from "./types";
import type { Role, SessionUser } from "./types";

/**
 * Guard for API route handlers. Returns either the authenticated user or a
 * ready-to-return NextResponse (401/403). Usage:
 *   const gate = await apiGuard("editor");
 *   if (gate instanceof NextResponse) return gate;
 *   const user = gate;
 */
export async function apiGuard(min: Role = "viewer"): Promise<SessionUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (!roleAtLeast(user.role, min)) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  return user;
}
