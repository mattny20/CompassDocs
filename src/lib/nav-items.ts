// The app's navigation destinations, as data. The command palette uses this to
// offer "Go to" results and to bind the `g` chords; the sidebar renders the
// same set. Isomorphic — icons are component references, gates are capability
// keys the server evaluates (see lib/nav-capabilities).

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpen,
  BookUser,
  GraduationCap,
  Headset,
  Home,
  LifeBuoy,
  Mail,
  Megaphone,
  ChartColumn,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareArrowOutUpRight,
  ClipboardList,
  Trash2,
} from "lucide-react";

/** Keys into NavCapabilities. `null` means everyone sees it. */
export type CapKey =
  | "isEditor"
  | "isApprover"
  | "isAdmin"
  | "showNewsletter"
  | "showAnnouncements"
  | "showCompliance"
  | "showTraining"
  | "showHandbooks"
  /** Get help (1.19.0): the helpdesk is licensed and the person holds helpdesk.request. */
  | "showHelp"
  /** The desk (1.19.0): licensed, and an agent, a helpdesk admin or a reports reader. */
  | "showDesk"
  | "canAuthor";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra words people search for. */
  keywords: string;
  /** Capability required to show this destination; null = always. */
  cap: CapKey | null;
  /** The second key of its `g` chord, when it has one. */
  chord?: string;
  /** Opens in its own tab (the desk, 1.19.0, is a workspace that stays open beside CompassDocs). */
  external?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: Home, keywords: "home start overview my work", cap: null, chord: "h" },
  { href: "/search", label: "Ask", icon: Sparkles, keywords: "ai answers question search everything", cap: null, chord: "a" },
  { href: "/directory", label: "Directory", icon: BookUser, keywords: "people staff phone contact who", cap: null, chord: "p" },
  { href: "/links", label: "Links", icon: SquareArrowOutUpRight, keywords: "shortcuts tools launchpad apps", cap: null, chord: "l" },
  { href: "/status", label: "Status", icon: Activity, keywords: "service incidents uptime outage", cap: null, chord: "s" },
  { href: "/handbooks", label: "Handbooks", icon: BookOpen, keywords: "handbook policies sops procedures bundle read print confirm employee staff onboarding", cap: "showHandbooks" },
  { href: "/help", label: "Get help", icon: LifeBuoy, keywords: "helpdesk support it hr facilities request ticket problem broken access laptop approvals", cap: "showHelp" },
  { href: "/desk", label: "Desk", icon: Headset, keywords: "helpdesk agent tickets queue support workspace", cap: "showDesk", external: true },
  { href: "/training", label: "Training", icon: GraduationCap, keywords: "courses decks compliance learning", cap: "showTraining", chord: "t" },
  { href: "/review", label: "Review queue", icon: ClipboardList, keywords: "approve suggestions change requests pending", cap: "isApprover", chord: "r" },
  { href: "/announcements", label: "Announcements", icon: Megaphone, keywords: "news posts broadcast", cap: "showAnnouncements", chord: "n" },
  { href: "/compliance", label: "Compliance", icon: ShieldCheck, keywords: "my policies policy read confirmation confirm acknowledgements", cap: "showCompliance", chord: "c" },
  { href: "/newsletter", label: "Newsletter", icon: Mail, keywords: "email campaign digest issue", cap: "showNewsletter" },
  { href: "/analytics", label: "Analytics", icon: ChartColumn, keywords: "usage views reports metrics", cap: "isApprover" },
  { href: "/trash", label: "Trash", icon: Trash2, keywords: "deleted removed restore recycle", cap: "isEditor" },
  { href: "/admin", label: "Settings", icon: Settings, keywords: "admin configure workspace system", cap: "isAdmin", chord: "," },
];

/** The Ask destination's label everywhere it appears (sidebar, dashboard
 *  hero, the page itself): one source, so they cannot disagree. */
export function askLabel(companyName?: string | null): string {
  return `Ask ${companyName || "CompassDocs"}`;
}

/** The chord map: second key → destination, filtered by capability. */
export function navChords(allowed: (cap: CapKey | null) => boolean): Map<string, NavItem> {
  const m = new Map<string, NavItem>();
  for (const item of NAV_ITEMS) {
    if (item.chord && allowed(item.cap)) m.set(item.chord, item);
  }
  return m;
}
