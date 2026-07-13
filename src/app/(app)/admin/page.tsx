import { getSystemInfo } from "@/lib/system-info";
import { getAppSettings } from "@/lib/settings-store";
import { SystemPanel } from "@/components/SystemPanel";

export const dynamic = "force-dynamic";

export default async function SystemPage() {
  const [info, settings] = await Promise.all([getSystemInfo(), getAppSettings()]);
  return <SystemPanel info={info} settings={settings} />;
}
