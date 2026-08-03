// Auth for the public REST API (/api/v1): personal access tokens only, sent
// as `Authorization: Bearer cdk_…`. Session cookies are deliberately NOT
// accepted here — that keeps the surface immune to CSRF and makes the API
// contract explicit. Scope model: `read` for GETs, `write` for mutations;
// everything is further bounded by the token owner's permissions and space
// scope, so a token can never see or do more than its user. Server-only.
//
// Two independent gates, both of which must pass (0.99.1):
//
//   1. the token's scope — what this *credential* may do, chosen when it was
//      minted, so a read-only token stays read-only however privileged its
//      owner is;
//   2. the owner's permissions — what this *person* may do.
//
// Until 0.99.1 the second gate was the role ladder rather than the permission
// model, which meant custom roles worked everywhere in the app except here: a
// viewer granted `document.create` was refused with "needs the editor role".

import "server-only";
import { NextResponse } from "next/server";
import { getUserByApiToken } from "./db";
import { apiV1RateLimited } from "./rate-limit";
import type { User } from "./types";
import type { PermissionKey } from "./permissions";

export type V1User = User & { token_scopes: string[] };

export function v1Error(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Resolve and gate a v1 request. Returns the token's user, or a ready-made
 * 401/403/429 response.
 */
export async function v1Auth(req: Request, need: "read" | "write"): Promise<V1User | NextResponse> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return v1Error(401, "Authentication required: Authorization: Bearer <token>.");
  }
  const user = await getUserByApiToken(token);
  if (!user) return v1Error(401, "Invalid or revoked API token.");
  if (apiV1RateLimited(String(user.id))) {
    return v1Error(429, "Rate limit exceeded (120 requests/minute). Slow down and retry.");
  }
  const scopes = Array.isArray(user.token_scopes) ? user.token_scopes : [];
  if (!scopes.includes(need)) {
    return v1Error(403, `This token is missing the '${need}' scope.`);
  }
  return user;
}

/**
 * Does the token's owner hold `permission`? Returns null to proceed, or a
 * ready-made error response.
 *
 * Mirrors apiGuard: the break-glass switch falls back to the role ladder, and
 * an unresolvable answer is a 503 rather than a 403 — the caller's rights are
 * unknown, not absent, and "retry shortly" is the honest advice. Callers pass
 * `legacyMin` so the break-glass path keeps the exact behaviour it had before
 * this function existed.
 */
export async function v1Requires(
  user: V1User,
  permission: PermissionKey,
  opts?: { spaceId?: number; legacyMin?: User["role"]; message?: string }
): Promise<NextResponse | null> {
  const { legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) {
    const { roleAtLeast } = await import("./types");
    return roleAtLeast(user.role, opts?.legacyMin ?? "editor")
      ? null
      : v1Error(403, opts?.message ?? "You don't have permission for that.");
  }
  try {
    const { grantsFor, admits } = await import("./authz");
    if (admits(await grantsFor(user.id), permission, opts?.spaceId)) return null;
  } catch {
    return v1Error(503, "Could not evaluate permissions. Try again shortly.");
  }
  return v1Error(403, opts?.message ?? "You don't have permission for that.");
}

/** Convenience: does the owner hold `permission`, as a plain boolean? */
export async function v1Holds(
  user: V1User,
  permission: PermissionKey,
  spaceId?: number
): Promise<boolean> {
  const { legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) {
    const { roleAtLeast } = await import("./types");
    // The ladder rung each of these permissions used to correspond to.
    return roleAtLeast(user.role, permission === "document.publish" ? "approver" : "editor");
  }
  try {
    const { grantsFor, admits } = await import("./authz");
    return admits(await grantsFor(user.id), permission, spaceId);
  } catch {
    // A boolean has nowhere to report "unknown", so it must not guess in the
    // permissive direction. Callers use this for capability flags and
    // publish-vs-queue decisions, where false degrades to "queue it".
    return false;
  }
}
