import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { providersOf, signInSetup } from "@/lib/sign-in-routing";
import { getSignInLook, type SignInLook } from "@/lib/sign-in-art";
import {
  asFocus,
  asSide,
  helpUrlProblem,
  lengthProblem,
  normalizeSignInText,
  type SignInTextKey,
} from "@/lib/sign-in-text";
import { DEMO_PROVIDERS } from "@/lib/sign-in-demo";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignInFlow, type SignInMode } from "@/components/auth/SignInFlow";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign-in preview", robots: { index: false, follow: false } };

// The sign-in page as the admin is editing it (1.16.0, Settings → Workspace
// → Sign-in page). The real AuthShell and SignInFlow, with the demo
// transport (lib/sign-in-demo): nothing typed here is sent anywhere. The
// form's unsaved values arrive in the query and are laid over the stored
// look after the same normalisation the save applies; a value the save
// would refuse is ignored, so the stored one shows. Lives under /login,
// which lib/return-to already refuses as a return path.
//
//   ?frame=1        inside the settings page's iframe: the theme comes from
//                   ?theme (light|dark) and the admin's interface scale is
//                   dropped, so the frame renders at the real device size
//   ?flow=identify  the email-first steps, whatever the workspace's mode
//   ?art=none       the default art (the artwork was just removed)

type Query = Partial<Record<string, string | string[]>>;

const TEXT_KEYS: SignInTextKey[] = ["headline", "tagline", "caption", "help", "help_url", "example"];

function one(q: Query, key: string): string | undefined {
  const v = q[key];
  return Array.isArray(v) ? v[0] : v;
}

/** The stored look with the form's values laid over it. */
function withOverrides(look: SignInLook, q: Query): SignInLook {
  const out: SignInLook = { ...look };
  for (const key of TEXT_KEYS) {
    const raw = one(q, key);
    if (raw === undefined) continue;
    const value = normalizeSignInText(raw);
    if (lengthProblem(key, value)) continue;
    if (key === "help_url" && helpUrlProblem(value)) continue;
    out[key] = value;
  }
  if (one(q, "focus") !== undefined) out.focus = asFocus(one(q, "focus"));
  if (one(q, "side") !== undefined) out.side = asSide(one(q, "side"));
  const text = one(q, "text");
  if (text === "1" || text === "0") out.show_text = text === "1";
  if (one(q, "art") === "none") out.art = null;
  out.showText = !out.art || out.show_text;
  return out;
}

export default async function SignInPreviewPage({ searchParams }: { searchParams: Promise<Query> }) {
  await requirePermission("admin", "workspace.branding_manage");
  const q = await searchParams;
  const [settings, setup, stored] = await Promise.all([getAppSettings(), signInSetup(), getSignInLook()]);
  const look = withOverrides(stored, q);
  const framed = one(q, "frame") === "1";
  const theme = one(q, "theme") === "dark" ? "dark" : "light";
  const mode: SignInMode = one(q, "flow") === "identify" || providersOf(setup).length > 0 ? "identify" : "combined";

  return (
    <>
      {framed && (
        // Before the shell is parsed, so the frame never paints in the
        // admin's own theme or interface scale first.
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var d=document.documentElement;d.setAttribute('data-theme','${theme}');d.removeAttribute('data-ui-scale');})();`,
          }}
        />
      )}
      <AuthShell look={look} company={settings.company_name} logoUrl={settings.logo_url || undefined}>
        {!framed && <PreviewNotice mode={mode} identifyHref={identifyHref(q)} />}
        <SignInFlow
          key={mode}
          mode={mode}
          ssoOnly={setup.ssoOnly}
          next="/"
          company={settings.company_name}
          providers={DEMO_PROVIDERS}
          help={look.help || look.help_url ? { text: look.help, url: look.help_url } : undefined}
          example={look.example || undefined}
          demo
        />
      </AuthShell>
    </>
  );
}

/** This preview, the same overrides, on the email-first steps. */
function identifyHref(q: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (k !== "flow" && v !== undefined) params.set(k, Array.isArray(v) ? v[0] : v);
  params.set("flow", "identify");
  return `/login/preview?${params.toString()}`;
}

function PreviewNotice({ mode, identifyHref }: { mode: SignInMode; identifyHref: string }) {
  return (
    <div className="notice-warn mb-6 rounded-lg border px-3 py-2 text-sm">
      {mode === "identify" ? (
        <>
          Preview. Nothing you type here is sent anywhere. Try name@sso.example for single sign-on, name@both.example
          for a choice, or the password 2fa for a code step (123456).
        </>
      ) : (
        <>
          Preview. Nothing you type here is sent anywhere. Try the password 2fa for a code step (123456), or{" "}
          <Link href={identifyHref} className="link font-medium">
            the email-first steps
          </Link>{" "}
          people see once single sign-on is on.
        </>
      )}
    </div>
  );
}
