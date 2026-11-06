"use client";

// The Calendars section's pages (STYLEGUIDE §Settings pages: a section with
// several jobs gets pages): Office hours, Holidays, Test a due time.

import { CalendarClock, CalendarDays, Timer } from "lucide-react";
import { SubNav } from "@/components/SubNav";

const ITEMS = [
  { href: "/desk/settings/calendars", label: "Office hours", icon: CalendarClock },
  { href: "/desk/settings/calendars/holidays", label: "Holidays", icon: CalendarDays },
  { href: "/desk/settings/calendars/test", label: "Test a due time", icon: Timer },
];

export function CalendarsSubnav() {
  return <SubNav label="Calendar settings" items={ITEMS} root="/desk/settings/calendars" />;
}
