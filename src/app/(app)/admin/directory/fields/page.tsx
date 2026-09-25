import { requireSettingsSection } from "@/lib/auth";
import { listFields } from "@/lib/directory";
import { eePresent } from "@/lib/ee";
import { DirectoryFieldsPanel } from "@/components/directory-admin/DirectoryFieldsPanel";
import type { ProviderKey } from "@/lib/identity-provider";

export const dynamic = "force-dynamic";

export default async function DirectoryFieldsPage() {
  await requireSettingsSection("/admin/directory");
  const fields = await listFields();
  // Mapping editors are offered for the bundled providers; the community
  // build shows none and keeps every other control — options, group-by,
  // display — because none of them need a sync.
  const providers: ProviderKey[] = eePresent() ? ["microsoft", "google"] : [];
  return <DirectoryFieldsPanel initialFields={fields} providers={providers} />;
}
