import { requireUser } from "@/lib/auth";
import {
  listPeople,
  listDepartments,
  listFields,
  getPrintColumns,
  printValue,
  PRINT_BUILTINS,
} from "@/lib/directory";
import { DirectoryClient } from "@/components/DirectoryClient";
import { PageContainer } from "@/components/PageWidth";
import { PrintButton } from "@/components/PrintButton";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DirectoryPage() {
  await requireUser();
  const [people, departments, fields, printColumns, settings] = await Promise.all([
    listPeople(),
    listDepartments(),
    listFields(),
    getPrintColumns(),
    getAppSettings(),
  ]);

  const labels = new Map<string, string>([
    ...PRINT_BUILTINS.map((b) => [b.key, b.label] as [string, string]),
    ...fields.map((f) => [f.key, f.label] as [string, string]),
  ]);
  const printable = people.filter((p) => p.hidden !== 1);

  return (
    <PageContainer>
      {/* Screen: the interactive directory (any view) — never printed. */}
      <div className="print:hidden">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Directory</h1>
            <p className="mb-6 mt-1 text-slate-500">
              Find a colleague — search by name, title, department, or email.
            </p>
          </div>
          <PrintButton />
        </div>
        <DirectoryClient initialPeople={people} departments={departments} fields={fields} />
      </div>

      {/* Print: the quick phone directory, columns configured by an admin
          under Settings → Directory → Quick print directory. */}
      <div className="hidden print:block">
        <h1 className="text-lg font-bold text-slate-900">
          {settings.company_name || "Company"} phone directory
        </h1>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          {printable.length} people · {formatDate(new Date().toISOString(), settings)}
        </p>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b-2 border-slate-300 text-left">
              {printColumns.map((c) => (
                <th key={c} className="py-1 pr-4 font-semibold text-slate-700">
                  {labels.get(c) ?? c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {printable.map((p) => (
              <tr key={p.id} className="break-inside-avoid border-b border-slate-200">
                {printColumns.map((c) => (
                  <td key={c} className="py-1 pr-4 align-top text-slate-700">
                    {printValue(p, c)}
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
