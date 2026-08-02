import { requireSettingsSection } from "@/lib/auth";
import { listUsers, extraRolesByUser } from "@/lib/db";
import { UsersClient } from "@/components/UsersClient";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const admin = await requireSettingsSection("/admin/users");
  const [users, extraRoles] = await Promise.all([listUsers(), extraRolesByUser()]);
  return (
    <SettingsPage href="/admin/users">
      <UsersClient
        users={users}
        currentUserId={admin.id}
        extraRoles={Object.fromEntries(extraRoles)}
      />
    </SettingsPage>
  );
}
