import { requireRole } from "@/lib/auth";
import { featureEnabled } from "@/lib/ee";
import { CompliancePanel } from "@/components/CompliancePanel";

export const dynamic = "force-dynamic";

export default async function CompliancePage() {
  await requireRole("admin");
  return <CompliancePanel licensed={await featureEnabled("policy_ack")} />;
}
