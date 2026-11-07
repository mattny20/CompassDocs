"use client";

// Small client pieces of the help centre (Helpdesk 1.19.4, C3): an article
// link that tells the stats an article was opened (journey "open"), and an
// article's date in the reader's own zone (only the text may change on
// hydration, as PortalTime).

import Link from "next/link";
import { journeyStep } from "./journey";

export function ArticleLink({ href, className, children, newTab = false }: { href: string; className?: string; children: React.ReactNode; newTab?: boolean }) {
  return (
    <Link
      href={href}
      className={className}
      onClick={() => journeyStep("open")}
      {...(newTab ? { target: "_blank", rel: "noopener" } : {})}
    >
      {children}
    </Link>
  );
}

/** "4 Nov 2026" in the reader's own zone. */
export function ArticleDate({ value }: { value: string }) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return <time dateTime={d.toISOString()} suppressHydrationWarning>{new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(d)}</time>;
}
