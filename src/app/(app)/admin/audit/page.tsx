import { listAuditLog, auditCategories } from "@/lib/audit";
import { getAppSettings } from "@/lib/settings-store";
import { AuditLog } from "@/components/AuditLog";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function AuditPage() {
  const [{ rows, total }, categories, settings] = await Promise.all([
    listAuditLog({ limit: PAGE_SIZE, offset: 0 }),
    auditCategories(),
    getAppSettings(),
  ]);
  return (
    <AuditLog
      initial={{ rows, total, categories, limit: PAGE_SIZE }}
      settings={settings}
    />
  );
}
