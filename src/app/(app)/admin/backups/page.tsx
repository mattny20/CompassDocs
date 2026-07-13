import { listBackups } from "@/lib/backup";
import { destinationStatus } from "@/lib/backup-destinations";
import { getBackupDestState } from "@/lib/backup-config";
import { getAppSettings } from "@/lib/settings-store";
import { BackupsClient } from "@/components/BackupsClient";
import { BackupDestinations } from "@/components/BackupDestinations";

export const dynamic = "force-dynamic";

export default async function BackupsPage() {
  const [backups, settings, destinations, destState] = await Promise.all([
    listBackups(),
    getAppSettings(),
    destinationStatus(),
    getBackupDestState(),
  ]);
  return (
    <div className="space-y-8">
      <BackupsClient backups={backups} destinations={destinations} settings={settings} />
      <BackupDestinations initial={destState} />
    </div>
  );
}
