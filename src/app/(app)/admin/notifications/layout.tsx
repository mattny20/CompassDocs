import { requireSettingsArea } from "@/lib/auth";
import { SettingsPage } from "@/components/SettingsPage";
import { SubNav } from "@/components/SubNav";

export const dynamic = "force-dynamic";

// One section, two pages — channels (webhooks, SMTP, chat) and the email
// templates: the header and the tab row are shared, so the templates page
// no longer hand-writes its own title and back link. Each page still
// enforces its own permission (the settings convention). The layout opens
// for any page's permission (1.19.1: Policies is notification.policy_read,
// so its holders reach it without the webhooks permission); the tab row
// shows only the pages the viewer may open.
export default async function NotificationsLayout({ children }: { children: React.ReactNode }) {
  await requireSettingsArea("/admin/notifications");
  return (
    <SettingsPage href="/admin/notifications">
      <SubNav label="Notification settings" section="/admin/notifications" />
      {children}
    </SettingsPage>
  );
}
