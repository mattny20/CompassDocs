"use client";

// An <a> to a curated link (1.17.0) that records the click with
// trackLinkClick: a plain click, and a middle click (auxclick, button 1),
// which opens a background tab without firing click. The href is the link's
// real address, so copy, hover and right-click → open behave as before.

import { trackLinkClick } from "@/lib/link-beacon";

export function TrackedLink({
  linkId,
  onClick,
  onAuxClick,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { linkId: number }) {
  return (
    <a
      {...props}
      onClick={(e) => {
        trackLinkClick(linkId);
        onClick?.(e);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) trackLinkClick(linkId);
        onAuxClick?.(e);
      }}
    />
  );
}
