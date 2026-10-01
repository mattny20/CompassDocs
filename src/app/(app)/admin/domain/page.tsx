import { requireSettingsSection } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { proxyStatus, hasCustomCert } from "@/lib/caddy";
import { DomainSettings } from "@/components/DomainSettings";
import { SettingsPage } from "@/components/SettingsPage";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/domain");

export default async function DomainPage() {
  await requireSettingsSection("/admin/domain");
  const [settings, proxy, customCert] = await Promise.all([
    getAppSettings(),
    proxyStatus(),
    hasCustomCert(),
  ]);
  return (
    <SettingsPage href="/admin/domain">
    <DomainSettings
      initial={{
        custom_domain: settings.custom_domain,
        tls_mode: settings.tls_mode,
        tls_email: settings.tls_email,
        secure_cookies: settings.secure_cookies,
        has_custom_cert: customCert,
        proxy,
      }}
    />
    </SettingsPage>
  );
}
