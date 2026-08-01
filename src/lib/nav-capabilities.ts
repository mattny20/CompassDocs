import "server-only";

// What this user is allowed to see in navigation, resolved once per request.
// The sidebar and the command palette both consume it, so the two can't drift
// — and the palette never has to evaluate an entitlement client-side (it
// couldn't: entitlements and space grants aren't on the session).

import { canAccessSection } from "./section-access";
import { canUseNewsletter } from "./newsletter-access";
import { featureEnabled } from "./ee";
import { editableScopeFor } from "./access";
import { roleAtLeast } from "./types";
import type { SessionUser } from "./types";
import type { CapKey } from "./nav-items";
import { NAV_ITEMS } from "./nav-items";
import { PALETTE_COMMANDS } from "./palette-commands";

export interface NavCapabilities {
  isEditor: boolean;
  isApprover: boolean;
  isAdmin: boolean;
  showNewsletter: boolean;
  showAnnouncements: boolean;
  showCompliance: boolean;
  showTraining: boolean;
  /** Editor or better AND at least one space they may write in. */
  canAuthor: boolean;
}

/**
 * True when the user has somewhere to put a new document. Computed rather than
 * assumed: offering "New document" to an editor with no grants walks them into
 * the "No editable spaces" dead end.
 */
async function canAuthorFor(user: SessionUser): Promise<boolean> {
  if (user.role === "admin") return true;
  if (!roleAtLeast(user.role, "editor")) return false;
  const scope = await editableScopeFor(user);
  return scope === "all" || scope.length > 0;
}

export async function navCapabilities(user: SessionUser): Promise<NavCapabilities> {
  const [showAnnouncements, showCompliance, showTraining, canAuthor] = await Promise.all([
    canAccessSection(user, "announcements"),
    canAccessSection(user, "compliance"),
    featureEnabled("training"),
    canAuthorFor(user),
  ]);
  return {
    isEditor: roleAtLeast(user.role, "editor"),
    isApprover: roleAtLeast(user.role, "approver"),
    isAdmin: user.role === "admin",
    showNewsletter: canUseNewsletter(user),
    showAnnouncements,
    showCompliance,
    showTraining,
    canAuthor,
  };
}

export function capAllowed(caps: NavCapabilities, cap: CapKey | null): boolean {
  return cap === null ? true : caps[cap];
}

/** Nav destinations this user may reach. */
export function allowedNavHrefs(caps: NavCapabilities): string[] {
  return NAV_ITEMS.filter((i) => capAllowed(caps, i.cap)).map((i) => i.href);
}

/**
 * The allow-list of command ids the palette may render. Computed server-side
 * so a gated action can't be surfaced — or invoked — from the client.
 */
export function allowedCommandIds(caps: NavCapabilities): string[] {
  return PALETTE_COMMANDS.filter((c) => capAllowed(caps, c.cap)).map((c) => c.id);
}
