// Configuration for enterprise single sign-on (OIDC, Microsoft Entra ID
// first-class). Lives in the core so settings survive edition switches and the
// admin UI can manage them; the login flow itself is implemented in the
// enterprise overlay (/api/ee/sso/*).
//
// The client secret is write-only: stored here, surfaced only as "set / not set".
// Server-only.

import { getSetting, setSetting } from "./db";
import type { Role } from "./types";

const KEYS = {
  enabled: "sso_enabled",
  tenant: "sso_tenant",
  clientId: "sso_client_id",
  clientSecret: "sso_client_secret",
  authority: "sso_authority",
  autoProvision: "sso_auto_provision",
  defaultRole: "sso_default_role",
  allowedDomains: "sso_allowed_domains",
  ssoOnly: "sso_only",
} as const;

const ROLES: Role[] = ["viewer", "editor", "approver", "admin"];

export interface SsoConfig {
  enabled: boolean;
  /** Entra tenant ID (GUID or verified domain), or "common"/"organizations". */
  tenant: string;
  clientId: string;
  clientSecret: string; // never send to the client
  /**
   * Advanced: full OIDC authority to use instead of the Entra one derived from
   * the tenant (e.g. an Okta/Auth0 issuer). Discovery is fetched from
   * `<authority>/.well-known/openid-configuration`.
   */
  authority: string;
  /** Create a CompassDocs account on first SSO sign-in (default on). */
  autoProvision: boolean;
  /** Role given to auto-provisioned accounts (default viewer). */
  defaultRole: Role;
  /** Optional comma-separated email-domain allowlist (empty = any). */
  allowedDomains: string[];
  /** Hide the username/password form on the login page (break-glass: admins can still POST /api/auth/login). */
  ssoOnly: boolean;
}

/** The OIDC authority in effect — explicit override, else built from the tenant. */
export function ssoAuthority(cfg: Pick<SsoConfig, "authority" | "tenant">): string {
  if (cfg.authority) return cfg.authority.replace(/\/+$/, "");
  if (!cfg.tenant) return "";
  return `https://login.microsoftonline.com/${cfg.tenant}/v2.0`;
}

/** Configured completely enough for the login flow to run. */
export function ssoConfigured(cfg: SsoConfig): boolean {
  return Boolean(cfg.enabled && cfg.clientId && cfg.clientSecret && ssoAuthority(cfg));
}

export async function getSsoConfig(): Promise<SsoConfig> {
  const [enabled, tenant, clientId, clientSecret, authority, autoProv, role, domains, ssoOnly] =
    await Promise.all([
      getSetting(KEYS.enabled),
      getSetting(KEYS.tenant),
      getSetting(KEYS.clientId),
      getSetting(KEYS.clientSecret),
      getSetting(KEYS.authority),
      getSetting(KEYS.autoProvision),
      getSetting(KEYS.defaultRole),
      getSetting(KEYS.allowedDomains),
      getSetting(KEYS.ssoOnly),
    ]);
  return {
    enabled: enabled === "1",
    tenant: tenant?.trim() || "",
    clientId: clientId?.trim() || "",
    clientSecret: clientSecret || "",
    authority: authority?.trim() || "",
    autoProvision: autoProv !== "0",
    defaultRole: ROLES.includes(role as Role) ? (role as Role) : "viewer",
    allowedDomains: (domains || "")
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
    ssoOnly: ssoOnly === "1",
  };
}

export async function updateSsoConfig(patch: {
  enabled?: boolean;
  tenant?: string;
  clientId?: string;
  clientSecret?: string;
  authority?: string;
  autoProvision?: boolean;
  defaultRole?: Role;
  allowedDomains?: string;
  ssoOnly?: boolean;
}): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (patch.enabled !== undefined) jobs.push(setSetting(KEYS.enabled, patch.enabled ? "1" : "0"));
  if (patch.tenant !== undefined) jobs.push(setSetting(KEYS.tenant, patch.tenant.trim()));
  if (patch.clientId !== undefined) jobs.push(setSetting(KEYS.clientId, patch.clientId.trim()));
  if (patch.clientSecret !== undefined) jobs.push(setSetting(KEYS.clientSecret, patch.clientSecret));
  if (patch.authority !== undefined) jobs.push(setSetting(KEYS.authority, patch.authority.trim()));
  if (patch.autoProvision !== undefined)
    jobs.push(setSetting(KEYS.autoProvision, patch.autoProvision ? "1" : "0"));
  if (patch.defaultRole !== undefined && ROLES.includes(patch.defaultRole))
    jobs.push(setSetting(KEYS.defaultRole, patch.defaultRole));
  if (patch.allowedDomains !== undefined)
    jobs.push(setSetting(KEYS.allowedDomains, patch.allowedDomains));
  if (patch.ssoOnly !== undefined) jobs.push(setSetting(KEYS.ssoOnly, patch.ssoOnly ? "1" : "0"));
  await Promise.all(jobs);
}
