import { requireUser } from "@/lib/auth";
import { listPeople, listDepartments, listFields } from "@/lib/directory";
import { DirectoryClient } from "@/components/DirectoryClient";
import { PageContainer } from "@/components/PageWidth";

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
      <h1 className="text-2xl font-bold text-slate-900">Directory</h1>
      <p className="mb-6 mt-1 text-slate-500">
        Find a colleague — search by name, title, department, or email.
      </p>
      <DirectoryClient initialPeople={people} departments={departments} fields={fields} />
    </PageContainer>
  );
}
