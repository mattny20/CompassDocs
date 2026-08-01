import { ImportExport } from "@/components/ImportExport";
import { MigrateImport } from "@/components/MigrateImport";
import { listSpaces } from "@/lib/db";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  const spaces = await listSpaces();
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
