import { requireSettingsSection } from "@/lib/auth";
import { listAuditLog, auditCategories } from "@/lib/audit";
import { featureEnabled } from "@/lib/ee";
import { AuditLog } from "@/components/AuditLog";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function AuditPage() {
  await requireSettingsSection("/admin/audit");
  const [{ rows, total }, categories, exportEnabled] = await Promise.all([
    listAuditLog({ limit: PAGE_SIZE, offset: 0 }),
    auditCategories(),
    featureEnabled("audit_export"),
  ]);
  return (
    <SettingsPage href="/admin/audit">
    <AuditLog
      initial={{ rows, total, categories, limit: PAGE_SIZE }}
      exportEnabled={exportEnabled}
    />
    </SettingsPage>
  );
}
