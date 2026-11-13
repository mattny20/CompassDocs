import { redirect } from "next/navigation";
import { preload } from "react-dom";
import { currentSession } from "@/lib/auth";
import { duoStepHref } from "@/lib/duo-policy";
import { getAppSettings } from "@/lib/settings-store";
import { needsSetup } from "@/lib/db";
import { providerStart, providersOf, signInSetup } from "@/lib/sign-in-routing";
import { getSignInLook } from "@/lib/sign-in-art";
import { ART_SIZES } from "@/lib/sign-in-text";
import { safeReturnPath } from "@/lib/return-to";
import { ssoErrorMessage } from "@/lib/sso-error";
import { signInLinks } from "@/components/auth/SignInLinksBar";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignInFlow, type SignInMode } from "@/components/auth/SignInFlow";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in", robots: { index: false, follow: false } };

// The sign-in page (1.16.0, STYLEGUIDE §Sign-in surfaces): AuthShell's
// cover and column, and SignInFlow's steps. Which steps, decided here:
//   no usable SSO provider (community build, nothing configured) → one
//   combined form, no lookup; ?local=1 with SSO → the same, the break-glass;
//   otherwise email or username first (lib/sign-in-routing).
// A ?sso_error code becomes its sentence in lib/sso-error. The links an
// admin put on the sign-in page (1.17.0) ride in the cover.

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sso_error?: string | string[]; next?: string; local?: string }>;
}) {
  // Fresh install with no admin yet → send to the first-run setup wizard.
  if (await needsSetup()) redirect("/setup");
  const params = await searchParams;
  // Already signed in: straight to the page they wanted (lib/return-to keeps
  // this on-site, never the sign-in page or an API route).
  const next = safeReturnPath(params.next);
  // 1.20.5: signed in but the Duo check is still owed: on to that step, not back to this form.
  const session = await currentSession();
  if (session) redirect(session.duo.signIn ? duoStepHref(next) : next);

  const [settings, setup, look, links] = await Promise.all([
    getAppSettings(),
    signInSetup(),
    getSignInLook(),
    signInLinks(),
  ]);
  const providers = providersOf(setup).map((p) => ({ ...p, start: providerStart(p.id, next) }));
  const mode: SignInMode = providers.length === 0 ? "combined" : params.local === "1" ? "local" : "identify";
  const ssoError = ssoErrorMessage(params.sso_error);
  if (look.art) {
    preload(look.art.src, { as: "image", imageSrcSet: look.art.srcSet, imageSizes: ART_SIZES, fetchPriority: "high" });
  }

  return (
    <AuthShell look={look} company={settings.company_name} logoUrl={settings.logo_url || undefined} links={links}>
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
