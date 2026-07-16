// Space-level access control. Public spaces are visible to every signed-in
// user; private spaces only to admins and members of groups granted on the
// space. Pages and APIs resolve a user's scope once per request and pass it
// into the db queries that list or read documents. Server-only.

import "server-only";
import {
  accessibleSpaceIdsFor,
  editGrantedSpaceIdsFor,
  getSetting,
  spaceEditGrantAllows,
} from "./db";
import { roleAtLeast } from "./types";
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

// --- Edit rights -----------------------------------------------------------------
//
// Visibility says who can READ a space; edit rights say who can AUTHOR in it
// (create/edit/move/trash docs, upload attachments). Role is still the floor —
// you must be editor+ either way. The org-level 'editors_edit_all' setting
// (default on) preserves the classic behavior: any editor may author in any
// space they can see. Switched off, a space's editor grants apply: no grants =
// any editor, grants = only those users/groups. Admins always bypass. Only
// admins can change grants or the org setting (admin-guarded APIs).

/** Org-level switch: true = any editor may edit any visible space (default). */
export async function editorsEditAll(): Promise<boolean> {
  return (await getSetting("editors_edit_all")) !== "0";
}

/** May this user author in this space? (Assumes caller verified visibility.) */
export async function canEditSpace(
  user: { id: number; role: Role },
  spaceId: number
): Promise<boolean> {
  if (!roleAtLeast(user.role, "editor")) return false;
  if (user.role === "admin") return true;
  if (await editorsEditAll()) return true;
  return spaceEditGrantAllows(spaceId, user.id);
}

/** "all" (admins) or the concrete list of space ids the user may author in. */
export async function editableScopeFor(user: {
  id: number;
  role: Role;
}): Promise<SpaceScope> {
  if (user.role === "admin") return "all";
  if (!roleAtLeast(user.role, "editor")) return [];
  const visible = await accessibleSpaceIdsFor(user.id);
  if (await editorsEditAll()) return visible;
  const granted = new Set(await editGrantedSpaceIdsFor(user.id));
  return visible.filter((id) => granted.has(id));
}
