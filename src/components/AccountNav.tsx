"use client";

// Left rail of the account settings pages. One entry per section from
// lib/account-sections; the current section is derived from the pathname.
// Rows are the shared rail recipe (components/RailLink), so this rail and
// the settings rail match.

import { usePathname } from "next/navigation";
import { ACCOUNT_SECTIONS } from "@/lib/account-sections";
import { RailLink } from "./RailLink";

export function AccountNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Account settings"
      className="flex shrink-0 gap-1 overflow-x-auto sm:w-rail sm:flex-col sm:overflow-visible"
    >
      {ACCOUNT_SECTIONS.map((s) => {
        const active = s.href === "/account" ? pathname === "/account" : pathname.startsWith(s.href);
        return (
          <span key={s.href} className="shrink-0 whitespace-nowrap">
            <RailLink href={s.href} icon={s.icon} label={s.label} active={active} />
          </span>
        );
      })}
    </nav>
  );
}
