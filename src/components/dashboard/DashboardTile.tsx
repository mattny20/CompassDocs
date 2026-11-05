// One dashboard section (1.17.0): a card with its title inside, an optional
// control or link on the title row, the body, and an optional footer row of
// links. Every home-dashboard section uses it so the tiles line up and share
// spacing (STYLEGUIDE §Dashboard tiles). Server-safe.

import type { ReactNode } from "react";

export function DashboardTile({
  id,
  title,
  actions,
  footer,
  flush = false,
  children,
  className = "",
}: {
  /** Section key (also the heading's id stem), e.g. "quick_links". */
  id: string;
  title: ReactNode;
  /** Right side of the title row: a small link, a count, icon buttons. */
  actions?: ReactNode;
  /** A bottom row under a hairline, usually one or two links. */
  footer?: ReactNode;
  /** Body runs edge to edge (tables, divided lists); otherwise it is inset. */
  flush?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const headingId = `dash-${id}-title`;
  return (
    <section
      aria-labelledby={headingId}
      data-dashboard-section={id}
      className={`min-w-0 rounded-xl border border-slate-200 bg-surface shadow-xs ${className}`.trim()}
    >
      <div className="flex min-h-14 items-center justify-between gap-3 px-4 pb-2 pt-3.5">
        <h2 id={headingId} className="text-lg font-semibold text-slate-900">
          {title}
        </h2>
        {actions && <div className="flex shrink-0 items-center gap-1.5 text-sm">{actions}</div>}
      </div>
      <div className={flush ? "" : "px-2 pb-2"}>{children}</div>
      {footer && (
        <div className="mx-4 flex items-center justify-between gap-3 border-t border-slate-100 py-2.5 text-sm">
          {footer}
        </div>
      )}
    </section>
  );
}

/** A small uppercase label inside a tile (e.g. "Pinned by you"). */
export function TileLabel({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-2 mb-1 mt-3 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:text-slate-400">
      {icon}
      {children}
    </div>
  );
}
