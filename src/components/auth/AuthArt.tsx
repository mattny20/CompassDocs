// The sign-in cover (1.16.0, STYLEGUIDE §Sign-in surfaces): the admin's
// photo or the default art drawn from the accent, with the workspace name,
// headline, tagline and caption over it. Brand and decoration only, never
// a control (the Card/Stage rule): the form repeats the company name in its
// subtitle. With the text switched off over a photo the cover is pure art
// (aria-hidden) and the form column carries the lockup instead. Server-safe.

import type { CSSProperties } from "react";
import { BrandTile } from "@/components/Brand";
import type { SignInLook } from "@/lib/sign-in-art";
import { ART_SIZES, FOCUS_POSITION, lenTier } from "@/lib/sign-in-text";
import { CompassBezel } from "./CompassBezel";

export function AuthArt({ look, company, logoUrl }: { look: SignInLook; company: string; logoUrl?: string }) {
  const display = look.headline || company;
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
      aria-label={look.showText ? `About ${company}` : undefined}
      aria-hidden={look.showText ? undefined : true}
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
      {look.showText && (
        <div className="auth-art-content">
          <div className="auth-art-top">
            <BrandTile logoUrl={logoUrl} className="auth-art-tile" />
            <span className="auth-art-name">{company}</span>
          </div>
          <div className="auth-art-foot">
            <p className="auth-display" data-len={lenTier(display)}>
              {display}
            </p>
            {look.tagline && <p className="auth-tagline">{look.tagline}</p>}
            {look.caption && <p className="auth-caption">{look.caption}</p>}
          </div>
        </div>
      )}
    </Tag>
  );
}
