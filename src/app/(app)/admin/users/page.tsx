import { requireSettingsSection } from "@/lib/auth";
import { listUsers, extraRolesByUser, attestationCountsByUser } from "@/lib/db";
import { featureEnabled } from "@/lib/ee";
import { UsersClient } from "@/components/UsersClient";
import { SettingsPage } from "@/components/SettingsPage";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/users");

export default async function UsersPage() {
  const admin = await requireSettingsSection("/admin/users");
  const [users, extraRoles, attestations, canAnonymise] = await Promise.all([
    listUsers(),
    extraRolesByUser(),
    attestationCountsByUser(),
    canAnonymiseCompliance(admin.id),
  ]);
  return (
    <SettingsPage href="/admin/users">
      <UsersClient
        users={users}
        currentUserId={admin.id}
        extraRoles={Object.fromEntries(extraRoles)}
        attestations={Object.fromEntries(attestations)}
        canAnonymise={canAnonymise}
      />
    </SettingsPage>
  );
}

/** The erasure action needs the licence plus both rights the API checks. */
async function canAnonymiseCompliance(userId: number): Promise<boolean> {
  if (!(await featureEnabled("policy_ack"))) return false;
  const { grantsFor, admits, legacyAuthzEnforcement } = await import("@/lib/authz");
  if (legacyAuthzEnforcement()) return true;
  const grants = await grantsFor(userId);
  return admits(grants, "user.delete") && admits(grants, "compliance.program_manage");
}
