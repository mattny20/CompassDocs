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
 * ready-to-return NextResponse (401/403/503). Usage:
 *   const gate = await apiGuard("editor", "document.create");
 *   if (gate instanceof NextResponse) return gate;
 *   const user = gate;
 *
 * The permission is the authority (0.93). `min` is still passed at every site
 * and still evaluated, but only to keep the shadow scoreboard honest — it
 * records how the two models compared so a regression shows up as a number on
 * /admin/roles rather than as a support ticket. Routes that have not been given
 * a permission fall back to the ladder.
 *
 * Pass `spaceId` when the route already knows which space it is acting on. When
 * it doesn't, a space-scoped permission is admitted if the caller holds it in
 * any space and the route's own SpaceScope check does the narrowing — see
 * `admits()` in lib/authz.
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

  const { legacyAuthzEnforcement } = await import("./authz");
  const legacyAllowed = roleAtLeast(user.role, min);
  if (!permission || legacyAuthzEnforcement()) {
    if (!legacyAllowed) {
      return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
    }
    return user;
  }

  let rbacAllowed: boolean;
  try {
    const { grantsFor, admits } = await import("./authz");
    rbacAllowed = admits(await grantsFor(user.id), permission, spaceId);
  } catch {
    // Authorization is now load-bearing, so an unresolvable answer must not
    // become an allowed one. 503 rather than 403: the caller's rights are
    // unknown, not absent, and retrying is the right advice.
    return NextResponse.json(
      { error: "Could not evaluate permissions. Try again shortly." },
      { status: 503 }
    );
  }

  void observe(permission, legacyAllowed, rbacAllowed);

  if (!rbacAllowed) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  return user;
}

/**
 * Record how the two models compared. Kept running past the flip: it is now a
 * regression detector rather than a porting scoreboard, and it costs one
 * upserted counter per distinct (route, permission, outcome) shape.
 *
 * Not awaited and fail-quiet — accounting must never turn an allowed request
 * into an error, nor add latency to one.
 */
async function observe(
  permission: PermissionKey,
  legacyAllowed: boolean,
  rbacAllowed: boolean
): Promise<void> {
  try {
    const { recordShadowObservation } = await import("./db");
    const h = await headers();
    const route = h.get("x-invoke-path") || h.get("referer") || permission;
    await recordShadowObservation(route, permission, legacyAllowed, rbacAllowed);
  } catch {
    /* observability is never load-bearing */
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
