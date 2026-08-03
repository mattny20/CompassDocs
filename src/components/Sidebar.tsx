// Server wrapper: fetches the sidebar's data and hands it to the client
// component, which owns the collapse/expand state (persisted per browser).

import {
  listSpaces,
  listActiveAnnouncementsFor,
  listDashboardNewslettersFor,
  unreadNotificationCount,
  listStatusProblems,
  countMyOpenTraining,
} from "@/lib/db";
import { spaceScopeFor } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { getAppSettings } from "@/lib/settings-store";
import type { NavCapabilities } from "@/lib/nav-capabilities";
import type { SessionUser } from "@/lib/types";
import { SidebarClient } from "./SidebarClient";

// `caps` comes from the layout, which already resolved it for the command
// palette. Recomputing here is how the sidebar and the palette used to be
// able to disagree about the same user.
export async function Sidebar({
  user,
  caps,
  reviewCount,
  trashCount,
}: {
  user: SessionUser;
  caps: NavCapabilities;
  reviewCount: number;
  trashCount: number;
}) {
  const scope = await spaceScopeFor(user);
  const [spaces, settings, announcements, freshNewsletters, unreadNotifications, statusProblems] =
    await Promise.all([
      listSpaces(scope),
      getAppSettings(),
      listActiveAnnouncementsFor(user.id),
      listDashboardNewslettersFor(user.id),
      unreadNotificationCount(user.id),
      listStatusProblems().catch(() => []),
    ]);

  return (
    <SidebarClient
      user={user}
      spaces={spaces.map((s) => ({ id: s.id, slug: s.slug, name: s.name, icon: s.icon }))}
      companyName={settings.company_name}
      logoUrl={settings.logo_url || undefined}
      reviewCount={reviewCount}
      trashCount={trashCount}
      announcementCount={announcements.length + freshNewsletters.length}
      unreadNotifications={unreadNotifications}
      statusProblemCount={statusProblems.length}
      showNewsletter={caps.showNewsletter}
      showAnnouncements={caps.showAnnouncements}
      showCompliance={caps.showCompliance}
      showTraining={caps.showTraining}
      trainingCount={caps.showTraining ? await countMyOpenTraining(user.id) : 0}
      isEditor={caps.isEditor}
      isApprover={caps.isApprover}
      isAdmin={caps.isAdmin}
      nestedPages={settings.nested_pages_enabled}
    />
  );
}
