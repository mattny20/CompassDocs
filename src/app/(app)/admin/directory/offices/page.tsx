import { requireSettingsSection } from "@/lib/auth";
import { listFields, listPeople } from "@/lib/directory";
import { getOfficeConfig } from "@/lib/directory-offices-store";
import { officeKeyOf } from "@/lib/directory-offices";
import { DirectoryOfficesPanel } from "@/components/directory-admin/DirectoryOfficesPanel";

export const dynamic = "force-dynamic";

export default async function DirectoryOfficesPage() {
  await requireSettingsSection("/admin/directory");
  const [fields, people, config] = await Promise.all([listFields(), listPeople({ includeHidden: true }), getOfficeConfig()]);
  const officeField = fields.find((f) => f.key === "office");
  // Who is where, by the office as a profile names it — so the editor can
  // list every office that has people before anyone types it in.
  const counts = new Map<string, number>();
  for (const p of people) {
    const key = officeKeyOf(p.office, officeField);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    <DirectoryOfficesPanel
      initial={config}
      officeOptions={officeField?.options ?? []}
      seen={[...counts.entries()].map(([office, count]) => ({ office, count }))}
    />
  );
}
