import { requireUser } from "@/lib/auth";
import { spaceScopeFor, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { listMyPolicies } from "@/lib/db";
import { LicenseGate } from "@/components/LicenseGate";
import { MyPolicies } from "@/components/MyPolicies";

export const dynamic = "force-dynamic";
export const metadata = { title: "My policies" };

// My policies (B4, 1.12.0): the section's first page, for everyone. What
// this person is asked to read and confirm, and where they stand on each.
// No redirect any more: a reader with nothing in scope sees the empty
// state, and the sidebar shows the section only to people with a policy to
// see (nav-capabilities). The rows come from the same query the API serves.

export default async function MyPoliciesPage() {
  const user = await requireUser();
  if (!(await featureEnabled("policy_ack"))) {
    // The gate's "Open License" button appears when the viewer can open
    // that page, resolved the same way as on the portal (STYLEGUIDE §Notices).
    return (
      <LicenseGate
        feature="My policies"
        entitlement="policy_ack"
        canManage={await userHolds(user, "workspace.settings_read", { legacyMin: "admin" })}
      />
    );
  }
  const rows = await listMyPolicies(user.id, await spaceScopeFor(user));
  return <MyPolicies rows={rows} />;
}
