"use client";

// The one sub-navigation (STYLEGUIDE §Settings pages): a section with
// several jobs gets pages, and this row switches between them under the
// section header. Started life as the directory's tab bar; Notifications
// (channels / email templates) and, later, Roles and Workspace use it too.
// The tabs come from lib/settings-sections (`pages`), so the rail search
// and this row can never disagree about what a section contains.

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { settingsPages } from "@/lib/settings-sections";

export interface SubNavItem {
  href: string;
  label: string;
  icon?: LucideIcon;
}

export function SubNav({
  label,
  section,
  items: given,
  root,
  className = "",
}: {
  /** The accessible name of the row ("Directory settings"). */
  label: string;
  /** A settings section href: its `pages` become the tabs. Resolved here, on
   *  the client, because icon components cannot cross from a server layout. */
  section?: string;
  items?: readonly SubNavItem[];
  /** The first tab's href: exact match only, so it doesn't light for every sub-page. */
  root?: string;
  className?: string;
}) {
  const path = usePathname();
  const items = given ?? (section ? settingsPages(section) : []);
  const base = root ?? items[0]?.href;
  return (
    <nav aria-label={label} className={`mb-5 flex gap-1 overflow-x-auto border-b border-slate-200 ${className}`.trim()}>
      {items.map((t) => {
        const active = t.href === base ? path === t.href : path === t.href || path.startsWith(`${t.href}/`);
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition ${
              active
                ? "border-compass-600 text-compass-700"
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"
            }`}
          >
            {Icon && <Icon className="h-4 w-4" aria-hidden />}
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
