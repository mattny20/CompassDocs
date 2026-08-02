import { requireSettingsSection } from "@/lib/auth";
import { getSetting } from "@/lib/db";
import { listPeople, listFields } from "@/lib/directory";
import {
  getDirectoryGraphConfig,
  getDirectorySyncStatus,
} from "@/lib/directory-config";
import { eePresent, featureEnabled } from "@/lib/ee";
import {
  getDirectoryGoogleConfig,
  getGoogleSyncStatus,
  googleDirectoryConfigured,
  serviceAccountClientId,
  GOOGLE_DIRECTORY_SCOPES,
} from "@/lib/directory-google-config";
import { DirectorySettings } from "@/components/DirectorySettings";
import { GoogleDirectoryPanel } from "@/components/GoogleDirectoryPanel";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function DirectoryAdminPage() {
  await requireSettingsSection("/admin/directory");
  const [people, fields, cfg, lastSync, bundled, enabled, secretExpires, gcfg, gsync] =
    await Promise.all([
    listPeople({ includeHidden: true }),
    listFields(),
    getDirectoryGraphConfig(),
    getDirectorySyncStatus(),
    Promise.resolve(eePresent()),
    featureEnabled("directory_sync"),
    getSetting("directory_graph_secret_expires"),
    getDirectoryGoogleConfig(),
    getGoogleSyncStatus(),
  ]);

  return (
    <SettingsPage href="/admin/directory">
    <DirectorySettings
      initialPeople={people}
      initialFields={fields}
      graph={{
        enabled,
        bundled,
        tenant: cfg.tenant,
        client_id: cfg.clientId,
        has_secret: Boolean(cfg.clientSecret),
        secret_expires: secretExpires || "",
        group: cfg.group,
        include_guests: cfg.includeGuests,
        require_title: cfg.requireTitle,
        require_phone: cfg.requirePhone,
        photos: cfg.photos,
        last_sync: lastSync,
      }}
    />
    <div className="mt-8">
      <GoogleDirectoryPanel
        initial={{
          enabled,
          bundled,
          // The key itself never leaves the server — only whether one exists
          // and the client id an admin has to paste into Google.
          has_service_account: Boolean(gcfg.serviceAccount),
          service_account_client_id: serviceAccountClientId(gcfg.serviceAccount),
          admin_email: gcfg.adminEmail,
          customer_id: gcfg.customerId,
          group: gcfg.group,
          include_suspended: gcfg.includeSuspended,
          photos: gcfg.photos,
          configured: googleDirectoryConfigured(gcfg),
          scopes: [...GOOGLE_DIRECTORY_SCOPES],
          last_sync: gsync,
        }}
      />
    </div>
    </SettingsPage>
  );
}
