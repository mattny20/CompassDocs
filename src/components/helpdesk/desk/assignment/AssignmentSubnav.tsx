"use client";

// Settings → Assignment's pages (STYLEGUIDE §Settings pages: a section with
// several jobs gets pages): Teams (each team's mode and people), Rules (the
// ordered rules that run first) and On call (the rota). Each tab shows only
// for the capability its page needs.

import { ListOrdered, PhoneCall, Users } from "lucide-react";
import { SubNav } from "@/components/SubNav";

export function AssignmentSubnav({ teams, rules }: { teams: boolean; rules: boolean }) {
  const items = [
    ...(teams ? [{ href: "/desk/settings/assignment", label: "Teams", icon: Users }] : []),
    ...(rules ? [{ href: "/desk/settings/assignment/rules", label: "Rules", icon: ListOrdered }] : []),
    ...(teams ? [{ href: "/desk/settings/assignment/on-call", label: "On call", icon: PhoneCall }] : []),
  ];
  if (items.length < 2) return null;
  return <SubNav label="Assignment settings" items={items} root={items[0].href} />;
}
