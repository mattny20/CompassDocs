// The app's navigation destinations, as data. The command palette uses this to
// offer "Go to" results and to bind the `g` chords; the sidebar renders the
// same set. Isomorphic — icons are component references, gates are capability
// keys the server evaluates (see lib/nav-capabilities).

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookUser,
  GraduationCap,
  Home,
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
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: Home, keywords: "home start overview my work", cap: null, chord: "h" },
  { href: "/search", label: "Ask", icon: Sparkles, keywords: "ai answers question search everything", cap: null, chord: "a" },
  { href: "/directory", label: "Directory", icon: BookUser, keywords: "people staff phone contact who", cap: null, chord: "p" },
  { href: "/links", label: "Links", icon: SquareArrowOutUpRight, keywords: "shortcuts tools launchpad apps", cap: null, chord: "l" },
  { href: "/status", label: "Status", icon: Activity, keywords: "service incidents uptime outage", cap: null, chord: "s" },
  { href: "/training", label: "Training", icon: GraduationCap, keywords: "courses decks compliance learning", cap: "showTraining", chord: "t" },
  { href: "/review", label: "Review queue", icon: ClipboardList, keywords: "approve suggestions change requests pending", cap: "isApprover", chord: "r" },
  { href: "/announcements", label: "Announcements", icon: Megaphone, keywords: "news posts broadcast", cap: "showAnnouncements", chord: "n" },
  { href: "/compliance", label: "Compliance", icon: ShieldCheck, keywords: "policy acknowledgements attestation", cap: "showCompliance", chord: "c" },
  { href: "/newsletter", label: "Newsletter", icon: Mail, keywords: "email campaign digest issue", cap: "showNewsletter" },
  { href: "/analytics", label: "Analytics", icon: ChartColumn, keywords: "usage views reports metrics", cap: "isApprover" },
  { href: "/trash", label: "Trash", icon: Trash2, keywords: "deleted removed restore recycle", cap: "isEditor" },
  { href: "/admin", label: "Settings", icon: Settings, keywords: "admin configure workspace system", cap: "isAdmin", chord: "," },
];

/** The chord map: second key → destination, filtered by capability. */
export function navChords(allowed: (cap: CapKey | null) => boolean): Map<string, NavItem> {
  const m = new Map<string, NavItem>();
  for (const item of NAV_ITEMS) {
    if (item.chord && allowed(item.cap)) m.set(item.chord, item);
  }
  return m;
}
