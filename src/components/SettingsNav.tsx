"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Monitor,
  Palette,
  FolderKanban,
  Sparkles,
  KeyRound,
  Globe,
  Users,
  BookUser,
  ScrollText,
  DatabaseBackup,
  Package,
} from "lucide-react";

const ICON = "h-4 w-4";
const SECTIONS = [
  { href: "/admin", label: "System", icon: <Monitor className={ICON} /> },
  { href: "/admin/workspace", label: "Workspace", icon: <Palette className={ICON} /> },
  { href: "/admin/spaces", label: "Spaces", icon: <FolderKanban className={ICON} /> },
  { href: "/admin/ai", label: "AI", icon: <Sparkles className={ICON} /> },
  { href: "/admin/license", label: "License", icon: <KeyRound className={ICON} /> },
  { href: "/admin/domain", label: "Domain & HTTPS", icon: <Globe className={ICON} /> },
  { href: "/admin/users", label: "Users & roles", icon: <Users className={ICON} /> },
  { href: "/admin/directory", label: "Directory", icon: <BookUser className={ICON} /> },
  { href: "/admin/audit", label: "Audit log", icon: <ScrollText className={ICON} /> },
  { href: "/admin/backups", label: "Backups", icon: <DatabaseBackup className={ICON} /> },
  { href: "/admin/data", label: "Import & export", icon: <Package className={ICON} /> },
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
