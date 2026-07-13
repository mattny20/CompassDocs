import { requireRole } from "@/lib/auth";
import { listPeople, listFields } from "@/lib/directory";
import {
  getDirectoryGraphConfig,
  getDirectorySyncStatus,
} from "@/lib/directory-config";
import { eePresent, featureEnabled } from "@/lib/ee";
import { DirectorySettings } from "@/components/DirectorySettings";

export const dynamic = "force-dynamic";

export default async function DirectoryAdminPage() {
  await requireRole("admin");
  const [people, fields, cfg, lastSync, bundled, enabled] = await Promise.all([
    listPeople({ includeHidden: true }),
    listFields(),
    getDirectoryGraphConfig(),
    getDirectorySyncStatus(),
    Promise.resolve(eePresent()),
    featureEnabled("directory_sync"),
  ]);

  return (
    <DirectorySettings
      initialPeople={people}
      initialFields={fields}
      graph={{
        enabled,
        bundled,
        tenant: cfg.tenant,
        client_id: cfg.clientId,
        has_secret: Boolean(cfg.clientSecret),
        group: cfg.group,
        include_guests: cfg.includeGuests,
        require_title: cfg.requireTitle,
        require_phone: cfg.requirePhone,
        photos: cfg.photos,
        last_sync: lastSync,
      }}
    />
  );
}
