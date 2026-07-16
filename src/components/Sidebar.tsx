// Server wrapper: fetches the sidebar's data and hands it to the client
// component, which owns the collapse/expand state (persisted per browser).

import { listSpaces, listActiveAnnouncementsFor } from "@/lib/db";
import { spaceScopeFor } from "@/lib/access";
import { canUseNewsletter } from "@/lib/newsletter-access";
import { getAppSettings } from "@/lib/settings-store";
import { roleAtLeast } from "@/lib/types";
import type { SessionUser } from "@/lib/types";
import { SidebarClient } from "./SidebarClient";

export async function Sidebar({
  user,
  reviewCount,
  trashCount,
}: {
  user: SessionUser;
  reviewCount: number;
  trashCount: number;
}) {
  const scope = await spaceScopeFor(user);
  const [spaces, settings, announcements] = await Promise.all([
    listSpaces(scope),
    getAppSettings(),
    listActiveAnnouncementsFor(user.id),
  ]);

  return (
    <SidebarClient
      user={user}
      spaces={spaces.map((s) => ({ id: s.id, slug: s.slug, name: s.name, icon: s.icon }))}
      companyName={settings.company_name}
      logoUrl={settings.logo_url || undefined}
      reviewCount={reviewCount}
      trashCount={trashCount}
      announcementCount={announcements.length}
      showNewsletter={canUseNewsletter(user)}
      isEditor={roleAtLeast(user.role, "editor")}
      isApprover={roleAtLeast(user.role, "approver")}
      isAdmin={user.role === "admin"}
    />
  );
}
