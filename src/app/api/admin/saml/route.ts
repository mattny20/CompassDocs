import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getSamlConfig,
  updateSamlConfig,
  samlConfigured,
  samlSpUrls,
  parseIdpMetadata,
} from "@/lib/saml-config";
import { featureEnabled, eePresent } from "@/lib/ee";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { getAppSettings } from "@/lib/settings-store";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLES: Role[] = ["viewer", "editor", "approver", "admin"];

// The IdP certificate is public-key material, so unlike the OIDC client
// secret it is returned to the (admin-only) client for display/editing.
async function view(req: Request) {
  const [cfg, enabled, app] = await Promise.all([
    getSamlConfig(),
    featureEnabled("sso"),
    getAppSettings(),
  ]);
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const origin = app.custom_domain ? `https://${app.custom_domain}` : host ? `${proto}://${host}` : "";
  const sp = samlSpUrls(origin || "https://your-domain");
  return {
    enabled, // bundled AND licensed ("sso" entitlement, shared with OIDC)
    bundled: eePresent(),
    saml_enabled: cfg.enabled,
    idp_sso_url: cfg.idpSsoUrl,
    idp_issuer: cfg.idpIssuer,
    idp_cert: cfg.idpCert,
    auto_provision: cfg.autoProvision,
    default_role: cfg.defaultRole,
    allowed_domains: cfg.allowedDomains.join(", "),
    button_label: cfg.buttonLabel,
    configured: samlConfigured(cfg),
    sp_entity_id: sp.entityId,
    sp_acs_url: sp.acs,
    sp_metadata_url: sp.metadata,
  };
}

export async function GET(req: Request) {
  const gate = await apiGuard("admin", "identity.saml_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view(req));
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "identity.saml_manage");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Convenience: paste a whole IdP metadata XML document and we extract the
  // issuer, SSO URL, and signing certificate from it.
  if (typeof body?.idp_metadata_xml === "string" && body.idp_metadata_xml.trim()) {
    const parsed = parseIdpMetadata(body.idp_metadata_xml);
    if (!parsed) {
      return NextResponse.json(
        { error: "Could not find an entityID, SingleSignOnService URL, and certificate in that metadata." },
        { status: 400 },
      );
    }
    await updateSamlConfig(parsed);
    await audit({
      actor: actorFrom(gate),
      action: "settings.saml",
      details: { via: "metadata_import", issuer: parsed.idpIssuer },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, state: await view(req) });
  }

  await updateSamlConfig({
    ...(body?.saml_enabled !== undefined ? { enabled: Boolean(body.saml_enabled) } : {}),
    ...(body?.idp_sso_url !== undefined ? { idpSsoUrl: String(body.idp_sso_url) } : {}),
    ...(body?.idp_issuer !== undefined ? { idpIssuer: String(body.idp_issuer) } : {}),
    ...(body?.idp_cert !== undefined ? { idpCert: String(body.idp_cert) } : {}),
    ...(body?.auto_provision !== undefined ? { autoProvision: Boolean(body.auto_provision) } : {}),
    ...(ROLES.includes(body?.default_role) ? { defaultRole: body.default_role as Role } : {}),
    ...(body?.allowed_domains !== undefined ? { allowedDomains: String(body.allowed_domains) } : {}),
    ...(body?.button_label !== undefined ? { buttonLabel: String(body.button_label) } : {}),
  });

  await audit({
    actor: actorFrom(gate),
    action: "settings.saml",
    details: { enabled: Boolean(body?.saml_enabled) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, state: await view(req) });
}
