import { requirePermission } from "@/lib/auth";
import { admits, grantsFor } from "@/lib/authz";
import { featureEnabled } from "@/lib/ee";
import { getNotifyPolicy } from "@/lib/notify-policy";
import { settingsMetadata } from "@/lib/settings-sections";
import { NotificationPolicyPanel } from "@/components/notify-prefs/NotificationPolicyPanel";

export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/notifications", "Policies");

// Settings → Notifications → Policies (1.19.0): the workspace notification
// policy (lib/notify-policy). Sections for unlicensed features stay on the
// page with the Enterprise badge, so a policy can be set before they are on.
// Gated like its API (api/admin/notifications/policy): notification.policy_read
// opens it, notification.policy_manage makes it editable.
export default async function NotificationPoliciesPage() {
  const user = await requirePermission("admin", "notification.policy_read");
  const [policy, ack, training, helpdesk, grants] = await Promise.all([
    getNotifyPolicy(),
    featureEnabled("policy_ack"),
    featureEnabled("training"),
    featureEnabled("helpdesk"),
    grantsFor(user.id),
  ]);
  const canManage = admits(grants, "notification.policy_manage");
  const licensed = [ack && "policy_ack", training && "training", helpdesk && "helpdesk"].filter(Boolean) as string[];
  return <NotificationPolicyPanel initial={policy} licensed={licensed} canManage={canManage} />;
}
