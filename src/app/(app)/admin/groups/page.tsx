import { requireRole } from "@/lib/auth";
import { listGroups, listUsers } from "@/lib/db";
import { getDirectoryGraphConfig } from "@/lib/directory-config";
import { eePresent, featureEnabled } from "@/lib/ee";
import { GroupsPanel } from "@/components/GroupsPanel";

export const dynamic = "force-dynamic";

export default async function GroupsAdminPage() {
  await requireRole("admin");
  const [groups, users, bundled, licensed, cfg] = await Promise.all([
    listGroups(),
    listUsers(),
    Promise.resolve(eePresent()),
    featureEnabled("directory_sync"),
    getDirectoryGraphConfig(),
  ]);

  return (
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
  );
}
