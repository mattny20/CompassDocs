// Space-level access control. Public spaces are visible to every signed-in
// user; private spaces only to admins and members of groups granted on the
// space. Pages and APIs resolve a user's scope once per request and pass it
// into the db queries that list or read documents. Server-only.

import "server-only";
import { accessibleSpaceIdsFor } from "./db";
import type { Role } from "./types";

/** "all" (admins) or the concrete list of visible space ids. */
export type SpaceScope = "all" | number[];

export async function spaceScopeFor(user: { id: number; role: Role }): Promise<SpaceScope> {
  if (user.role === "admin") return "all";
  return accessibleSpaceIdsFor(user.id);
}

export function scopeAllows(scope: SpaceScope, spaceId: number): boolean {
  return scope === "all" || scope.includes(spaceId);
}
