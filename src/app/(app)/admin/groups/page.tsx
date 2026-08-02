import { requireSettingsSection } from "@/lib/auth";
import { listGroups, listUsers } from "@/lib/db";
import { getDirectoryGraphConfig } from "@/lib/directory-config";
import { eePresent, featureEnabled } from "@/lib/ee";
import { GroupsPanel } from "@/components/GroupsPanel";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function GroupsAdminPage() {
  await requireSettingsSection("/admin/groups");
  const [groups, users, bundled, licensed, cfg] = await Promise.all([
    listGroups(),
    listUsers(),
    Promise.resolve(eePresent()),
    featureEnabled("directory_sync"),
    getDirectoryGraphConfig(),
  ]);

  return (
    <SettingsPage href="/admin/groups">
    <GroupsPanel
      initial={groups}
      users={users.map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        email: u.email,
        role: u.role,
      }))}
      entra={{
        bundled,
        licensed,
        configured: Boolean(cfg.tenant && cfg.clientId && cfg.clientSecret),
      }}
    />
    </SettingsPage>
  );
}
