import { requireUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { PreferencesPanel } from "@/components/PreferencesPanel";

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
  const user = await requireUser();
  const settings = await getAppSettings();

  return (
    <section>
      <h2 className="mb-1 font-semibold text-slate-900">Preferences</h2>
      <p className="mb-3 text-sm text-slate-500">
        Personal defaults — they override the workspace settings just for you.
      </p>
      <PreferencesPanel
        initialTheme={user.theme}
        initialWidth={user.page_width}
        initialTimezone={user.timezone}
        initialDateFormat={user.date_format}
        workspaceTimezone={settings.timezone}
      />
    </section>
  );
}
