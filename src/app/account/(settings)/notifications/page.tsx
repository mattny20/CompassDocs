import { requireUser } from "@/lib/auth";
import { getUserById, listSubscriptionsForUser, getWeeklyDigest } from "@/lib/db";
import { NotificationMatrix } from "@/components/NotificationMatrix";
import { NotificationsPanel } from "@/components/NotificationsPanel";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await requireUser();
  const [me, subs, digest] = await Promise.all([
    getUserById(user.id),
    listSubscriptionsForUser(user.id),
    getWeeklyDigest(user.id),
  ]);

  return (
    <section>
      <h2 className="mb-1 font-semibold text-slate-900">Notifications</h2>
      <p className="mb-3 text-sm text-slate-500">
        Choose what reaches you, and where — the bell inbox, email, or a chat webhook.
      </p>
      <div className="space-y-4">
        <NotificationMatrix
          initial={me?.notify_prefs ?? {}}
          webhookConfigured={Boolean(me?.notify_webhook_url)}
        />
        <NotificationsPanel
          initialEnabled={me?.email_notifications === 1}
          initialDigest={digest}
          email={me?.email ?? ""}
          initialSubs={subs}
          initialWebhook={me?.notify_webhook_url ?? ""}
        />
      </div>
    </section>
  );
}
