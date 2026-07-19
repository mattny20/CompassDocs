import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { featureEnabled } from "@/lib/ee";
import { CompliancePanel } from "@/components/CompliancePanel";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

// Operational home for the compliance portal (main navigation). Admins plus
// anyone granted the Compliance section (Settings → Section access).

export default async function CompliancePage() {
  const user = await requireUser();
  if (!(await canAccessSection(user, "compliance"))) redirect("/");
  return (
    <PageContainer>
      <CompliancePanel licensed={await featureEnabled("policy_ack")} />
    </PageContainer>
  );
}
