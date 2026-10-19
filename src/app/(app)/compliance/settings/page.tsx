import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { LicenseGate } from "@/components/LicenseGate";
import { ProgramSettingsPanel } from "@/components/compliance/ProgramSettingsPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Program settings" };

// Program settings (E4): the defaults every policy inherits. Needs the
// Compliance section and compliance.program_manage, like the API behind it
// (F6's complianceGuard); anyone else gets the shell's not-found page. The
// header and the Settings tab are the section layout's since B4 (1.12.0);
// the page keeps its one-sentence description above the cards.

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
    <>
      <p className="mb-4 text-sm text-slate-500">
        Defaults every policy inherits. A policy can choose differently in its Read confirmation popover.
      </p>
      {licensed ? (
        <ProgramSettingsPanel initial={await getComplianceSettings()} />
      ) : (
        // The gate's "Open License" button appears when the viewer can open
        // that page, resolved the same way as on the portal (STYLEGUIDE §Notices).
        <LicenseGate
          feature="Program settings"
          entitlement="policy_ack"
          canManage={await userHolds(user, "workspace.settings_read", { legacyMin: "admin" })}
        />
      )}
    </>
  );
}
