import { redirect } from "next/navigation";
import { preload } from "react-dom";
import { getCurrentUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { needsSetup } from "@/lib/db";
import { providerStart, providersOf, signInSetup } from "@/lib/sign-in-routing";
import { getSignInLook } from "@/lib/sign-in-art";
import { ART_SIZES } from "@/lib/sign-in-text";
import { safeReturnPath } from "@/lib/return-to";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignInFlow, type SignInMode } from "@/components/auth/SignInFlow";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in", robots: { index: false, follow: false } };

// The sign-in page (1.16.0, STYLEGUIDE §Sign-in surfaces): AuthShell's
// cover and column, and SignInFlow's steps. Which steps, decided here:
//   no usable SSO provider (community build, nothing configured) → one
//   combined form, no lookup; ?local=1 with SSO → the same, the break-glass;
//   otherwise email or username first (lib/sign-in-routing).

// Short error codes from the SSO callback → human messages. Codes (not raw
// messages) cross the redirect so nothing sensitive lands in the URL.
const SSO_ERRORS: Record<string, string> = {
  not_configured: "Single sign-on isn't fully configured. Ask your administrator.",
  idp: "Your identity provider reported an error. Please try again.",
  state: "The sign-in attempt expired or was tampered with. Please try again.",
  exchange: "Couldn't complete sign-in with your identity provider.",
  token: "Your identity provider returned an invalid token.",
  no_email: "Your identity provider didn't share an email address.",
  domain: "Your email domain isn't allowed to sign in here.",
  no_account: "No account exists for you, and automatic account creation is off.",
  link_denied:
    "An account with your email already exists and can't be linked to SSO automatically. Ask your administrator to link it.",
  disabled: "Your account is disabled. Ask your administrator.",
  internal: "Something went wrong during sign-in. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sso_error?: string; next?: string; local?: string }>;
}) {
  // Fresh install with no admin yet → send to the first-run setup wizard.
  if (await needsSetup()) redirect("/setup");
  const params = await searchParams;
  // Already signed in: straight to the page they wanted (lib/return-to keeps
  // this on-site, never the sign-in page or an API route).
  const next = safeReturnPath(params.next);
  if (await getCurrentUser()) redirect(next);

  const [settings, setup, look] = await Promise.all([getAppSettings(), signInSetup(), getSignInLook()]);
  const providers = providersOf(setup).map((p) => ({ ...p, start: providerStart(p.id, next) }));
  const mode: SignInMode = providers.length === 0 ? "combined" : params.local === "1" ? "local" : "identify";
  const ssoError = params.sso_error ? SSO_ERRORS[params.sso_error] || SSO_ERRORS.internal : undefined;
  if (look.art) {
    preload(look.art.src, { as: "image", imageSrcSet: look.art.srcSet, imageSizes: ART_SIZES, fetchPriority: "high" });
  }

  return (
    <AuthShell look={look} company={settings.company_name} logoUrl={settings.logo_url || undefined}>
      <SignInFlow
        mode={mode}
        ssoOnly={setup.ssoOnly}
        next={next}
        company={settings.company_name}
        providers={providers}
        ssoError={ssoError}
        help={look.help || look.help_url ? { text: look.help, url: look.help_url } : undefined}
        example={look.example || undefined}
      />
    </AuthShell>
  );
}
