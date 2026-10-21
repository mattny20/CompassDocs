import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { listGroups, listUsers } from "@/lib/db";
import { PolicySets } from "@/components/compliance/PolicySets";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compliance · Sets" };

// Compliance › Sets (D3, 1.14.0): policy sets, assigned to people, groups
// or everyone as one unit and to every new joiner when they auto-assign.
// The guard is the section's (compliance.program_read opens the portal's
// pages; anyone else gets the shell's not-found page, as /training/person
// does); compliance.program_manage, resolved here, is what lets the page
// create, edit, assign, deactivate and delete, exactly as the API behind
// it decides. The pickers' options (every active account, every group)
// load only for a viewer who can act, the way the policy Settings tab
// loads them.

/** The directory a group came from, as the picker's sublabel (the Settings tab's words). */
function groupSource(source: string): string {
  if (source === "entra") return "Entra";
  if (source === "google") return "Google";
  return "Manual";
}

export default async function ComplianceSetsPage() {
  const user = await requireUser();
  if (!(await canAccessSection(user, "compliance"))) notFound();
  const [licensed, canManageLicense, canManage] = await Promise.all([
    featureEnabled("policy_ack"),
    userHolds(user, "workspace.settings_read", { legacyMin: "admin" }),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
  ]);
  const [groups, users] = canManage && licensed ? await Promise.all([listGroups(), listUsers()]) : [[], []];
  return (
    <PolicySets
      licensed={licensed}
      canManageLicense={canManageLicense}
      canManage={canManage}
      people={users.filter((u) => u.status === "active").map((u) => ({ id: u.id, label: u.name || u.username, sublabel: u.username }))}
      groups={groups.map((g) => ({ id: g.id, label: g.name, sublabel: groupSource(g.source) }))}
    />
  );
}
