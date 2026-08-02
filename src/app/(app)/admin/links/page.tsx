import { requireSettingsSection } from "@/lib/auth";
import { listLinkCategories, listLinksVisibleTo, listAllLinkGroups, listGroups } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { LinksAdmin } from "@/components/LinksAdmin";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function LinksAdminPage() {
  await requireSettingsSection("/admin/links");
  const [categories, links, linkGroups, groups, settings] = await Promise.all([
    listLinkCategories(),
    listLinksVisibleTo("all"),
    listAllLinkGroups(),
    listGroups(),
    getAppSettings(),
  ]);

  return (
    <SettingsPage href="/admin/links">
    <LinksAdmin
      initialCategories={categories}
      initialLinks={links.map((l) => ({ ...l, group_ids: linkGroups[l.id] ?? [] }))}
      groups={groups.map((g) => ({ id: g.id, name: g.name }))}
      brandLogo={settings.logo_url || ""}
    />
    </SettingsPage>
  );
}
