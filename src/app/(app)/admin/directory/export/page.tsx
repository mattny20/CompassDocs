import { requireSettingsSection } from "@/lib/auth";
import { listFields, getListColumns, getGroupByDefault } from "@/lib/directory";
import { listExportPresets } from "@/lib/directory-export-config";
import { DirectoryExportPanel } from "@/components/directory-admin/DirectoryExportPanel";

export const dynamic = "force-dynamic";

export default async function DirectoryExportPage() {
  await requireSettingsSection("/admin/directory");
  const fields = await listFields();
  const [listColumns, groupBy, presets] = await Promise.all([
    getListColumns(fields),
    getGroupByDefault(fields),
    listExportPresets(fields),
  ]);
  return <DirectoryExportPanel fields={fields} initialListColumns={listColumns} initialGroupBy={groupBy} initialPresets={presets} />;
}
