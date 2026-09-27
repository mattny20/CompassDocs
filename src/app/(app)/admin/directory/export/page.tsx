import { requireSettingsSection } from "@/lib/auth";
import { listFields, getListColumns, getGroupByDefault } from "@/lib/directory";
import { listExportPresets } from "@/lib/directory-export-config";
import { getExportRunLog } from "@/lib/directory-export-schedule";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { DirectoryExportPanel } from "@/components/directory-admin/DirectoryExportPanel";

export const dynamic = "force-dynamic";

export default async function DirectoryExportPage() {
  await requireSettingsSection("/admin/directory");
  const fields = await listFields();
  const [listColumns, groupBy, presets, smtp, runLog] = await Promise.all([
    getListColumns(fields),
    getGroupByDefault(fields),
    listExportPresets(fields),
    getSmtpConfig(),
    getExportRunLog(),
  ]);
  return <DirectoryExportPanel fields={fields} initialListColumns={listColumns} initialGroupBy={groupBy} initialPresets={presets} smtpConfigured={smtpConfigured(smtp)} runLog={runLog} />;
}
