// The sign-in page's quick links (1.17.0, STYLEGUIDE §Sign-in surfaces): the
// links an admin marked "Sign-in page" in Settings → Links (only links with
// no group restriction may be), at most eight, by position. They live in the
// cover, after the form in DOM and tab order: a translucent bar across the
// middle of the cover from 64rem, a scrolling strip along the bottom of the
// band below. The one deliberate exception to the Card/Stage rule: these are
// the only controls on the art, and nothing essential to signing in is here.
// Each opens in a new tab and is counted by the same-origin click beacon
// (TrackedLink) without touching its href; the admin preview passes
// track={false} so trying the page does not count. Server-safe.

import { ExternalLink } from "lucide-react";
import { TrackedLink } from "@/components/TrackedLink";
import { listSignInLinks } from "@/lib/quick-links";

export type SignInLinkItem = Awaited<ReturnType<typeof listSignInLinks>>[number];

/** The most the bar ever shows (listSignInLinks caps it too). */
export const SIGN_IN_LINKS_MAX = 8;

/**
 * The sign-in links for an AuthShell page. A convenience, so a failure to
 * read them (a database mid-upgrade) never stops anyone signing in: the
 * cover is drawn without them and the error is logged.
 */
export async function signInLinks(): Promise<SignInLinkItem[]> {
  try {
    return await listSignInLinks();
  } catch (e) {
    console.error("[sign-in] could not load the sign-in links:", e);
    return [];
  }
}

export function SignInLinksBar({ links, track = true }: { links: SignInLinkItem[]; track?: boolean }) {
  const shown = links.slice(0, SIGN_IN_LINKS_MAX);
  if (!shown.length) return null;
  return (
    <nav className="auth-links" aria-label="Quick links">
      {/* The nav's name already says it; this is the wide cover's caption. */}
      <p className="auth-links-label" aria-hidden>
        Quick links
      </p>
      <ul className="auth-links-list">
        {shown.map((link) => {
          const body = (
            <>
              <span className="auth-link-icon" aria-hidden>
                {link.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={link.iconUrl} alt="" decoding="async" loading="lazy" />
                ) : (
                  link.letter
                )}
              </span>
              {/* A long title truncates; the full one is content, so a plain
                  title on the text is allowed (§Tooltips). */}
              <span className="auth-link-title" title={link.title.length > 28 ? link.title : undefined}>
                {link.title}
              </span>
              <ExternalLink className="auth-link-ext" aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </>
          );
          const props = {
            href: link.url,
            target: "_blank",
            rel: "noopener noreferrer",
            className: "auth-link",
          };
          return (
            <li key={link.id}>
              {track ? (
                <TrackedLink {...props} linkId={link.id}>
                  {body}
                </TrackedLink>
              ) : (
                <a {...props}>{body}</a>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
