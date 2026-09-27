import { requireSettingsSection } from "@/lib/auth";
import { listPeople, listFields, listLinkRows } from "@/lib/directory";
import { DirectoryPeoplePanel } from "@/components/directory-admin/DirectoryPeoplePanel";

export const dynamic = "force-dynamic";

export default async function DirectoryPeoplePage({ searchParams }: { searchParams: Promise<{ missing?: string }> }) {
  await requireSettingsSection("/admin/directory");
  const [people, links, fields, sp] = await Promise.all([listPeople({ includeHidden: true }), listLinkRows(), listFields(), searchParams]);
  // ?missing=office — the Groups view's "No office" section links here so an
  // admin lands on exactly the people to fix.
  const missing = typeof sp.missing === "string" && /^[a-z0-9_]{1,40}$/.test(sp.missing) ? sp.missing : "";
  return <DirectoryPeoplePanel initialPeople={people} initialLinks={links} fields={fields} missing={missing} />;
}
