"use client";

// Left rail of the account settings shell. One entry per section; the
// current section is derived from the pathname. Rows are the shared rail
// recipe (components/RailLink), so this rail and the settings rail match.

import { usePathname } from "next/navigation";
import { BellRing, Cable, ShieldCheck, SlidersHorizontal, UserRound } from "lucide-react";
import { RailLink } from "./RailLink";

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
          return (
            <li key={s.href} className="shrink-0">
              <RailLink href={s.href} icon={s.icon} label={s.label} active={active} />
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
