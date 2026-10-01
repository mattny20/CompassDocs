import { AccountPage } from "@/components/AccountPage";
import { requireUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { PreferencesPanel } from "@/components/PreferencesPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Preferences" };

export default async function PreferencesPage() {
  const user = await requireUser();
  const settings = await getAppSettings();

  return (
    <AccountPage href="/account/preferences">
      <PreferencesPanel
        initialTheme={user.theme}
        initialScale={user.ui_scale}
        initialTimezone={user.timezone}
        initialDateFormat={user.date_format}
        workspaceTimezone={settings.timezone}
      />
    </AccountPage>
  );
}
