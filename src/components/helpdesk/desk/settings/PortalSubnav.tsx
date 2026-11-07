"use client";

// Desk settings → Customer portal's pages (1.19.4, C3; STYLEGUIDE §Settings
// pages: a section with several jobs gets pages): Settings (on or off, what
// customers can ask for, who can use it, brand and protection), Help centre
// (the public articles customers search before raising a request) and
// Customers (who has used the portal, to block or unblock).

import { BookOpen, SlidersHorizontal, UsersRound } from "lucide-react";
import { SubNav } from "@/components/SubNav";

const ITEMS = [
  { href: "/desk/settings/portal", label: "Settings", icon: SlidersHorizontal },
  { href: "/desk/settings/portal/help-centre", label: "Help centre", icon: BookOpen },
  { href: "/desk/settings/portal/customers", label: "Customers", icon: UsersRound },
];

export function PortalSubnav() {
  return <SubNav label="Customer portal settings" items={ITEMS} root={ITEMS[0].href} />;
}
