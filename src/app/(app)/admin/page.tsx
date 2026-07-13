import { getSystemInfo } from "@/lib/system-info";
import { getAppSettings } from "@/lib/settings-store";
import { SystemPanel } from "@/components/SystemPanel";
import { UpdatePanel } from "@/components/UpdatePanel";

export const dynamic = "force-dynamic";

export default async function SystemPage() {
  const [info, settings] = await Promise.all([getSystemInfo(), getAppSettings()]);
  return (
    <div className="space-y-4">
      <UpdatePanel />
      <SystemPanel info={info} settings={settings} />
    </div>
  );
}
