// The sign-in shell (1.16.0, STYLEGUIDE §Sign-in surfaces): the form column
// and the cover. <main> comes first in the DOM, so the keyboard and a
// screen reader reach the heading and the field before the art; the grid
// puts the cover on the side the admin chose. Used by /login, its admin
// preview and the forced password change. Server-safe. `links` are the
// sign-in page's quick links (1.17.0, SignInLinksBar), drawn in the cover;
// `trackLinks` is off in the admin preview.

import { BrandTile } from "@/components/Brand";
import type { SignInLook } from "@/lib/sign-in-art";
import { AuthArt } from "./AuthArt";
import type { SignInLinkItem } from "./SignInLinksBar";

export function AuthShell({
  look,
  company,
  logoUrl,
  links = [],
  trackLinks = true,
  children,
}: {
  look: SignInLook;
  company: string;
  logoUrl?: string;
  links?: SignInLinkItem[];
  trackLinks?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="auth-shell" data-side={look.side}>
      <main id="main" tabIndex={-1} className="auth-main">
        <div className="auth-col">
          {/* The column carries the brand when the cover does not: on screen
              when the photo carries no words, and always in print, which
              hides the cover. */}
          <div className={`mb-8 min-w-0 items-center gap-3 ${look.showText ? "hidden print:flex" : "flex"}`}>
            <BrandTile logoUrl={logoUrl} className="h-8 w-8 ring-1 ring-slate-200" />
            <span className="min-w-0 truncate text-base font-semibold text-slate-900">{company}</span>
          </div>
          {children}
        </div>
      </main>
      <AuthArt look={look} company={company} logoUrl={logoUrl} links={links} trackLinks={trackLinks} />
    </div>
  );
}
