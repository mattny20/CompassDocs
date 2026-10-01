import { Bell } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { listNotificationsFor, unreadNotificationCount } from "@/lib/db";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { NotificationsInbox } from "@/components/NotificationsInbox";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications" };

const PAGE = 50;

// The full inbox behind the bell (1.5.2): everything the dropdown shows,
// plus history. The bell caps at 30 rows with no way to the older ones.
export default async function NotificationsPage() {
  const user = await requireUser();
  const [rows, unread] = await Promise.all([
    listNotificationsFor(user.id, PAGE + 1),
    unreadNotificationCount(user.id),
  ]);
  const more = rows.length > PAGE;

  return (
    <PageContainer>
      <PageHeader
        icon={<Bell />}
        title="Notifications"
        subtitle="Mentions, comments, review requests and reminders — newest first."
      />
      <NotificationsInbox
        initial={more ? rows.slice(0, PAGE) : rows}
        initialMore={more}
        initialUnread={unread}
      />
    </PageContainer>
  );
}
