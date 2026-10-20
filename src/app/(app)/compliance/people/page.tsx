import { PortalPeople } from "@/components/compliance/PortalPeople";
import { portalPageProps } from "../portal-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compliance · People" };

// Compliance › People (B4): each person's standing. Section holders only.

export default async function CompliancePeoplePage() {
  const props = await portalPageProps();
  return <PortalPeople {...props} />;
}
