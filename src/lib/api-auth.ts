import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getCurrentUser } from "./auth";
import { MasterKeyError } from "./secretbox";
import { roleAtLeast } from "./types";
import type { Role, SessionUser } from "./types";
import type { PermissionKey } from "./permissions";

/**
 * Run a settings-save that may seal credentials, surfacing a MasterKeyError
 * (unreadable key file, bad COMPASSDOCS_SECRET_KEY) as a 500 whose message
 * tells the admin what to fix — instead of the generic "could not save".
 * Returns null on success so callers can `if (err) return err;`.
 */
export async function credentialSaveError(save: () => Promise<unknown>): Promise<NextResponse | null> {
  try {
    await save();
    return null;
  } catch (e) {
    if (e instanceof MasterKeyError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    throw e;
  }
}

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
 *
 * SHADOW MODE (0.92). Pass the permission this route actually requires and the
 * guard evaluates the new RBAC model alongside the legacy ladder, records
 * whether the two agreed, and then **enforces the legacy answer**:
 *
 *   const gate = await apiGuard("admin", "group.create");
 *
 * So porting a route cannot change who gets in. When every route has a
 * permission attached and the disagreement count at
 * /api/admin/rbac/shadow is zero, enforcement flips to the RBAC answer in one
 * reviewable commit. This is deliberately slower than swapping the check
 * outright — a wrong substitution here is a silent grant, not a build failure.
 *
 * `spaceId` is required for space-scoped permissions; a space-scoped permission
 * held globally applies everywhere.
 */
export async function apiGuard(
  min: Role = "viewer",
  permission?: PermissionKey,
  spaceId?: number
): Promise<SessionUser | NextResponse> {
  const cross = await crossOriginRejection();
  if (cross) return cross;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const legacyAllowed = roleAtLeast(user.role, min);
  if (permission) await observe(user.id, permission, legacyAllowed, spaceId);

  if (!legacyAllowed) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  return user;
}

/**
 * Evaluate the RBAC answer and record how it compared. Isolated and
 * fail-quiet: shadow accounting must never be able to turn an allowed request
 * into an error, so anything that goes wrong here is swallowed.
 */
async function observe(
  userId: number,
  permission: PermissionKey,
  legacyAllowed: boolean,
  spaceId?: number
): Promise<void> {
  try {
    const [{ grantsFor, holds }, { recordShadowObservation }] = await Promise.all([
      import("./authz"),
      import("./db"),
    ]);
    const grants = await grantsFor(userId);
    const rbacAllowed = holds(grants, permission, spaceId);
    const h = await headers();
    const route = h.get("x-invoke-path") || h.get("referer") || permission;
    await recordShadowObservation(route, permission, legacyAllowed, rbacAllowed);
  } catch {
    /* shadow accounting is never load-bearing */
  }
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
