import "server-only";

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import type { PortalPageProps } from "@/components/compliance/use-portal";

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
