import "server-only";

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import type { PortalPageProps } from "@/components/compliance/use-portal";
import type { EvidencePageProps } from "@/components/compliance/Evidence";

/**
 * The guard and the props the portal's manager pages share (B4): the
 * Compliance section or the shell's not-found page, exactly as
 * /training/person answers; then whether the programme is licensed and
 * whether the viewer can open Settings → License, for the gate's button.
 */
export async function portalPageProps(): Promise<PortalPageProps> {
  const user = await requireUser();
  if (!(await canAccessSection(user, "compliance"))) notFound();
  const [licensed, canManageLicense] = await Promise.all([
    featureEnabled("policy_ack"),
    userHolds(user, "workspace.settings_read", { legacyMin: "admin" }),
  ]);
  return { licensed, canManageLicense };
}

/**
 * The Evidence page's guard (F2, 1.14.0): the section and compliance.export
 * (the hashes are evidence handles and every download carries personal
 * data), else the shell's not-found page as the other pages answer; then
 * the portal props plus whether the viewer may take a snapshot now
 * (compliance.program_manage, the POST's own gate).
 */
export async function evidencePageProps(): Promise<EvidencePageProps> {
  const user = await requireUser();
  if (!(await canAccessSection(user, "compliance"))) notFound();
  if (!(await userHolds(user, "compliance.export", { legacyMin: "admin" }))) notFound();
  const [licensed, canManageLicense, canManage] = await Promise.all([
    featureEnabled("policy_ack"),
    userHolds(user, "workspace.settings_read", { legacyMin: "admin" }),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
  ]);
  return { licensed, canManageLicense, canManage };
}

// The team view's rule (F4, 1.14.0) lives in lib/team-access, the one copy
// the team route, the mine route, the section layout (the Team tab) and the
// team page share; re-exported here so the layout and the page keep their
// import beside the other page guards.
export { teamViewAccess, teamViewAllowed } from "@/lib/team-access";
