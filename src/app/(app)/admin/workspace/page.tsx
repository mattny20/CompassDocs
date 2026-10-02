import { requireSettingsSection } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { WorkspaceSettings } from "@/components/WorkspaceSettings";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/workspace", "Branding");

export default async function WorkspaceBrandingPage() {
  await requireSettingsSection("/admin/workspace");
  const settings = await getAppSettings();
  return <WorkspaceSettings initial={settings} scope="branding" />;
}
