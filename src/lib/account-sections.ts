// The account settings sections, as data: the rail (AccountNav) and each
// page's header (AccountPage) read the same label, icon and description, so
// the two cannot drift — the same arrangement lib/settings-sections gives
// the admin console.

import { BellRing, Cable, ShieldCheck, SlidersHorizontal, UserRound, type LucideIcon } from "lucide-react";

export interface AccountSection {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const ACCOUNT_SECTIONS: AccountSection[] = [
  { href: "/account", label: "Profile", icon: UserRound, description: "Who you are across the workspace." },
  {
    href: "/account/preferences",
    label: "Preferences",
    icon: SlidersHorizontal,
    description: "Personal defaults — they override the workspace settings just for you.",
  },
  {
    href: "/account/notifications",
    label: "Notifications",
    icon: BellRing,
    description: "Choose what reaches you, and where — the bell inbox, email, or a chat webhook.",
  },
  {
    href: "/account/security",
    label: "Security",
    icon: ShieldCheck,
    description: "Password, two-factor authentication, and your signed-in devices.",
  },
  {
    href: "/account/tokens",
    label: "API tokens",
    icon: Cable,
    description: "Personal tokens for the Claude connector and other integrations.",
  },
];

export function accountSection(href: string): AccountSection | undefined {
  return ACCOUNT_SECTIONS.find((s) => s.href === href);
}
