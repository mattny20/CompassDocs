// The sign-in cover (1.16.0, STYLEGUIDE §Sign-in surfaces): the admin's
// photo or the default art drawn from the accent, with the workspace name,
// headline, tagline and caption over it. Brand and decoration only, never
// a control (the Card/Stage rule), with one deliberate exception (1.17.0):
// the sign-in page's quick links (SignInLinksBar), between the lockup and
// the headline in the DOM, a bar across the middle of the cover or a strip
// along the bottom of the band. The first and password steps name the
// workspace in their subtitle, and print shows the column's lockup in place
// of the cover. With the text switched off over a photo the cover is pure
// art (aria-hidden, unless it carries links) and the column shows the
// lockup on screen too. Server-safe.

import type { CSSProperties } from "react";
import { BrandTile } from "@/components/Brand";
import type { SignInLook } from "@/lib/sign-in-art";
import { ART_SIZES, FOCUS_POSITION, lenTier } from "@/lib/sign-in-text";
import { CompassBezel } from "./CompassBezel";
import { SignInLinksBar, type SignInLinkItem } from "./SignInLinksBar";

export function AuthArt({
  look,
  company,
  logoUrl,
  links = [],
  trackLinks = true,
}: {
  look: SignInLook;
  company: string;
  logoUrl?: string;
  links?: SignInLinkItem[];
  trackLinks?: boolean;
}) {
  const display = look.headline || company;
  const hasLinks = links.length > 0;
  const Tag = look.showText ? "aside" : "div";
  const style = {
    ...(look.art ? { "--art-tone": look.art.color } : {}),
    "--art-focus": FOCUS_POSITION[look.focus],
  } as CSSProperties;
  return (
    <Tag
      className="auth-art"
      data-art={look.art ? "photo" : "default"}
      data-headline={look.headline ? "1" : "0"}
      data-links={hasLinks ? "1" : undefined}
      aria-label={look.showText ? `About ${company}` : undefined}
      // Pure art hides itself, but never a control: with links the art
      // layers stay hidden on their own (.auth-art-bg) and the nav is read.
      aria-hidden={look.showText || hasLinks ? undefined : true}
      style={style}
    >
      <div className="auth-art-bg" aria-hidden>
        {look.art ? (
          <>
            {look.art.placeholder && <div className="auth-art-layer auth-art-blur" style={{ backgroundImage: `url(${look.art.placeholder})` }} />}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="auth-art-layer auth-art-img"
              src={look.art.src}
              srcSet={look.art.srcSet}
              sizes={ART_SIZES}
              alt=""
              decoding="async"
              fetchPriority="high"
            />
          </>
        ) : (
          <>
            <div className="auth-art-layer auth-art-mesh" />
            <CompassBezel className="auth-art-layer auth-art-bezel" />
            <div className="auth-art-layer auth-art-grain" />
          </>
        )}
      </div>
      {(look.showText || hasLinks) && (
        <div className="auth-art-content">
          {look.showText && (
            <div className="auth-art-top">
              <BrandTile logoUrl={logoUrl} className="auth-art-tile" />
              <span className="auth-art-name">{company}</span>
            </div>
          )}
          {hasLinks && <SignInLinksBar links={links} track={trackLinks} />}
          {look.showText && (
            <div className="auth-art-foot">
              <p className="auth-display" data-len={lenTier(display)}>
                {display}
              </p>
              {look.tagline && <p className="auth-tagline">{look.tagline}</p>}
              {look.caption && <p className="auth-caption">{look.caption}</p>}
            </div>
          )}
        </div>
      )}
    </Tag>
  );
}
