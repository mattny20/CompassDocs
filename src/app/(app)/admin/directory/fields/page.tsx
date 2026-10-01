import { requireSettingsSection } from "@/lib/auth";
import { getColumnVisibility, listFields } from "@/lib/directory";
import { eePresent } from "@/lib/ee";
import { DirectoryFieldsPanel } from "@/components/directory-admin/DirectoryFieldsPanel";
import { ContactVisibilityPanel } from "@/components/directory-admin/ContactVisibilityPanel";
import type { ProviderKey } from "@/lib/identity-provider";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/directory", "Fields");

export default async function DirectoryFieldsPage() {
  await requireSettingsSection("/admin/directory");
  const [fields, columnVisibility] = await Promise.all([listFields(), getColumnVisibility()]);
  // Mapping editors are offered for the bundled providers; the community
  // build shows none and keeps every other control — options, group-by,
  // display — because none of them need a sync.
  const providers: ProviderKey[] = eePresent() ? ["microsoft", "google"] : [];
  return (
    <div className="space-y-6">
      <DirectoryFieldsPanel initialFields={fields} providers={providers} />
      <ContactVisibilityPanel initial={columnVisibility} />
    </div>
  );
}
