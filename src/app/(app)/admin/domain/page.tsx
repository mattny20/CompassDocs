import { getAppSettings } from "@/lib/settings-store";
import { proxyStatus, hasCustomCert } from "@/lib/caddy";
import { DomainSettings } from "@/components/DomainSettings";

export const dynamic = "force-dynamic";

export default async function DomainPage() {
  const [settings, proxy, customCert] = await Promise.all([
    getAppSettings(),
    proxyStatus(),
    hasCustomCert(),
  ]);
  return (
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
  );
}
