import { requireSettingsSection } from "@/lib/auth";
import { listPeople, listFields, listLinkRows, getSyncReport } from "@/lib/directory";
import { getDirectorySyncStatus } from "@/lib/directory-config";
import { getGoogleSyncStatus } from "@/lib/directory-google-config";
import { directoryHealth } from "@/lib/directory-health";
import { DirectoryPeoplePanel } from "@/components/directory-admin/DirectoryPeoplePanel";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/directory");

export default async function DirectoryPeoplePage({ searchParams }: { searchParams: Promise<{ missing?: string }> }) {
  await requireSettingsSection("/admin/directory");
  const [people, links, fields, sp, graphReport, googleReport, graphStatus, googleStatus] = await Promise.all([
    listPeople({ includeHidden: true }),
    listLinkRows(),
    listFields(),
    searchParams,
    getSyncReport("graph"),
    getSyncReport("google"),
    getDirectorySyncStatus(),
    getGoogleSyncStatus(),
  ]);
  // ?missing=office — the Groups view's "No office" section links here so an
  // admin lands on exactly the people to fix.
  const missing = typeof sp.missing === "string" && /^[a-z0-9_]{1,40}$/.test(sp.missing) ? sp.missing : "";
  const health = directoryHealth({
    people,
    fields,
    reports: { graph: graphReport, google: googleReport },
    lastSync: {
      graph: graphStatus?.ok ? graphStatus.at : undefined,
      google: googleStatus?.ok ? googleStatus.at : undefined,
    },
  });
  return <DirectoryPeoplePanel initialPeople={people} initialLinks={links} fields={fields} missing={missing} health={health} />;
}
