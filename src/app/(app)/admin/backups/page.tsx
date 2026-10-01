import { requireSettingsSection } from "@/lib/auth";
import { listBackups } from "@/lib/backup";
import { destinationStatus } from "@/lib/backup-destinations";
import { getBackupDestState } from "@/lib/backup-config";
import { getAppSettings } from "@/lib/settings-store";
import { BackupsClient } from "@/components/BackupsClient";
import { BackupDestinations } from "@/components/BackupDestinations";
import { SettingsPage } from "@/components/SettingsPage";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/backups");

export default async function BackupsPage() {
  await requireSettingsSection("/admin/backups");
  const [backups, settings, destinations, destState] = await Promise.all([
    listBackups(),
    getAppSettings(),
    destinationStatus(),
    getBackupDestState(),
  ]);
  return (
    <SettingsPage href="/admin/backups">
    <div className="space-y-8">
      <BackupsClient backups={backups} destinations={destinations} settings={settings} />
      <BackupDestinations initial={destState} />
    </div>
    </SettingsPage>
  );
}
