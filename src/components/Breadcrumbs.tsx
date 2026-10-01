// The one breadcrumb trail (the document and public document pages): a named
// landmark, separators hidden from readers, long titles truncated with a
// tooltip, hidden in print. Server-safe.

import Link from "next/link";

export interface Crumb {
  href: string;
  label: React.ReactNode;
  /** The full text when `label` may truncate (tooltip + accessible name). */
  title?: string;
}

export function Breadcrumbs({
  items,
  trailing,
  className = "mb-4",
}: {
  items: Crumb[];
  /** Right-aligned control on the same row (a print button). */
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={`flex items-center gap-1.5 text-sm text-slate-500 print:hidden ${className}`}
    >
      {items.map((c, i) => (
        <span key={`${c.href}-${i}`} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span aria-hidden>/</span>}
          <Link
            href={c.href}
            className="max-w-48 truncate hover:text-slate-700"
            data-tt={c.title}
            aria-label={c.title}
          >
            {c.label}
          </Link>
        </span>
      ))}
      {trailing && <span className="ml-auto">{trailing}</span>}
    </nav>
  );
}
