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

/**
 * Which spaces may this user SEE?
 *
 * Two changes in 0.95, both of which can only widen or exactly preserve access:
 *
 * - The admin bypass is a permission (`space.read_all`) instead of
 *   `role === "admin"`. The Administrator preset holds it, so administrators
 *   are unaffected; the difference is that "can see every private space" is now
 *   something a workspace can grant deliberately, name in an audit, and see in
 *   the explainer — rather than a constant three layers down in a module most
 *   people never open.
 *
 * - A space-scoped `space.member` grant counts as membership. That is the
 *   RBAC-native way to say "these people can read this private space", and it
 *   sits alongside the existing group grants rather than replacing them: the
 *   union means no existing member can lose access to a space they can read
 *   today, which is the property that matters when the failure mode is
 *   exposing or hiding private content.
 */
export async function spaceScopeFor(user: { id: number; role: Role }): Promise<SpaceScope> {
  const { grantsFor, holds, spacesWith, legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) {
    if (user.role === "admin") return scope("all");
    return scope(await accessibleSpaceIdsFor(user.id));
  }
  const grants = await grantsFor(user.id);
  if (holds(grants, "space.read_all")) return scope("all");

  const viaGroups = await accessibleSpaceIdsFor(user.id);
  const viaRole = spacesWith(grants, "space.member");
  if (viaRole === "all") return scope("all");
  return scope([...new Set([...viaGroups, ...viaRole])]);
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
  const { grantsFor, holds, legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) {
    if (!roleAtLeast(user.role, "editor")) return false;
    if (user.role === "admin") return true;
    if (!scopeAllows(await spaceScopeFor(user), spaceId)) return false;
    if (await editorsEditAll()) return true;
    return spaceEditGrantAllows(spaceId, user.id);
  }

  const grants = await grantsFor(user.id);
  // The admin bypass, named (0.95). Held by the Administrator preset, so this
  // is the same set of people — but it is now a grant a workspace can move.
  if (holds(grants, "space.author_all")) return true;

  // Visibility first, always. Authoring implies seeing, and this is the check
  // whose absence 0.89.1 turned into an anonymous read of a private document.
  if (!scopeAllows(await spaceScopeFor(user), spaceId)) return false;

  // A space-scoped grant authorises authoring in exactly that space. This is
  // the per-space enforcement 0.93 deferred: until now a role assigned to one
  // space could not actually unlock anything, because nothing consulted it.
  if (holds(grants, "space.author", spaceId)) return true;

  // Otherwise the pre-existing rules, unchanged: the org policy switch, then
  // the space's own editor grants. Everything above is additive, so nobody who
  // can author today stops being able to.
  if (!holds(grants, "document.update")) return false;
  if (await editorsEditAll()) return true;
  return spaceEditGrantAllows(spaceId, user.id);
}

/** "all" (admins) or the concrete list of space ids the user may author in. */
export async function editableScopeFor(user: {
  id: number;
  role: Role;
}): Promise<SpaceScope> {
  const { grantsFor, holds, spacesWith, legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) {
    if (user.role === "admin") return scope("all");
    if (!roleAtLeast(user.role, "editor")) return scope([]);
    const visible = await accessibleSpaceIdsFor(user.id);
    if (await editorsEditAll()) return scope(visible);
    const granted = new Set(await editGrantedSpaceIdsFor(user.id));
    return scope(visible.filter((id) => granted.has(id)));
  }

  const grants = await grantsFor(user.id);
  if (holds(grants, "space.author_all")) return scope("all");

  // The set this returns must agree with canEditSpace above, space by space —
  // one decides what a list shows, the other whether a write succeeds, and a
  // disagreement is either a document you can see but not save or one you can
  // save but never find. Both start from what's visible and add the same two
  // sources: a space-scoped grant, and the legacy edit rights.
  const visibleScope = await spaceScopeFor(user);
  const perSpace = spacesWith(grants, "space.author");
  if (visibleScope === "all") {
    // Only reachable via space.read_all without space.author_all — an unusual
    // combination, but "sees everything, authors where granted" is coherent.
    return perSpace === "all" ? scope("all") : scope(perSpace);
  }
  const visible: number[] = visibleScope;
  const fromRole = perSpace === "all" ? new Set(visible) : new Set(perSpace);

  if (!holds(grants, "document.update")) {
    return scope(visible.filter((id) => fromRole.has(id)));
  }
  if (await editorsEditAll()) return scope(visible);
  const granted = new Set(await editGrantedSpaceIdsFor(user.id));
  return scope(visible.filter((id) => granted.has(id) || fromRole.has(id)));
}
