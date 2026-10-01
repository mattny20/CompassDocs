// The one navigation-row recipe for the three rails (sidebar, settings rail,
// account rail): one radius, one icon tone, one label size, one current-page
// marker. Before 1.5.1 each rail had its own copy and the differences showed
// whenever two of them sat side by side on a settings page.
//
// Server-safe: no hooks. The sidebar keeps its own <Link> (tooltips, badges,
// the collapsed rail) and composes the class helpers; the settings and account
// rails render <RailLink> directly.

import Link from "next/link";
import type { ComponentType, ReactNode } from "react";

/** The row box. `dense` is the settings/account rails' tighter row (py-1.5);
 *  the sidebar keeps py-2. `collapsed` centres the icon in the 4rem rail. */
export function railRowClass(
  active: boolean,
  { dense = false, collapsed = false }: { dense?: boolean; collapsed?: boolean } = {}
) {
  return [
    "flex items-center rounded-lg text-sm font-medium transition",
    dense ? "py-1.5" : "py-2",
    collapsed ? "justify-center px-0" : "gap-2 px-3",
    active ? "bg-compass-50 text-compass-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-800",
  ].join(" ");
}

/** Icon tone: accent on the current page, muted otherwise. Icons stay
 *  slate-400 (the text rule in STYLEGUIDE §Color does not apply to glyphs). */
export function railIconClass(active: boolean) {
  return `shrink-0 ${active ? "text-compass-600" : "text-slate-400"}`;
}

/** Group label text (Platform / Content / Spaces …) without box spacing. */
export const RAIL_GROUP_TEXT = "text-2xs font-semibold uppercase tracking-wider text-slate-500";

export function RailLink({
  href,
  icon: Icon,
  label,
  active,
  dense = true,
  children,
}: {
  href: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  active: boolean;
  dense?: boolean;
  /** Trailing content (a count chip). */
  children?: ReactNode;
}) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={railRowClass(active, { dense })}>
      <Icon className={`h-4 w-4 ${railIconClass(active)}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
    </Link>
  );
}

/** A rail group heading, spaced for a stack of rows. */
export function RailGroupLabel({
  as: Tag = "p",
  children,
  className = "",
}: {
  as?: "p" | "h2" | "h3";
  children: ReactNode;
  className?: string;
}) {
  return <Tag className={`${RAIL_GROUP_TEXT} mb-0.5 mt-3 px-3 first:mt-1 ${className}`}>{children}</Tag>;
}
