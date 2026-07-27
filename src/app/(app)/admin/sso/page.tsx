import { headers } from "next/headers";
import { requireRole } from "@/lib/auth";
import { getSsoConfig, ssoAuthority } from "@/lib/sso-config";
import { getSamlConfig, samlConfigured, samlSpUrls } from "@/lib/saml-config";
import { getSetting } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { eePresent, featureEnabled } from "@/lib/ee";
import { SsoSettings } from "@/components/SsoSettings";
import { SamlPanel } from "@/components/SamlPanel";
import { ScimPanel } from "@/components/ScimPanel";

export const dynamic = "force-dynamic";

export default async function SsoAdminPage() {
  await requireRole("admin");
  const [cfg, samlCfg, app, bundled, enabled, secretExpires, scimLicensed, scimEnabled, scimTokenHash, scimLast] =
    await Promise.all([
      getSsoConfig(),
      getSamlConfig(),
      getAppSettings(),
      Promise.resolve(eePresent()),
      featureEnabled("sso"),
      getSetting("sso_secret_expires"),
      featureEnabled("scim"),
      getSetting("scim_enabled"),
      getSetting("scim_token_hash"),
      getSetting("scim_last_request_at"),
    ]);

  const h = await headers();
  const proto = h.get("x-forwarded-proto") || "http";
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost";
  const origin = app.custom_domain ? `https://${app.custom_domain}` : `${proto}://${host}`;
  const sp = samlSpUrls(origin);

  return (
    <>
      <SsoSettings
        initial={{
          enabled,
          secret_expires: secretExpires || "",
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
      <SamlPanel
        initial={{
          enabled,
          bundled,
          saml_enabled: samlCfg.enabled,
          idp_sso_url: samlCfg.idpSsoUrl,
          idp_issuer: samlCfg.idpIssuer,
          idp_cert: samlCfg.idpCert,
          auto_provision: samlCfg.autoProvision,
          default_role: samlCfg.defaultRole,
          allowed_domains: samlCfg.allowedDomains.join(", "),
          button_label: samlCfg.buttonLabel,
          configured: samlConfigured(samlCfg),
          sp_entity_id: sp.entityId,
          sp_acs_url: sp.acs,
          sp_metadata_url: sp.metadata,
        }}
      />
      {bundled && (
        <ScimPanel
          initial={{
            licensed: scimLicensed,
            enabled: scimEnabled === "1",
            token_set: Boolean(scimTokenHash),
            last_request_at: scimLast || null,
            base_url: `${proto}://${host}/api/scim/v2`,
          }}
        />
      )}
    </>
  );
}
