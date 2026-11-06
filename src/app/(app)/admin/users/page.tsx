import { requireSettingsSection } from "@/lib/auth";
import { listUsers, extraRolesByUser, attestationCountsByUser } from "@/lib/db";
import { featureEnabled } from "@/lib/ee";
import { canAccessSection } from "@/lib/section-access";
import { UsersClient } from "@/components/UsersClient";
import { SettingsPage } from "@/components/SettingsPage";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/users");

export default async function UsersPage() {
  const admin = await requireSettingsSection("/admin/users");
  const [users, extraRoles, attestations, canAnonymise, recordLinks, canExportPersonalData] = await Promise.all([
    listUsers(),
    extraRolesByUser(),
    attestationCountsByUser(),
    canAnonymiseCompliance(admin.id),
    canOpenRecords(admin),
    canExportPersonal(admin),
  ]);
  return (
    <SettingsPage href="/admin/users">
      <UsersClient
        users={users}
        currentUserId={admin.id}
        extraRoles={Object.fromEntries(extraRoles)}
        attestations={Object.fromEntries(attestations)}
        canAnonymise={canAnonymise}
        recordLinks={recordLinks}
        canExportPersonalData={canExportPersonalData}
      />
    </SettingsPage>
  );
}

/**
 * The "Compliance record" link on each row (F3, 1.14.0): the licence plus
 * the Compliance section, which is what opens any person's record; without
 * the section the record page answers not-found, so the link stays off.
 */
async function canOpenRecords(admin: Parameters<typeof canAccessSection>[0]): Promise<boolean> {
  if (!(await featureEnabled("policy_ack"))) return false;
  return canAccessSection(admin, "compliance");
}

/** The erasure action needs the licence plus both rights the API checks. */
async function canAnonymiseCompliance(userId: number): Promise<boolean> {
  if (!(await featureEnabled("policy_ack"))) return false;
  const { grantsFor, admits, legacyAuthzEnforcement } = await import("@/lib/authz");
  if (legacyAuthzEnforcement()) return true;
  const grants = await grantsFor(userId);
  return admits(grants, "user.delete") && admits(grants, "compliance.program_manage");
}

/**
 * "Download personal data" (1.19.1): the right GET
 * /api/admin/users/[id]/personal-data checks, user.delete (the right that
 * handles a person's erasure).
 */
async function canExportPersonal(admin: { id: number; role: string }): Promise<boolean> {
  const { grantsFor, admits, legacyAuthzEnforcement } = await import("@/lib/authz");
  // The legacy ladder: the route's apiGuard("admin", …) admits admins only.
  if (legacyAuthzEnforcement()) return admin.role === "admin";
  return admits(await grantsFor(admin.id), "user.delete");
}
