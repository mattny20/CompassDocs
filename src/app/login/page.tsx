import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { needsSetup } from "@/lib/db";
import { getSsoConfig, ssoConfigured } from "@/lib/sso-config";
import { featureEnabled } from "@/lib/ee";
import { LoginForm } from "@/components/LoginForm";
import { Brand } from "@/components/Brand";

export const dynamic = "force-dynamic";

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
  disabled: "Your account is disabled. Ask your administrator.",
  internal: "Something went wrong during sign-in. Please try again.",
};

/** Only same-app paths may be used as a post-login destination. */
function safeNext(next: string | undefined): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sso_error?: string; next?: string }>;
}) {
  // Fresh install with no admin yet → send to the first-run setup wizard.
  if (await needsSetup()) redirect("/setup");
  const user = await getCurrentUser();
  const paramsEarly = await searchParams;
  if (user) redirect(safeNext(paramsEarly.next));
  const [settings, ssoCfg, ssoLicensed, params] = await Promise.all([
    getAppSettings(),
    getSsoConfig(),
    featureEnabled("sso"),
    searchParams,
  ]);
  const ssoActive = ssoLicensed && ssoConfigured(ssoCfg);
  const ssoError = params.sso_error ? SSO_ERRORS[params.sso_error] || SSO_ERRORS.internal : "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-compass-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <Brand name={settings.company_name} logoUrl={settings.logo_url || undefined} size="lg" layout="col" />
          <p className="mt-1 text-sm text-slate-500">Sign in to your team&apos;s knowledge base</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
          {ssoError && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {ssoError}
            </div>
          )}
          {ssoActive && (
            <>
              <a
                href="/api/ee/sso/login"
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                {/* Microsoft logo — four squares */}
                <svg viewBox="0 0 21 21" className="h-4 w-4" aria-hidden>
                  <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                  <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                  <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                  <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                </svg>
                Sign in with Microsoft
              </a>
              {!ssoCfg.ssoOnly && (
                <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wider text-slate-400">
                  <span className="h-px flex-1 bg-slate-200" />
                  or
                  <span className="h-px flex-1 bg-slate-200" />
                </div>
              )}
            </>
          )}
          {!(ssoActive && ssoCfg.ssoOnly) && <LoginForm next={safeNext(params.next)} />}
        </div>
      </div>
    </div>
  );
}
