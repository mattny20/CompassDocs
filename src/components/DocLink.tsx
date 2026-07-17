"use client";

// External links in rendered documents/newsletters: a subtle chip with the
// target site's favicon (served through our cached proxy). Internal links
// render as ordinary accent links. The favicon hides itself if the site has
// none (or the viewer is anonymous — the proxy needs a session).

import { useState } from "react";

export function externalHost(href?: string): string | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  try {
    const u = new URL(href);
    if (typeof window !== "undefined" && u.host === window.location.host) return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function DocLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const host = externalHost(href);
  const [iconOk, setIconOk] = useState(true);

  if (!host) {
    return <a href={href}>{children}</a>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="ext-link">
      {iconOk && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/favicon?host=${encodeURIComponent(host)}`}
          alt=""
          loading="lazy"
          className="ext-link-icon"
          onError={() => setIconOk(false)}
        />
      )}
      {children}
    </a>
  );
}
