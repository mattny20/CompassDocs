import { listAuditLog, auditCategories } from "@/lib/audit";
import { getAppSettings } from "@/lib/settings-store";
import { featureEnabled } from "@/lib/ee";
import { AuditLog } from "@/components/AuditLog";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function AuditPage() {
  const [{ rows, total }, categories, settings, exportEnabled] = await Promise.all([
    listAuditLog({ limit: PAGE_SIZE, offset: 0 }),
    auditCategories(),
    getAppSettings(),
    featureEnabled("audit_export"),
  ]);
  return (
    <SettingsPage href="/admin/audit">
    <AuditLog
      initial={{ rows, total, categories, limit: PAGE_SIZE }}
      settings={settings}
      exportEnabled={exportEnabled}
    />
    </SettingsPage>
  );
}
