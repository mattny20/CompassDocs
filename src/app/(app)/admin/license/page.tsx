import { requireSettingsSection } from "@/lib/auth";
import { LicensePanel } from "@/components/LicensePanel";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

// The panel fetches its state from /api/admin/license on mount.
export default async function LicensePage() {
  await requireSettingsSection("/admin/license");
  return <SettingsPage href="/admin/license"><LicensePanel /></SettingsPage>;
}
