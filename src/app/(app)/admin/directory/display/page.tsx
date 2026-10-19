import { requireSettingsSection } from "@/lib/auth";
import { listFields, getListColumns, getGroupByDefault, getNameSortDefault } from "@/lib/directory";
import { DirectoryDisplayPanel } from "@/components/directory-admin/DirectoryDisplayPanel";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/directory", "Display");

export default async function DirectoryDisplayPage() {
  await requireSettingsSection("/admin/directory");
  const fields = await listFields();
  const [listColumns, groupBy, nameSort] = await Promise.all([getListColumns(fields), getGroupByDefault(fields), getNameSortDefault()]);
  return <DirectoryDisplayPanel fields={fields} initialListColumns={listColumns} initialGroupBy={groupBy} initialNameSort={nameSort} />;
}
