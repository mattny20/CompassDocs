import { BookUser } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { listPeople, listFields, getListColumns, getGroupByDefault } from "@/lib/directory";
import { listExportPresets } from "@/lib/directory-export-config";
import { cellValue, columnLabel } from "@/lib/directory-display";
import { DirectoryClient } from "@/components/DirectoryClient";
import { PageContainer } from "@/components/PageWidth";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DirectoryPage() {
  const user = await requireUser();
  const fields = await listFields();
  const [people, defaultColumns, defaultGroupBy, presets, settings] = await Promise.all([
    listPeople(),
    getListColumns(fields),
    getGroupByDefault(fields),
    listExportPresets(fields),
    getAppSettings(),
  ]);

  // Browser print (Export → Print…) still renders the default preset's columns
  // as a plain table; the PDF export is the first-class path.
  const printPreset = presets.find((p) => p.is_default) ?? presets[0];
  const printable = people.filter((p) => p.hidden !== 1);

  return (
    <PageContainer>
      {/* Screen: the interactive directory (any view) — never printed. */}
      <div className="print:hidden">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
          <BookUser className="h-6 w-6 text-compass-600" /> Directory
        </h1>
        <p className="mb-6 mt-1 text-sm text-slate-500">
          Find a colleague — search by name, title, department, or email.
        </p>
        <DirectoryClient
          initialPeople={people}
          fields={fields}
          defaultColumns={defaultColumns}
          defaultGroupBy={defaultGroupBy}
          presets={presets.map((p) => ({ id: p.id, name: p.name, is_default: p.is_default }))}
          isAdmin={user.role === "admin"}
        />
      </div>

      {/* Print: the default export preset's columns, as a plain table. */}
      <div className="hidden print:block">
        <h2 className="text-lg font-bold text-slate-900">
          {printPreset.title || `${settings.company_name || "Company"} directory`}
        </h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          {printable.length} people · {formatDate(new Date().toISOString(), settings)}
        </p>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b-2 border-slate-300 text-left">
              {printPreset.columns.map((c) => (
                <th key={c} className="py-1 pr-4 font-semibold text-slate-700">
                  {columnLabel(c, fields)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {printable.map((p) => (
              <tr key={p.id} className="break-inside-avoid border-b border-slate-200">
                {printPreset.columns.map((c) => (
                  <td key={c} className="py-1 pr-4 align-top text-slate-700">
                    {cellValue(p, c, fields)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageContainer>
  );
}
