import { requireSettingsSection } from "@/lib/auth";
import { ImportExport } from "@/components/ImportExport";
import { MigrateImport } from "@/components/MigrateImport";
import { listSpaces } from "@/lib/db";
import { SettingsPage } from "@/components/SettingsPage";
import { EVERY_SPACE_UNFILTERED } from "@/lib/space-scope";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  await requireSettingsSection("/admin/data");
  const spaces = await listSpaces(EVERY_SPACE_UNFILTERED);
  return (
    <SettingsPage href="/admin/data">
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Backup &amp; transfer</h2>
        <ImportExport />
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Migrate from another tool</h2>
        <MigrateImport spaces={spaces.map((s) => ({ id: s.id, name: s.name }))} />
      </section>
    </div>
    </SettingsPage>
  );
}
