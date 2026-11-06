// The desk settings pages, grouped, and which desk capability opens each
// (agent J's roles). Plain module: the client rail and the server
// /desk/settings redirect both read it.

import {
  BellRing,
  Contact,
  FileText,
  Plug,
  Shuffle,
  CalendarClock,
  Clock,
  LifeBuoy,
  ListChecks,
  Mail,
  ShieldCheck,
  Star,
  Users,
  UsersRound,
  Zap,
  Bot,
  type LucideIcon,
} from "lucide-react";

export interface SettingsNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** Which capability opens each page (mirrors SETTINGS_CAP in app/(desk)/desk-access). */
const NEED: Record<string, string[]> = {
  "/desk/setup": ["settings.manage"],
  "/desk/settings/teams": ["teams.manage"],
  "/desk/settings/request-types": ["request_types.manage"],
  "/desk/settings/sla": ["sla.manage"],
  "/desk/settings/calendars": ["sla.manage"],
  "/desk/settings/email": ["channels.manage"],
  "/desk/settings/email-templates": ["templates.manage"],
  "/desk/settings/automations": ["automations.manage"],
  "/desk/settings/macros": ["macros.manage_all", "macros.manage_team", "macros.manage_personal"],
  "/desk/settings/csat": ["csat.manage"],
  "/desk/settings/assignment": ["agents.manage_team", "automations.manage"],
  "/desk/settings/contact-cards": ["settings.manage"],
  "/desk/settings/integrations": ["settings.manage", "channels.manage"],
  "/desk/settings/agents": ["agents.manage_team", "agents.assign_roles"],
  "/desk/settings/roles": ["roles.manage"],
};

const HELPDESK: SettingsNavItem[] = [
  { href: "/desk/setup", label: "Setup", icon: LifeBuoy },
  { href: "/desk/settings/teams", label: "Teams", icon: Users },
  { href: "/desk/settings/request-types", label: "Request types", icon: ListChecks },
  { href: "/desk/settings/sla", label: "Reply targets", icon: Clock },
  { href: "/desk/settings/calendars", label: "Calendars", icon: CalendarClock },
  { href: "/desk/settings/email", label: "Email", icon: Mail },
  { href: "/desk/settings/email-templates", label: "Email templates", icon: FileText },
  { href: "/desk/settings/integrations", label: "Integrations", icon: Plug },
  { href: "/desk/settings/assignment", label: "Assignment", icon: Shuffle },
  { href: "/desk/settings/contact-cards", label: "Contact cards", icon: Contact },
  { href: "/desk/settings/automations", label: "Automations", icon: Bot },
  { href: "/desk/settings/macros", label: "Macros", icon: Zap },
  { href: "/desk/settings/csat", label: "Satisfaction", icon: Star },
];
const PEOPLE: SettingsNavItem[] = [
  { href: "/desk/settings/agents", label: "Agents", icon: UsersRound },
  { href: "/desk/settings/roles", label: "Roles", icon: ShieldCheck },
];

/** The settings pages this person's desk role reaches, grouped. */
export function settingsItems(caps: readonly string[]): { group: string; items: SettingsNavItem[] }[] {
  const ok = (i: SettingsNavItem) => (NEED[i.href] ?? []).some((c) => caps.includes(c));
  const groups: { group: string; items: SettingsNavItem[] }[] = [];
  const h = HELPDESK.filter(ok);
  if (h.length) groups.push({ group: "Helpdesk", items: h });
  const p = PEOPLE.filter(ok);
  if (p.length) groups.push({ group: "People", items: p });
  groups.push({ group: "You", items: [{ href: "/desk/settings/notifications", label: "Notifications", icon: BellRing }] });
  return groups;
}

/** The first page in the rail (where /desk/settings lands). */
export function firstSettingsHref(caps: readonly string[]): string {
  const first = settingsItems(caps).flatMap((g) => g.items).find((i) => i.href !== "/desk/setup");
  return first?.href ?? "/desk/settings/notifications";
}

