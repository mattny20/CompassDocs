import { requireSettingsSection } from "@/lib/auth";
import { SettingsPage } from "@/components/SettingsPage";
import { SubNav } from "@/components/SubNav";

export const dynamic = "force-dynamic";

// One section, two pages — channels (webhooks, SMTP, chat) and the email
// templates: the header and the tab row are shared, so the templates page
// no longer hand-writes its own title and back link. Each page still
// enforces its own permission (the settings convention).
export default async function NotificationsLayout({ children }: { children: React.ReactNode }) {
  await requireSettingsSection("/admin/notifications");
  return (
    <SettingsPage href="/admin/notifications">
      <SubNav label="Notification settings" section="/admin/notifications" />
      {children}
    </SettingsPage>
  );
}
