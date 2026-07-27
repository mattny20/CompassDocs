// Auth for the public REST API (/api/v1): personal access tokens only, sent
// as `Authorization: Bearer cdk_…`. Session cookies are deliberately NOT
// accepted here — that keeps the surface immune to CSRF and makes the API
// contract explicit. Scope model: `read` for GETs, `write` for mutations;
// everything is further bounded by the token owner's role and space scope,
// so a token can never see or do more than its user. Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { getUserByApiToken } from "./db";
import { apiV1RateLimited } from "./rate-limit";
import type { User } from "./types";

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
