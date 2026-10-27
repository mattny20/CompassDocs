import { headers } from "next/headers";
import { requirePermission } from "@/lib/auth";
import { userHolds } from "@/lib/access";
import { getAppSettings } from "@/lib/settings-store";
import { getSignInArt, getSignInText } from "@/lib/sign-in-art";
import { signInRoutingSummary } from "@/lib/sign-in-routing-summary";
import { settingsMetadata } from "@/lib/settings-sections";
import { SignInPageSettings } from "@/components/SignInPageSettings";

export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/workspace", "Sign-in page");

// Settings → Workspace → Sign-in page (1.16.0): the artwork, the text over
// it, the help under the form, and, for whoever may read the single sign-on
// settings, how people will actually sign in. Under the Workspace layout's
// header and tab row like Branding and Content.
export default async function WorkspaceSignInPage() {
  const user = await requirePermission("admin", "workspace.branding_manage");
  const [text, art, settings, canReadSso] = await Promise.all([
    getSignInText(),
    getSignInArt(),
    getAppSettings(),
    userHolds(user, "identity.sso_read", { legacyMin: "admin" }),
  ]);

  let routing = null;
  if (canReadSso) {
    const h = await headers();
    const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || "http";
    const host = h.get("x-forwarded-host")?.split(",")[0].trim() || h.get("host") || "localhost";
    const origin = settings.custom_domain ? `https://${settings.custom_domain}` : `${proto}://${host}`;
    routing = await signInRoutingSummary(origin);
  }

  return (
    <SignInPageSettings
      initial={text}
      art={art ? { version: art.version, width: art.width, height: art.height } : null}
      routing={routing}
    />
  );
}
