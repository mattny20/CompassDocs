// Quick phone directory: a print-first table of everyone in the directory,
// with the columns (and order) an admin configured under
// Settings → Directory → Quick print. The app chrome hides via print CSS;
// on screen the page previews exactly what will print.

import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listPeople, getPrintColumns, listFields, printValue, PRINT_BUILTINS } from "@/lib/directory";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";
import { PrintButton } from "@/components/PrintButton";
import { PageContainer } from "@/components/PageWidth";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DirectoryPrintPage() {
  await requireUser();
  const [people, columns, fields, settings] = await Promise.all([
    listPeople(),
    getPrintColumns(),
    listFields(),
    getAppSettings(),
  ]);
  const labels = new Map<string, string>([
    ...PRINT_BUILTINS.map((b) => [b.key, b.label] as [string, string]),
    ...fields.map((f) => [f.key, f.label] as [string, string]),
  ]);
  const visible = people.filter((p) => p.hidden !== 1);

  return (
    <PageContainer>
      <div className="mb-4 flex items-center justify-between gap-3 print:hidden">
        <Link
          href="/directory"
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-4 w-4" /> Back to directory
        </Link>
        <PrintButton />
      </div>

      <h1 className="text-xl font-bold text-slate-900 print:text-lg">
        {settings.company_name || "Company"} phone directory
      </h1>
      <p className="mb-4 mt-0.5 text-sm text-slate-500">
        {visible.length} people · {formatDate(new Date().toISOString(), settings)}
      </p>

      <table className="w-full border-collapse text-sm print:text-xs">
        <thead>
          <tr className="border-b-2 border-slate-300 text-left">
            {columns.map((c) => (
              <th key={c} className="py-1.5 pr-4 font-semibold text-slate-700">
                {labels.get(c) ?? c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((p) => (
            <tr key={p.id} className="break-inside-avoid border-b border-slate-200">
              {columns.map((c) => (
                <td key={c} className="py-1.5 pr-4 align-top text-slate-700">
                  {printValue(p, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </PageContainer>
  );
}
