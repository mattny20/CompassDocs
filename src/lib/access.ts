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

// Scope is an opaque branded value defined in ./space-scope, so the data layer
// can require one without importing the policy layer. Re-exported here because
// this module is where callers already look for it.
import { asScope as scope, EVERY_SPACE_UNFILTERED, scopeAllows, scopeIsEmpty } from "./space-scope";
import type { SpaceScope } from "./space-scope";

export type { SpaceScope };
export { EVERY_SPACE_UNFILTERED, scopeAllows, scopeIsEmpty };

export async function spaceScopeFor(user: { id: number; role: Role }): Promise<SpaceScope> {
  if (user.role === "admin") return scope("all");
  return scope(await accessibleSpaceIdsFor(user.id));
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

/**
 * May this user author in this space?
 *
 * Authoring implies seeing: this checks visibility itself rather than trusting
 * the caller to have done it. It used to be documented as "assumes caller
 * verified visibility", and that unenforced contract was broken twice — the
 * share and trash-restore routes reached it with no scope check, which let an
 * editor mint an anonymous share link for a document in a private space they
 * could not read (fixed in 0.89.1). An invariant a caller can silently skip is
 * not an invariant.
 *
 * Note the ordering: editorsEditAll() only widens authoring across spaces the
 * user can already SEE. It is not a bypass of visibility, and never was meant
 * to be one.
 */
export async function canEditSpace(
  user: { id: number; role: Role },
  spaceId: number
): Promise<boolean> {
  if (!roleAtLeast(user.role, "editor")) return false;
  if (user.role === "admin") return true;
  if (!scopeAllows(await spaceScopeFor(user), spaceId)) return false;
  if (await editorsEditAll()) return true;
  return spaceEditGrantAllows(spaceId, user.id);
}

/** "all" (admins) or the concrete list of space ids the user may author in. */
export async function editableScopeFor(user: {
  id: number;
  role: Role;
}): Promise<SpaceScope> {
  if (user.role === "admin") return scope("all");
  if (!roleAtLeast(user.role, "editor")) return scope([]);
  const visible = await accessibleSpaceIdsFor(user.id);
  if (await editorsEditAll()) return scope(visible);
  const granted = new Set(await editGrantedSpaceIdsFor(user.id));
  return scope(visible.filter((id) => granted.has(id)));
}
