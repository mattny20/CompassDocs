import { requireUser } from "@/lib/auth";
import { listPeople, listDepartments, listFields } from "@/lib/directory";
import { DirectoryClient } from "@/components/DirectoryClient";
import { PageContainer } from "@/components/PageWidth";
import Link from "next/link";
import { Printer } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DirectoryPage() {
  await requireUser();
  const [people, departments, fields] = await Promise.all([
    listPeople(),
    listDepartments(),
    listFields(),
  ]);

  return (
    <PageContainer>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Directory</h1>
          <p className="mb-6 mt-1 text-slate-500">
            Find a colleague — search by name, title, department, or email.
          </p>
        </div>
        <Link
          href="/directory/print"
          title="Quick print directory"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          <Printer className="h-4 w-4" /> Quick print
        </Link>
      </div>
      <DirectoryClient initialPeople={people} departments={departments} fields={fields} />
    </PageContainer>
  );
}
