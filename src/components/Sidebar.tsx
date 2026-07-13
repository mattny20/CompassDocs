// Server wrapper: fetches the sidebar's data and hands it to the client
// component, which owns the collapse/expand state (persisted per browser).

import { listSpaces } from "@/lib/db";
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
  const [spaces, settings] = await Promise.all([listSpaces(), getAppSettings()]);

  return (
    <SidebarClient
      user={user}
      spaces={spaces.map((s) => ({ id: s.id, slug: s.slug, name: s.name, icon: s.icon }))}
      companyName={settings.company_name}
      logoUrl={settings.logo_url || undefined}
      reviewCount={reviewCount}
      trashCount={trashCount}
      isEditor={roleAtLeast(user.role, "editor")}
      isApprover={roleAtLeast(user.role, "approver")}
      isAdmin={user.role === "admin"}
    />
  );
}
