import { requireSettingsSection } from "@/lib/auth";
import { getSetting } from "@/lib/db";
import { getSyncReport } from "@/lib/directory";
import { getDirectoryGraphConfig, getDirectorySyncStatus } from "@/lib/directory-config";
import { eePresent, featureEnabled } from "@/lib/ee";
import {
  getDirectoryGoogleConfig,
  getGoogleSyncStatus,
  googleDirectoryConfigured,
  serviceAccountClientId,
  GOOGLE_DIRECTORY_SCOPES,
} from "@/lib/directory-google-config";
import { MicrosoftSyncPanel } from "@/components/directory-admin/MicrosoftSyncPanel";
import { GoogleDirectoryPanel } from "@/components/GoogleDirectoryPanel";

export const dynamic = "force-dynamic";

export default async function DirectorySyncPage() {
  await requireSettingsSection("/admin/directory");
  const [cfg, lastSync, bundled, enabled, secretExpires, gcfg, gsync, graphReport, googleReport] = await Promise.all([
    getDirectoryGraphConfig(),
    getDirectorySyncStatus(),
    Promise.resolve(eePresent()),
    featureEnabled("directory_sync"),
    getSetting("directory_graph_secret_expires"),
    getDirectoryGoogleConfig(),
    getGoogleSyncStatus(),
    getSyncReport("graph"),
    getSyncReport("google"),
  ]);

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        Connect Microsoft 365 or Google Workspace and the directory fills itself; what each one knows lands in the
        fields under <span className="font-medium">Fields</span> through the mappings you set there. People typed in by
        hand stay, and are adopted by the sync that later matches their email.
      </p>
      <MicrosoftSyncPanel
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
        report={graphReport}
      />
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
      {googleReport?.unresolved?.length ? (
        <div className="notice-warn rounded-lg border p-3 text-xs">
          <p className="font-medium">Google Workspace: some people references didn&rsquo;t match anyone.</p>
          <ul className="mt-1 list-disc pl-4">
            {googleReport.unresolved.map((u) => (
              <li key={u.field}>
                <span className="font-mono">{u.field}</span>: {u.count} unresolved — e.g. {u.samples.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
