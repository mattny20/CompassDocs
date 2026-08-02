import { requireSettingsSection } from "@/lib/auth";
import { listRolesWithCounts, listRoleAssignments, listGroups, listUsers, listSpaces } from "@/lib/db";
import { EVERY_SPACE_UNFILTERED } from "@/lib/space-scope";
import { legacyAuthzEnforcement } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/permissions";
import { RolesPanel } from "@/components/RolesPanel";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function RolesAdminPage() {
  await requireSettingsSection("/admin/roles");
  const [roles, assignments, users, groups, spaces] = await Promise.all([
    listRolesWithCounts(),
    listRoleAssignments(),
    listUsers(),
    listGroups(),
    // An admin granting a space-scoped role must be able to pick any space,
    // including private ones they are not a member of — this is the page where
    // that membership gets decided.
    listSpaces(EVERY_SPACE_UNFILTERED),
  ]);

  return (
    <SettingsPage href="/admin/roles">
      <RolesPanel
        roles={roles}
        assignments={assignments}
        permissions={PERMISSIONS as unknown as { key: string; label: string; description: string; scope: string; principal?: string }[]}
        users={users.map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role }))}
        groups={groups.map((g) => ({ id: g.id, name: g.name, member_count: g.member_count }))}
        spaces={spaces.map((s) => ({ id: s.id, name: s.name }))}
        legacyEnforcement={legacyAuthzEnforcement()}
      />
    </SettingsPage>
  );
}
