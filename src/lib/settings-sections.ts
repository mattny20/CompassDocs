// The single source of truth for the admin settings sections: label, icon,
// description, search keywords, and group. Consumed by the settings nav
// (rail + search) and by SettingsPage (per-page header), so a section's
// identity is defined exactly once. Works in server and client components —
// icons are component references, rendered by the consumer.

import type { LucideIcon } from "lucide-react";
import {
  BellRing,
  BookUser,
  DatabaseBackup,
  Fingerprint,
  FolderKanban,
  Globe,
  HeartPulse,
  KeyRound,
  KeySquare,
  LayoutTemplate,
  Mail,
  Megaphone,
  Monitor,
  Package,
  Palette,
  ScrollText,
  Sparkles,
  SquareArrowOutUpRight,
  Users,
  UsersRound,
} from "lucide-react";

export interface SettingsSection {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** What people actually search for, beyond the label. */
  keywords: string;
}

export interface SettingsGroup {
  label: string;
  sections: SettingsSection[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Platform",
    sections: [
      { href: "/admin", label: "System", icon: Monitor, description: "Version, updates, health, and diagnostics for this deployment.", keywords: "version update health status docker diagnostics metrics prometheus probes healthz readyz observability" },
      { href: "/admin/workspace", label: "Workspace", icon: Palette, description: "Name, branding, accent color, and workspace-wide content options.", keywords: "name logo accent color brand theme icon company date format nested pages backlinks sub-pages tree comments" },
      { href: "/admin/domain", label: "Domain & HTTPS", icon: Globe, description: "Hostname, certificates, and TLS.", keywords: "tls ssl certificate caddy hostname url" },
      { href: "/admin/license", label: "License", icon: KeyRound, description: "Enterprise license and entitlements.", keywords: "enterprise entitlements sso scim policy audit export training" },
    ],
  },
  {
    label: "Content",
    sections: [
      { href: "/admin/spaces", label: "Spaces", icon: FolderKanban, description: "Create spaces, control visibility, categories, and edit rights.", keywords: "visibility private public categories edit rights permissions subscriptions" },
      { href: "/admin/templates", label: "Templates", icon: LayoutTemplate, description: "Document templates and per-space defaults.", keywords: "document template sop runbook policy postmortem meeting notes decision record placeholder default blank" },
      { href: "/admin/public-site", label: "Public site", icon: Megaphone, description: "What anonymous visitors can see, and how it's indexed.", keywords: "anonymous internet seo indexing share" },
      { href: "/admin/links", label: "Links", icon: SquareArrowOutUpRight, description: "The launchpad of external shortcuts on the dashboard.", keywords: "quick launchpad shortcuts tools" },
      { href: "/admin/newsletter", label: "Newsletter", icon: Mail, description: "Contributors, approvers, scheduling, and appearance.", keywords: "email campaign digest contributors approvers schedule appearance" },
      { href: "/admin/health", label: "Content health", icon: HeartPulse, description: "Broken links, stale docs, orphans, and quality reports.", keywords: "broken links orphans stale duplicates unread overdue review rot quality report" },
      { href: "/admin/data", label: "Import & export", icon: Package, description: "Move content in and out as Markdown.", keywords: "markdown zip migrate confluence notion download" },
    ],
  },
  {
    label: "People & access",
    sections: [
      { href: "/admin/users", label: "Users & roles", icon: Users, description: "Accounts, roles, and password resets.", keywords: "people accounts password reset viewer editor approver admin disable" },
      { href: "/admin/groups", label: "Groups", icon: UsersRound, description: "Hand-made and Entra-synced groups.", keywords: "membership teams entra sync access leads" },
      { href: "/admin/access", label: "Section access", icon: KeySquare, description: "Delegate Announcements, Compliance, and Training.", keywords: "delegate delegation announcements compliance training grant permissions sidebar" },
      { href: "/admin/sso", label: "Single sign-on", icon: Fingerprint, description: "OIDC and SAML sign-in, plus SCIM provisioning.", keywords: "oidc entra azure microsoft login saml identity scim provisioning" },
      { href: "/admin/directory", label: "Directory", icon: BookUser, description: "People sync from Microsoft 365, attributes, and profiles.", keywords: "people microsoft 365 sync attributes profiles photos" },
    ],
  },
  {
    label: "AI",
    sections: [
      { href: "/admin/ai", label: "AI", icon: Sparkles, description: "Claude API, Ask, proofreading, and semantic search.", keywords: "anthropic claude api key model ask proofread semantic search embeddings vector voyage openai ollama" },
    ],
  },
  {
    label: "Operations",
    sections: [
      { href: "/admin/notifications", label: "Notifications", icon: BellRing, description: "Webhooks, SMTP, channels, and email templates.", keywords: "webhooks slack teams webex smtp email templates alerts channels" },
      { href: "/admin/backups", label: "Backups", icon: DatabaseBackup, description: "Schedules, destinations, and restores.", keywords: "restore s3 azure destination encrypted schedule" },
      { href: "/admin/audit", label: "Audit log", icon: ScrollText, description: "Who did what, when.", keywords: "security events history who did what export" },
    ],
  },
];

export const SETTINGS_SECTIONS: SettingsSection[] = SETTINGS_GROUPS.flatMap((g) => g.sections);

export function settingsSection(href: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((s) => s.href === href);
}
