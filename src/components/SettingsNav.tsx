"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { href: "/admin", label: "System", icon: "🖥️" },
  { href: "/admin/workspace", label: "Workspace", icon: "🎨" },
  { href: "/admin/domain", label: "Domain & HTTPS", icon: "🌐" },
  { href: "/admin/users", label: "Users & roles", icon: "👥" },
  { href: "/admin/backups", label: "Backups", icon: "💾" },
  { href: "/admin/data", label: "Import & export", icon: "📦" },
];

export function SettingsNav() {
  const path = usePathname();
  return (
    <nav className="flex shrink-0 gap-1 overflow-x-auto sm:w-52 sm:flex-col">
      {SECTIONS.map((s) => {
        const active = path === s.href;
        return (
          <Link
            key={s.href}
            href={s.href}
            className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
              active
                ? "bg-compass-50 text-compass-700"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <span aria-hidden>{s.icon}</span>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
