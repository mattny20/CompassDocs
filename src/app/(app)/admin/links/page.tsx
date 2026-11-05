import { requireSettingsSection } from "@/lib/auth";
import {
  listLinkCategories,
  listLinksVisibleTo,
  listAllLinkGroups,
  listGroups,
  linkClickCounts,
} from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { LinksAdmin } from "@/components/LinksAdmin";
import { SettingsPage } from "@/components/SettingsPage";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/links");

export default async function LinksAdminPage() {
  await requireSettingsSection("/admin/links");
  const [categories, links, linkGroups, groups, settings, clicks] = await Promise.all([
    listLinkCategories(),
    listLinksVisibleTo("all"),
    listAllLinkGroups(),
    listGroups(),
    getAppSettings(),
    linkClickCounts(30),
  ]);

  return (
    <SettingsPage href="/admin/links">
    <LinksAdmin
      initialCategories={categories}
      initialLinks={links.map((l) => ({ ...l, group_ids: linkGroups[l.id] ?? [], clicks: clicks[l.id] ?? 0 }))}
      groups={groups.map((g) => ({ id: g.id, name: g.name }))}
      brandLogo={settings.logo_url || ""}
    />
    </SettingsPage>
  );
}
