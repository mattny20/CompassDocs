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
  ClipboardCheck,
  List,
  Mail,
  ShieldCheck,
  Star,
  Users,
  UsersRound,
  Zap,
  MessageSquareText,
  Bot,
  Repeat,
  Upload,
  Globe,
  Languages,
  Link,
  Shield,
  Sparkle,
  type LucideIcon,
} from "lucide-react";
import { CHECKLIST_MANAGE_CAPS } from "@/lib/helpdesk/checklists-caps";

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
  "/desk/settings/recurring": ["settings.manage", "agents.manage_team"],
  "/desk/settings/macros": ["macros.manage_all", "macros.manage_team", "macros.manage_personal"],
  // Canned responses (1.19.2, agent W4): the macro capabilities.
  "/desk/settings/canned": ["macros.manage_all", "macros.manage_team", "macros.manage_personal"],
  // Checklists (1.19.2, agent W3): the configuration capabilities (lib/helpdesk/checklists-caps).
  "/desk/settings/checklists": [...CHECKLIST_MANAGE_CAPS],
  // "Before you solve" requirement sets (1.20.5, lib/helpdesk/solve-requirements).
  "/desk/settings/before-you-solve": ["settings.manage"],
  "/desk/settings/csat": ["csat.manage"],
  "/desk/settings/assignment": ["agents.manage_team", "automations.manage"],
  "/desk/settings/contact-cards": ["settings.manage"],
  "/desk/settings/integrations": ["settings.manage", "channels.manage"],
  "/desk/settings/agents": ["agents.manage_team", "agents.assign_roles"],
  // Skills and languages (1.19.2, agent W2): leads tag their teams' people; teams.manage edits the lists.
  "/desk/settings/skills": ["agents.manage_team", "teams.manage"],
  "/desk/settings/roles": ["roles.manage"],
  "/desk/settings/claude": ["settings.manage"],
  "/desk/settings/portal": ["settings.manage"],
  "/desk/settings/import": ["settings.manage"],
  // Shortcut defaults and retention (1.19.1, agent V5).
  "/desk/settings/shortcuts": ["settings.manage"],
  "/desk/settings/retention": ["settings.manage"],
  // Assets: the Snipe-IT source (1.19.3, lib/helpdesk/assets).
  "/desk/settings/assets": ["settings.manage"],
  // Chat apps: Microsoft Teams and Slack (1.19.4 C1, lib/helpdesk/chat).
  "/desk/settings/chat": ["settings.manage"],
  // Appearance: the desk's background artwork (1.19.4 C5, lib/helpdesk/appearance).
  "/desk/settings/appearance": ["settings.manage"],
  // API tokens and outgoing webhooks (1.19.4 C2, lib/helpdesk/api-tokens, webhooks).
  "/desk/settings/api": ["settings.manage"],
  // Claude in the desk (1.20.0, lib/helpdesk/claude).
  "/desk/settings/claude-desk": ["settings.manage"],
};

const HELPDESK: SettingsNavItem[] = [
  { href: "/desk/setup", label: "Setup", icon: LifeBuoy },
  { href: "/desk/settings/teams", label: "Teams", icon: Users },
  { href: "/desk/settings/request-types", label: "Request types", icon: List },
  { href: "/desk/settings/sla", label: "Reply targets", icon: Clock },
  { href: "/desk/settings/calendars", label: "Calendars", icon: CalendarClock },
  { href: "/desk/settings/email", label: "Email", icon: Mail },
  { href: "/desk/settings/email-templates", label: "Email templates", icon: FileText },
  { href: "/desk/settings/integrations", label: "Integrations", icon: Plug },
  { href: "/desk/settings/assignment", label: "Assignment", icon: Shuffle },
  { href: "/desk/settings/contact-cards", label: "Contact cards", icon: Contact },
  { href: "/desk/settings/automations", label: "Automations", icon: Bot },
  { href: "/desk/settings/recurring", label: "Recurring tickets", icon: Repeat },
  { href: "/desk/settings/shortcuts", label: "Shortcuts", icon: Link },
  { href: "/desk/settings/portal", label: "Customer portal", icon: Globe },
  { href: "/desk/settings/macros", label: "Macros", icon: Zap },
  { href: "/desk/settings/canned", label: "Canned responses", icon: MessageSquareText },
  { href: "/desk/settings/checklists", label: "Checklists", icon: ListChecks },
  { href: "/desk/settings/before-you-solve", label: "Before you solve", icon: ClipboardCheck },
  { href: "/desk/settings/csat", label: "Satisfaction", icon: Star },
  { href: "/desk/settings/import", label: "Import", icon: Upload },
  { href: "/desk/settings/retention", label: "Retention and privacy", icon: Shield },
  // 1.20.2: Assets, Chat apps, Claude connector and API and webhooks are tiles of the Integrations hub
  // (lib/helpdesk/integrations-hub-shared), not entries of their own; their old addresses redirect.
  { href: "/desk/settings/appearance", label: "Appearance", icon: Sparkle },
  { href: "/desk/settings/claude-desk", label: "Claude in the desk", icon: Sparkle },
];
const PEOPLE: SettingsNavItem[] = [
  { href: "/desk/settings/agents", label: "Agents", icon: UsersRound },
  { href: "/desk/settings/skills", label: "Skills and languages", icon: Languages },
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

