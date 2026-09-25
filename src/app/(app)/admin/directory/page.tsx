import { requireSettingsSection } from "@/lib/auth";
import { listPeople, listFields, listLinkRows } from "@/lib/directory";
import { DirectoryPeoplePanel } from "@/components/directory-admin/DirectoryPeoplePanel";

export const dynamic = "force-dynamic";

export default async function DirectoryPeoplePage() {
  await requireSettingsSection("/admin/directory");
  const [people, links, fields] = await Promise.all([listPeople({ includeHidden: true }), listLinkRows(), listFields()]);
  return <DirectoryPeoplePanel initialPeople={people} initialLinks={links} fields={fields} />;
}
