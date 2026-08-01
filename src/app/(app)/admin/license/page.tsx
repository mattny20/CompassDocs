import { LicensePanel } from "@/components/LicensePanel";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

// The panel fetches its state from /api/admin/license on mount.
export default function LicensePage() {
  return <SettingsPage href="/admin/license"><LicensePanel /></SettingsPage>;
}
