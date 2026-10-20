import { requireSettingsSection } from "@/lib/auth";
import { getColumnVisibility, listFields, listPeople } from "@/lib/directory";
import { eePresent } from "@/lib/ee";
import { DirectoryFieldsPanel, type HeadCandidate } from "@/components/directory-admin/DirectoryFieldsPanel";
import { ContactVisibilityPanel } from "@/components/directory-admin/ContactVisibilityPanel";
import type { ProviderKey } from "@/lib/identity-provider";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/directory", "Fields");

export default async function DirectoryFieldsPage() {
  await requireSettingsSection("/admin/directory");
  const [fields, columnVisibility, allPeople] = await Promise.all([listFields(), getColumnVisibility(), listPeople()]);
  // Who an option's Heads picker may name: the visible people, with the
  // columns the picker reads to say where each one sits (never a photo).
  const people: HeadCandidate[] = allPeople.map((p) => ({ id: p.id, name: p.name, title: p.title, department: p.department, office: p.office, custom: p.custom }));
  // Mapping editors are offered for the bundled providers; the community
  // build shows none and keeps every other control — options, group-by,
  // display — because none of them need a sync.
  const providers: ProviderKey[] = eePresent() ? ["microsoft", "google"] : [];
  return (
    <div className="space-y-6">
      <DirectoryFieldsPanel initialFields={fields} providers={providers} people={people} />
      <ContactVisibilityPanel initial={columnVisibility} />
    </div>
  );
}
