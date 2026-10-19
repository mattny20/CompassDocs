import { PortalPolicies } from "@/components/compliance/PortalPolicies";
import { portalPageProps } from "../portal-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compliance · Policies" };

// Compliance › Policies (B4): request a read confirmation, and every
// policy's progress with its actions. Section holders only.

export default async function CompliancePoliciesPage() {
  const props = await portalPageProps();
  return <PortalPolicies {...props} />;
}
