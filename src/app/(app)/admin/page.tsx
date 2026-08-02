import { requireSettingsSection } from "@/lib/auth";
import { getSystemInfo } from "@/lib/system-info";
import { getAppSettings } from "@/lib/settings-store";
import { runDiagnostics } from "@/lib/diagnostics";
import { SystemPanel } from "@/components/SystemPanel";
import { UpdatePanel } from "@/components/UpdatePanel";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function SystemPage() {
  await requireSettingsSection("/admin");
  const [info, settings, checks] = await Promise.all([
    getSystemInfo(),
    getAppSettings(),
    runDiagnostics(),
  ]);
  return (
    <SettingsPage href="/admin">
    <div className="space-y-4">
      <UpdatePanel />
      <DiagnosticsPanel initial={checks} />
      <SystemPanel info={info} settings={settings} />
    </div>
    </SettingsPage>
  );
}
