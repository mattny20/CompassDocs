import "server-only";

// What this user is allowed to see in navigation, resolved once per request.
// The sidebar and the command palette both consume it, so the two can't drift
// — and the palette never has to evaluate an entitlement client-side (it
// couldn't: entitlements and space grants aren't on the session).

import { canAccessSection } from "./section-access";
import { canUseNewsletter } from "./newsletter-access";
import { featureEnabled } from "./ee";
import { canSeeDrafts, editableScopeFor, spaceScopeFor, userHolds } from "./access";
import { hasPolicyInScope } from "./db";
import type { SessionUser } from "./types";
import type { CapKey } from "./nav-items";
import { NAV_ITEMS } from "./nav-items";
import { PALETTE_COMMANDS } from "./palette-commands";

// The names are historical — they were role rungs until 1.0, and the nav item
// definitions key off them — but each is now a permission question.
export interface NavCapabilities {
  /** Sees drafts: the trash, draft badges, the staff-only nav rows. */
  isEditor: boolean;
  /** Reviews queued changes. */
  isApprover: boolean;
  isAdmin: boolean;
  showNewsletter: boolean;
  showAnnouncements: boolean;
  showCompliance: boolean;
  showTraining: boolean;
  /** Has at least one space they may write in. */
  canAuthor: boolean;
}

/**
 * True when the user has somewhere to put a new document. Computed rather than
 * assumed: offering "New document" to someone with no grants walks them into
 * the "No editable spaces" dead end.
 *
 * No separate rung check any more — editableScopeFor already returns nothing
 * for a user with no authoring rights, and "all" for one holding
 * space.author_all. Asking twice was how the two could disagree.
 */
async function canAuthorFor(user: SessionUser): Promise<boolean> {
  const scope = await editableScopeFor(user);
  return scope === "all" || scope.length > 0;
}

/**
 * Compliance in the nav (B4, 1.12.0): the licence first, then either the
 * portal's section grant or a policy the person can be asked to confirm.
 * The Training pattern would show it to everyone licensed; this one keeps
 * it off the sidebar of someone whose workspace keeps every policy in
 * spaces they cannot see, and it stays once everything is confirmed (the
 * EXISTS asks whether a policy is in scope, not whether one is pending).
 */
async function showComplianceFor(user: SessionUser): Promise<boolean> {
  if (!(await featureEnabled("policy_ack"))) return false;
  if (await canAccessSection(user, "compliance")) return true;
  return hasPolicyInScope(user.id, await spaceScopeFor(user));
}

export async function navCapabilities(user: SessionUser): Promise<NavCapabilities> {
  const [showAnnouncements, showCompliance, showTraining, canAuthor, isEditor, isApprover] =
    await Promise.all([
      canAccessSection(user, "announcements"),
      showComplianceFor(user),
      featureEnabled("training"),
      canAuthorFor(user),
      canSeeDrafts(user),
      userHolds(user, "change_request.read", { legacyMin: "approver" }),
    ]);
  return {
    isEditor,
    isApprover,
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
