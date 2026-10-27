import "server-only";

// Where an identifier signs in (1.16.0). The sign-in page asks for an email
// or username first when single sign-on is set up, and this decides the
// next step: straight to an SSO provider, or the password step. The order:
//
//   1. No usable provider: the password step (the page never asks; the
//      community build and an unconfigured workspace keep one form).
//   2. "SSO only" on: every identifier goes to SSO; the password step is the
//      break-glass at /login?local=1.
//   3. An email whose domain is on a usable provider's allowed-domain list
//      goes to that provider, whether or not an account exists yet, so a new
//      colleague is created on first sign-in (JIT). Both lists claiming it:
//      both providers, the person picks. An empty list claims nothing.
//   4. An account the identifier names (its username, or the one account
//      with that email) that signs in with SSO goes to its provider. Only
//      this rule reads an account, so only it is rate-limited.
//   5. Anything else, unknown included: the password step. An unknown
//      identifier and a password account get the same answer, so the lookup
//      never says whether an account exists. Status is not consulted: a
//      disabled SSO account routes as before and its provider's callback
//      says it is disabled.
//
// A local administrator is never sent to SSO by an account match (admins
// stay local; SSO linking refuses them), and can always type their username
// (no "@", so rule 3 does not apply) or use "Use a password instead".

import { featureEnabled } from "./ee";
import { getSsoConfig, ssoConfigured, type SsoConfig, type SsoVendor } from "./sso-config";
import { getSamlConfig, samlConfigured, type SamlConfig } from "./saml-config";
import { signInAccountFlags } from "./db";
import { withReturnPath } from "./return-to";

export type SignInProviderId = "oidc" | "saml";

export interface SignInProvider {
  id: SignInProviderId;
  /** The button's words: "Sign in with Microsoft", the SAML button label… */
  label: string;
  /** Which mark the button carries. */
  mark: SsoVendor | "saml";
}

export interface SignInSetup {
  oidc: (SignInProvider & { domains: string[] }) | null;
  saml: (SignInProvider & { domains: string[] }) | null;
  /** "SSO only" is on and a provider is usable: no password step but the break-glass. */
  ssoOnly: boolean;
}

/** Entra authorities that accept any tenant: usable only with an allowed-domain list (the overlay refuses otherwise). */
const MULTI_TENANT = ["common", "organizations", "consumers"];

/** The OIDC button's words, from the vendor the workspace configured. */
export function oidcLabel(cfg: Pick<SsoConfig, "vendor" | "authority">): string {
  if (cfg.vendor === "google") return "Sign in with Google";
  if (cfg.vendor === "generic" || cfg.authority) return "Sign in with single sign-on";
  return "Sign in with Microsoft";
}

/** Can the OIDC flow succeed at all? (Configured, and not a multi-tenant authority without a domain list.) */
export function oidcUsable(cfg: SsoConfig): boolean {
  if (!ssoConfigured(cfg)) return false;
  return !(MULTI_TENANT.includes(cfg.tenant.toLowerCase()) && cfg.allowedDomains.length === 0);
}

/** The usable providers and the routing settings, read once per request. */
export async function signInSetup(): Promise<SignInSetup> {
  if (!(await featureEnabled("sso"))) return { oidc: null, saml: null, ssoOnly: false };
  const [sso, saml] = await Promise.all([getSsoConfig(), getSamlConfig()]);
  return setupFrom(sso, saml);
}

/** signInSetup's decision on given configs (exported for tests). */
export function setupFrom(sso: SsoConfig, saml: SamlConfig): SignInSetup {
  const oidc = oidcUsable(sso)
    ? { id: "oidc" as const, label: oidcLabel(sso), mark: sso.authority && sso.vendor === "microsoft" ? ("generic" as const) : sso.vendor, domains: sso.allowedDomains }
    : null;
  const samlP = samlConfigured(saml)
    ? { id: "saml" as const, label: saml.buttonLabel.slice(0, 60), mark: "saml" as const, domains: saml.allowedDomains }
    : null;
  return { oidc, saml: samlP, ssoOnly: sso.ssoOnly && Boolean(oidc || samlP) };
}

export function anyProvider(setup: SignInSetup): boolean {
  return Boolean(setup.oidc || setup.saml);
}

export function providersOf(setup: SignInSetup): SignInProvider[] {
  return [setup.oidc, setup.saml].filter(Boolean).map((p) => ({ id: p!.id, label: p!.label, mark: p!.mark }));
}

/** The domain an email-shaped identifier names (after the last "@"), lowercased; null otherwise. */
export function emailDomain(identifier: string): string | null {
  const at = identifier.lastIndexOf("@");
  if (at <= 0 || at === identifier.length - 1) return null;
  return identifier.slice(at + 1).trim().toLowerCase() || null;
}

/** An identifier the IdP can be handed as a login hint: email-shaped, no spaces or control characters. */
export function hintable(identifier: string): boolean {
  // eslint-disable-next-line no-control-regex
  return identifier.length <= 254 && /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/.test(identifier);
}

/**
 * The same-origin URL that starts a provider's sign-in, carrying the page the
 * visitor wanted and, for an email on OIDC, a login hint (an overlay that
 * predates hints ignores it; the SAML start never reads one, so it gets
 * none). Never an absolute IdP URL: the flow cookie must be set by our own
 * start route.
 */
export function providerStart(id: SignInProviderId, next: string, identifier?: string): string {
  const base = withReturnPath(id === "oidc" ? "/api/ee/sso/login" : "/api/ee/saml/login", next);
  if (id !== "oidc" || !identifier || !hintable(identifier)) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${new URLSearchParams({ login_hint: identifier }).toString()}`;
}

export type SignInRoute = { step: "password" } | { step: "sso"; providers: SignInProviderId[] };

/**
 * Rules 1 to 3: the decision configuration alone makes, or null when it
 * takes an account (rule 4). Reads no account, so it is never rate-limited.
 */
export function routeByConfig(identifier: string, setup: SignInSetup): SignInRoute | null {
  if (!anyProvider(setup)) return { step: "password" };
  if (setup.ssoOnly) return { step: "sso", providers: providersOf(setup).map((p) => p.id) };
  const domain = emailDomain(identifier);
  if (domain) {
    const claimed = [setup.oidc, setup.saml].filter((p) => p && p.domains.includes(domain)).map((p) => p!.id);
    if (claimed.length) return { step: "sso", providers: claimed };
  }
  return null;
}

/** Rules 4 and 5: the account the identifier names, if it signs in with SSO; the password step otherwise. */
export async function routeByAccount(identifier: string, setup: SignInSetup): Promise<SignInRoute> {
  const flags = await signInAccountFlags(identifier);
  if (!flags || flags.auth_provider === "local") return { step: "password" };
  // A SAML account goes to SAML; any other SSO account (OIDC, and SCIM rows,
  // which are written as "oidc") to OIDC, else to SAML when that is the one
  // configured.
  const want: SignInProviderId = flags.auth_provider === "saml" ? "saml" : "oidc";
  const chosen = setup[want] ? want : setup.oidc ? "oidc" : setup.saml ? "saml" : null;
  return chosen ? { step: "sso", providers: [chosen] } : { step: "password" };
}

/** The whole decision (rules 1 to 5). `counted` is true when it read an account. */
export async function routeIdentifier(
  identifier: string,
  setup: SignInSetup
): Promise<{ route: SignInRoute; counted: boolean }> {
  const byConfig = routeByConfig(identifier, setup);
  if (byConfig) return { route: byConfig, counted: false };
  return { route: await routeByAccount(identifier, setup), counted: true };
}
