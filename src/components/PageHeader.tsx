// The page-title block every top-level page renders (STYLEGUIDE §Page
// skeleton): an optional back link, the lucide icon, the h1 at the
// page-title size, a one-line subtitle, and a right-aligned actions slot.
// One component so the thirteen title recipes it replaced cannot return.
// Server-safe.
//
// The heading ladder:
//   1. Page title        h1  text-2xl font-bold + 24px icon      (this)
//   2. Document title    h1  text-3xl font-bold tracking-tight    (the document is the thing itself: doc, share, public doc)
//   3. Section heading   h2  text-lg font-semibold                (a group of cards within a page)
//   4. Card title        h3  text-sm font-semibold                (one card)
//   5. Eyebrow / group   RAIL_GROUP_TEXT                          (rail groups, console and account eyebrows, table headers)
// Two documented exceptions: the dashboard greeting and the editor's sticky bar.

import { BackLink } from "./BackLink";

export function PageHeader({
  icon,
  title,
  subtitle,
  back,
  actions,
  className = "mb-6",
}: {
  /** A lucide icon element, sized and toned here. Omit only on standalone
   *  link pages (share, upload), where the h1 is the thing itself. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** The parent destination, for sub-pages. */
  back?: { href: string; label: React.ReactNode };
  /** Right-aligned controls (an export button, a Create action). */
  actions?: React.ReactNode;
  /** Replaces the default bottom margin. */
  className?: string;
}) {
  return (
    <div className={className}>
      {back && <BackLink href={back.href} label={back.label} />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            {icon && (
              <span className="shrink-0 text-compass-600 [&>svg]:h-6 [&>svg]:w-6" aria-hidden>
                {icon}
              </span>
            )}
            <span className="min-w-0">{title}</span>
          </h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
