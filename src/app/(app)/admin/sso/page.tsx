import { headers } from "next/headers";
import { requireRole } from "@/lib/auth";
import { getSsoConfig, ssoAuthority } from "@/lib/sso-config";
import { getSetting } from "@/lib/db";
import { eePresent, featureEnabled } from "@/lib/ee";
import { SsoSettings } from "@/components/SsoSettings";
import { ScimPanel } from "@/components/ScimPanel";

export const dynamic = "force-dynamic";

export default async function SsoAdminPage() {
  await requireRole("admin");
  const [cfg, bundled, enabled, secretExpires, scimLicensed, scimEnabled, scimTokenHash, scimLast] =
    await Promise.all([
      getSsoConfig(),
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
