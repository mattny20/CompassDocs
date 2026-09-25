"use client";

// The directory settings are five jobs — people, fields, offices, export,
// sync — and one page holding all of them ran to several screens with a save
// button in every card. Each job gets a page under /admin/directory and this
// row switches between them; the section header above stays the same.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, FileDown, ListChecks, RefreshCw, Users } from "lucide-react";

export const DIRECTORY_TABS = [
  { href: "/admin/directory", label: "People", icon: Users },
  { href: "/admin/directory/fields", label: "Fields", icon: ListChecks },
  { href: "/admin/directory/offices", label: "Offices", icon: Building2 },
  { href: "/admin/directory/export", label: "Export", icon: FileDown },
  { href: "/admin/directory/sync", label: "Sync", icon: RefreshCw },
] as const;

export function DirectorySubnav() {
  const path = usePathname();
  return (
    <nav aria-label="Directory settings" className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
      {DIRECTORY_TABS.map((t) => {
        const active = t.href === "/admin/directory" ? path === t.href : path === t.href || path.startsWith(`${t.href}/`);
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
            <Icon className="h-4 w-4" aria-hidden />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
