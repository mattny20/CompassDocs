import { listBackups } from "@/lib/backup";
import { destinationStatus } from "@/lib/backup-destinations";
import { getAppSettings } from "@/lib/settings-store";
import { BackupsClient } from "@/components/BackupsClient";

export const dynamic = "force-dynamic";

export default async function BackupsPage() {
  const [backups, settings] = await Promise.all([listBackups(), getAppSettings()]);
  return <BackupsClient backups={backups} destinations={destinationStatus()} settings={settings} />;
}
