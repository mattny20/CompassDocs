import "server-only";

// "How people sign in" (1.16.0, Settings → Workspace → Sign-in page): the
// routing lib/sign-in-routing applies, told back to the admin in sentences,
// so the person styling the page knows which steps their colleagues will
// actually see. Read from the same signInSetup() decision the sign-in page
// makes, plus the raw OIDC config for the one case it hides: an Entra
// multi-tenant authority with no domain list, which is set up but unusable.

import { featureEnabled } from "./ee";
import { getSsoConfig, ssoConfigured } from "./sso-config";
import { getSamlConfig } from "./saml-config";
import { oidcUsable, setupFrom, type SignInSetup } from "./sign-in-routing";

/** Problems the card raises under the sentences; the client words them with a link to Single sign-on. */
export type SignInRoutingWarning =
  /** OIDC is configured but cannot be used (multi-tenant authority, no email domains). */
  | "unusable"
  /** SSO is on, but no provider claims an email domain, so a new colleague is asked for a password. */
  | "no_domains";

export interface SignInRoutingSummary {
  sentences: string[];
  warnings: SignInRoutingWarning[];
  /** The break-glass address when SSO only is on: `${origin}/login?local=1`. */
  localUrl: string | null;
}

const EVERYONE_PASSWORD = "Everyone signs in with their email or username and a password.";
const DOMAINS_SHOWN = 6;

type Provider = NonNullable<SignInSetup["oidc"]>;

/** The provider as a sentence names it: "Microsoft", "Google", "single sign-on". */
function providerName(p: Provider): string {
  if (p.id === "saml") return "SAML single sign-on";
  if (p.mark === "microsoft") return "Microsoft";
  if (p.mark === "google") return "Google";
  return "single sign-on";
}

function list(items: string[], type: "conjunction" | "disjunction"): string {
  return new Intl.ListFormat("en", { style: "long", type }).format(items);
}

/** "acme.com and acme.co.uk"; a long list ends "and 4 more". */
function domainList(domains: string[]): string {
  if (domains.length <= DOMAINS_SHOWN) return list(domains, "conjunction");
  const shown = domains.slice(0, DOMAINS_SHOWN - 1);
  return list([...shown, `${domains.length - shown.length} more`], "conjunction");
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The sentences for a setup (pure; `oidcStuck` is the unusable-OIDC case the setup cannot show). */
export function summarizeRouting(setup: SignInSetup, opts: { oidcStuck: boolean; origin: string }): SignInRoutingSummary {
  const providers = [setup.oidc, setup.saml].filter((p): p is Provider => Boolean(p));
  const warnings: SignInRoutingWarning[] = opts.oidcStuck ? ["unusable"] : [];

  if (providers.length === 0) return { sentences: [EVERYONE_PASSWORD], warnings, localUrl: null };

  if (setup.ssoOnly) {
    const names = providers.map(providerName);
    const localUrl = `${opts.origin}/login?local=1`;
    const where = names.length === 1 ? names[0] : `${list(names, "disjunction")}, whichever they pick`;
    return {
      sentences: [
        // SSO only shapes the page; the server still takes any password (docs admin/sso.md).
        `Everyone continues to ${where}.`,
        `Anyone with a password, administrators included, can still sign in at ${localUrl}.`,
      ],
      warnings,
      localUrl,
    };
  }

  // A domain both lists claim is a choice of the two (sign-in-routing rule 3).
  const shared = setup.oidc && setup.saml ? setup.oidc.domains.filter((d) => setup.saml!.domains.includes(d)) : [];
  const routes = providers
    .map((p) => ({ p, own: p.domains.filter((d) => !shared.includes(d)) }))
    .filter((r) => r.own.length > 0)
    .map((r) => `emails at ${domainList(r.own)} go straight to ${providerName(r.p)}`);
  if (shared.length > 0) {
    routes.push(`emails at ${domainList(shared)} choose between ${list(providers.map(providerName), "conjunction")}`);
  }
  const sentences = ["People enter their email or username first."];
  if (routes.length > 0) sentences.push(`${capitalise(routes.join(", and "))}.`);
  else warnings.push("no_domains");
  // Rule 4: an SSO account goes to its own provider, else to the one there is.
  sentences.push(
    providers.length === 1
      ? `Accounts that already sign in with single sign-on go straight to ${providerName(providers[0])}.`
      : `Accounts that already sign in with ${list(providers.map(providerName), "disjunction")} go straight to that provider.`
  );
  sentences.push("Everyone else is asked for a password.");
  return { sentences, warnings, localUrl: null };
}

/** The workspace's routing in sentences. `origin` is the address people reach the workspace at. */
export async function signInRoutingSummary(origin: string): Promise<SignInRoutingSummary> {
  if (!(await featureEnabled("sso"))) return { sentences: [EVERYONE_PASSWORD], warnings: [], localUrl: null };
  const [sso, saml] = await Promise.all([getSsoConfig(), getSamlConfig()]);
  return summarizeRouting(setupFrom(sso, saml), { oidcStuck: ssoConfigured(sso) && !oidcUsable(sso), origin });
}
