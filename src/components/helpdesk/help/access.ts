import "server-only";

// Who may use Get help (1.19.0, Enterprise "helpdesk"), resolved once per
// request: the page guards, the sidebar entry, the palette and the four
// CompassDocs triggers (report a page, ask about a policy, request access
// to a space, a broken link) all ask the same two questions, the licence
// and helpdesk.request, so a trigger can never offer a request the API
// would refuse. Every API route re-checks; this is the UX filter.

import { cache } from "react";
import { notFound } from "next/navigation";
import { userHolds } from "@/lib/access";
import { helpdeskCapabilities } from "@/lib/helpdesk/access";
import { getCurrentUser, requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/types";

export interface HelpAccess {
  /** The build and the licence cover the helpdesk. */
  licensed: boolean;
  /** Licensed and holds helpdesk.request: Get help and the triggers. */
  canRequest: boolean;
  /** Licensed and has a reason to open the desk (agent, agent_all, admin or reports): the Desk entry. */
  isAgent: boolean;
  /** May open Settings → License (the licence gate's button). */
  canManageLicense: boolean;
}

async function resolve(user: Pick<SessionUser, "id" | "role">): Promise<HelpAccess> {
  const [caps, canManageLicense] = await Promise.all([
    helpdeskCapabilities(user),
    userHolds(user, "workspace.settings_read", { legacyMin: "admin" }),
  ]);
  return {
    licensed: caps.licensed,
    canRequest: caps.licensed && caps.request,
    // The desk is where agents work and where admins configure and read reports.
    isAgent: caps.licensed && (caps.agent || caps.admin || caps.reports),
    canManageLicense,
  };
}

/** Per request (keyed on primitives, so it really is shared): the layout, the page and a trigger share one answer. */
const helpAccessFor = cache((id: number, role: SessionUser["role"]) => resolve({ id, role }));

export async function helpAccess(user: Pick<SessionUser, "id" | "role">): Promise<HelpAccess> {
  return helpAccessFor(user.id, user.role);
}

/** For a trigger that has no user in hand (a server component deep in a page). */
export async function currentUserCanRequestHelp(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  return (await helpAccess(user)).canRequest;
}

/**
 * The guard every /help page shares: unlicensed renders the licence gate
 * (the page shows it under its own header), licensed without
 * helpdesk.request is the shell's not-found page.
 */
export async function helpPageGuard(): Promise<{ user: SessionUser; access: HelpAccess }> {
  const user = await requireUser();
  const access = await helpAccess(user);
  if (access.licensed && !access.canRequest) notFound();
  return { user, access };
}
