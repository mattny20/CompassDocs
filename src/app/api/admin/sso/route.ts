import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getSsoConfig, updateSsoConfig, ssoAuthority } from "@/lib/sso-config";
import { getSetting } from "@/lib/db";
import { featureEnabled, eePresent } from "@/lib/ee";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLES: Role[] = ["viewer", "editor", "approver", "admin"];

// The client secret is write-only: GET only reports whether one is stored.
async function view() {
  const [cfg, enabled, secretExpires] = await Promise.all([
    getSsoConfig(),
    featureEnabled("sso"),
    getSetting("sso_secret_expires"),
  ]);
  return {
    secret_expires: secretExpires || "",
    enabled, // bundled AND licensed
    bundled: eePresent(),
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
  };
}

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  await updateSsoConfig({
    ...(body?.sso_enabled !== undefined ? { enabled: Boolean(body.sso_enabled) } : {}),
    ...(body?.tenant !== undefined ? { tenant: String(body.tenant) } : {}),
    ...(body?.client_id !== undefined ? { clientId: String(body.client_id) } : {}),
    // Only overwrite the stored secret when a new value is actually provided.
    ...(typeof body?.client_secret === "string" && body.client_secret !== ""
      ? { clientSecret: body.client_secret }
      : {}),
    ...(body?.clear_secret === true ? { clientSecret: "" } : {}),
    ...(body?.authority !== undefined ? { authority: String(body.authority) } : {}),
    ...(body?.auto_provision !== undefined
      ? { autoProvision: Boolean(body.auto_provision) }
      : {}),
    ...(ROLES.includes(body?.default_role) ? { defaultRole: body.default_role as Role } : {}),
    ...(body?.allowed_domains !== undefined
      ? { allowedDomains: String(body.allowed_domains) }
      : {}),
    ...(body?.sso_only !== undefined ? { ssoOnly: Boolean(body.sso_only) } : {}),
  });

  await audit({
    actor: actorFrom(gate),
    action: "settings.sso",
    details: { secret_changed: Boolean(body?.client_secret) || body?.clear_secret === true },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, state: await view() });
}
