"use client";

// Left rail of the account settings shell. One entry per section; the
// current section is derived from the pathname.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BellRing, Cable, ShieldCheck, SlidersHorizontal, UserRound } from "lucide-react";

const SECTIONS = [
  { href: "/account", label: "Profile", icon: UserRound },
  { href: "/account/preferences", label: "Preferences", icon: SlidersHorizontal },
  { href: "/account/notifications", label: "Notifications", icon: BellRing },
  { href: "/account/security", label: "Security", icon: ShieldCheck },
  { href: "/account/tokens", label: "API tokens", icon: Cable },
];

export function AccountNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Account settings" className="md:sticky md:top-6">
      <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {SECTIONS.map((s) => {
          const active =
            s.href === "/account" ? pathname === "/account" : pathname.startsWith(s.href);
          const Icon = s.icon;
          return (
            <li key={s.href} className="shrink-0">
              <Link
                href={s.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "bg-compass-50 text-compass-700 dark:bg-compass-950/40"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-800"
                }`}
              >
                <Icon
                  className={`h-4 w-4 ${active ? "text-compass-600" : "text-slate-400"}`}
                  aria-hidden
                />
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
