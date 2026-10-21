import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { LicenseGate } from "@/components/LicenseGate";
import { TeamPolicies } from "@/components/compliance/TeamPolicies";
import { teamViewAllowed } from "../portal-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compliance · Team" };

// Compliance › Team (F4, 1.14.0): where the groups this person leads stand
// on the policies that ask their members, the policy twin of /training/team.
// The guard is the route's rule (teamViewAllowed): leading a group when
// Program settings let leads see policy standing, or compliance.team_read;
// anyone else gets the shell's not-found page, as /training/team does. The
// section header and the tab row are the layout's; the licence gate is the
// same one the other section pages show.

export default async function ComplianceTeamPage() {
  const user = await requireUser();
  if (!(await teamViewAllowed(user.id))) notFound();
  if (!(await featureEnabled("policy_ack"))) {
    return (
      <LicenseGate
        feature="Your team's policies"
        entitlement="policy_ack"
        canManage={await userHolds(user, "workspace.settings_read", { legacyMin: "admin" })}
      />
    );
  }
  return <TeamPolicies />;
}
