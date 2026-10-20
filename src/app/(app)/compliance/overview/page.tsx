import { PortalOverview } from "@/components/compliance/PortalOverview";
import { portalPageProps } from "../portal-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compliance · Overview" };

// Compliance › Overview (B4): the programme's tiles. Section holders only.

export default async function ComplianceOverviewPage() {
  const props = await portalPageProps();
  return <PortalOverview {...props} />;
}
