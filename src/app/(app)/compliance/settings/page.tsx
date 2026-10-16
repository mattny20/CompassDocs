import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { LicenseGate } from "@/components/LicenseGate";
import { ProgramSettingsPanel } from "@/components/compliance/ProgramSettingsPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Program settings" };

// Program settings (E4): the defaults every policy inherits. Needs the
// Compliance section and compliance.program_manage, like the API behind it
// (F6's complianceGuard); anyone else gets the shell's not-found page. The
// back link is the plain one until the /compliance sub-navigation arrives
// with B4 in 1.11.1.

export default async function ComplianceSettingsPage() {
  const user = await requireUser();
  if (
    !(await canAccessSection(user, "compliance")) ||
    !(await userHolds(user, "compliance.program_manage", { legacyMin: "admin" }))
  ) {
    notFound();
  }
  const licensed = await featureEnabled("policy_ack");
  return (
    <PageContainer>
      <PageHeader
        icon={<Settings2 />}
        title="Program settings"
        subtitle="Defaults every policy inherits. A policy can override them on its own settings page."
        back={{ href: "/compliance", label: "Compliance" }}
      />
      {licensed ? (
        <ProgramSettingsPanel initial={await getComplianceSettings()} />
      ) : (
        <LicenseGate feature="Program settings" entitlement="policy_ack" canManage={user.role === "admin"} />
      )}
    </PageContainer>
  );
}
