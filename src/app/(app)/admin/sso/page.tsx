import { requireRole } from "@/lib/auth";
import { getSsoConfig, ssoAuthority } from "@/lib/sso-config";
import { eePresent, featureEnabled } from "@/lib/ee";
import { SsoSettings } from "@/components/SsoSettings";

export const dynamic = "force-dynamic";

export default async function SsoAdminPage() {
  await requireRole("admin");
  const [cfg, bundled, enabled] = await Promise.all([
    getSsoConfig(),
    Promise.resolve(eePresent()),
    featureEnabled("sso"),
  ]);

  return (
    <SsoSettings
      initial={{
        enabled,
        bundled,
        sso_enabled: cfg.enabled,
        tenant: cfg.tenant,
        client_id: cfg.clientId,
        has_secret: Boolean(cfg.clientSecret),
        authority: cfg.authority,
        effective_authority: ssoAuthority(cfg),
        auto_provision: cfg.autoProvision,
        default_role: cfg.defaultRole,
        allowed_domains: cfg.allowedDomains.join(", "),
        sso_only: cfg.ssoOnly,
      }}
    />
  );
}
