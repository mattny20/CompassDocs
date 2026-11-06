import { AccountPage } from "@/components/AccountPage";
import { requireUser } from "@/lib/auth";
import { getUserById, listSubscriptionsForUser, getWeeklyDigest } from "@/lib/db";
import { featureEnabled } from "@/lib/ee";
import { getNotifyPolicy, getUserNotifyPrefs, policyView } from "@/lib/notify-policy";
import { NOTIFY_SECTIONS, NOTIFY_SECTION_INFO, emptyPrefs, type NotifySection } from "@/lib/notify-policy-shared";
import { NotificationPreferences } from "@/components/notify-prefs/NotificationPreferences";
import { NotificationsPanel } from "@/components/NotificationsPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notification settings" };

// 1.19.0: the full preferences matrix (lib/notify-policy) in place of the
// per-kind grid; the chat webhook and the subscribed spaces stay below.
// The subscription-email and weekly-digest switches are now rows of the
// Documents and comments card, so the panel hides its own copies.
export default async function NotificationsPage() {
  const user = await requireUser();
  const [me, subs, digest, mine, policy, ack, training, helpdesk] = await Promise.all([
    getUserById(user.id),
    listSubscriptionsForUser(user.id),
    getWeeklyDigest(user.id),
    getUserNotifyPrefs(user.id),
    getNotifyPolicy(),
    featureEnabled("policy_ack"),
    featureEnabled("training"),
    featureEnabled("helpdesk"),
  ]);
  const licensed: Record<string, boolean> = { policy_ack: ack, training, helpdesk };
  const sections = NOTIFY_SECTIONS.filter((s) => {
    const info = NOTIFY_SECTION_INFO[s];
    return info.personal && (!info.feature || licensed[info.feature]);
  }) as NotifySection[];
  let deskHref: string | null = null;
  if (helpdesk) {
    const { isAgent } = await import("@/lib/helpdesk/access");
    if (await isAgent(user).catch(() => false)) deskHref = "/desk/settings/notifications";
  }

  return (
    <AccountPage href="/account/notifications">
      <div className="space-y-4">
        <NotificationPreferences
          initial={mine?.prefs ?? emptyPrefs()}
          policy={policyView(policy)}
          sections={sections}
          webhookConfigured={Boolean(me?.notify_webhook_url)}
          timeZone={mine?.timeZone ?? "UTC"}
          deskHref={deskHref}
        />
        <NotificationsPanel
          emailSwitches={false}
          initialEnabled={me?.email_notifications === 1}
          initialDigest={digest}
          email={me?.email ?? ""}
          initialSubs={subs}
          initialWebhook={me?.notify_webhook_url ?? ""}
        />
      </div>
    </AccountPage>
  );
}
