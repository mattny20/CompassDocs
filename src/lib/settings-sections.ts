// The single source of truth for the admin settings sections: label, icon,
// description, search keywords, and group. Consumed by the settings nav
// (rail + search) and by SettingsPage (per-page header), so a section's
// identity is defined exactly once. Works in server and client components —
// icons are component references, rendered by the consumer.

import type { LucideIcon } from "lucide-react";
import type { PermissionKey } from "./permissions";
import {
  BellRing,
  BookUser,
  Building2,
  FileDown,
  ListChecks,
  MailPlus,
  RefreshCw,
  Share2,
  DatabaseBackup,
  Fingerprint,
  FolderKanban,
  Globe,
  HeartPulse,
  KeyRound,
  LayoutTemplate,
  Mail,
  Megaphone,
  Monitor,
  Package,
  Palette,
  ScrollText,
  ShieldCheck,
  Sparkles,
  SquareArrowOutUpRight,
  Users,
  UsersRound,
} from "lucide-react";

/** A routed page inside a section (/admin/directory/fields). */
export interface SettingsPageEntry {
  href: string;
  label: string;
  icon?: LucideIcon;
  keywords?: string;
}

/** A card inside a page, reachable by anchor (/admin/workspace#trash). */
export interface SettingsTopic {
  href: string;
  label: string;
  keywords?: string;
}

export interface SettingsSection {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** What people actually search for, beyond the label. */
  keywords: string;
  /** Routed sub-pages, rendered as the section's SubNav and searchable as "Section › Page". */
  pages?: SettingsPageEntry[];
  /** In-page cards (anchors), searchable as "Section › Topic". */
  topics?: SettingsTopic[];
  /**
   * The permission that opens this section (0.93). Declared here rather than in
   * the page so the rail, the page guard, and the search results can never
   * disagree about who may see it — a nav entry that 404s on click is the
   * cheapest kind of authorization bug to ship and the most annoying to hit.
   */
  permission: PermissionKey;
}

export interface SettingsGroup {
  label: string;
  sections: SettingsSection[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Platform",
    sections: [
      { href: "/admin", label: "System", icon: Monitor, description: "Version, updates, health, and diagnostics for this deployment.", keywords: "version update health status docker diagnostics metrics prometheus probes healthz readyz observability", permission: "system.diagnostics_read" },
      { href: "/admin/workspace", label: "Workspace", icon: Palette, description: "Name, branding, accent color, and workspace-wide content options.", keywords: "name logo accent color brand theme icon company date format nested pages backlinks sub-pages tree comments", permission: "workspace.branding_manage", topics: [
          { href: "/admin/workspace#branding", label: "Branding", keywords: "name logo accent colour color favicon icon" },
          { href: "/admin/workspace#date-time", label: "Date & time", keywords: "timezone time zone date format 24-hour clock" },
          { href: "/admin/workspace#trash", label: "Trash retention", keywords: "trash retention days purge delete" },
          { href: "/admin/workspace#attachments", label: "Attachments", keywords: "attachment file size limit mb video upload" },
          { href: "/admin/workspace#organization", label: "Document organization", keywords: "nested pages backlinks sub-pages tree" },
          { href: "/admin/workspace#comments", label: "Comments", keywords: "comments discussion" },
          { href: "/admin/workspace#outlook", label: "Outlook add-in", keywords: "outlook add-in manifest office" },
          { href: "/admin/workspace#session", label: "Session timeout", keywords: "session timeout inactivity logout minutes" },
        ] },
      { href: "/admin/domain", label: "Domain & HTTPS", icon: Globe, description: "Hostname, certificates, and TLS.", keywords: "tls ssl certificate caddy hostname url", permission: "workspace.domain_manage", topics: [
          { href: "/admin/domain#domain", label: "Custom domain", keywords: "hostname dns" },
          { href: "/admin/domain#tls", label: "HTTPS / TLS", keywords: "certificate let's encrypt self-signed pem key caddy" },
          { href: "/admin/domain#cookies", label: "Session cookie security", keywords: "secure cookie https http login loop" },
        ] },
      { href: "/admin/license", label: "License", icon: KeyRound, description: "Enterprise license and entitlements.", keywords: "enterprise entitlements sso scim policy audit export training", permission: "workspace.settings_read" },
    ],
  },
  {
    label: "Content",
    sections: [
      { href: "/admin/spaces", label: "Spaces", icon: FolderKanban, description: "Create spaces, control visibility, categories, and edit rights.", keywords: "visibility private public categories edit rights permissions subscriptions", permission: "space.manage_members" },
      { href: "/admin/templates", label: "Templates", icon: LayoutTemplate, description: "Document templates and per-space defaults.", keywords: "document template sop runbook policy postmortem meeting notes decision record placeholder default blank", permission: "template.manage" },
      { href: "/admin/public-site", label: "Public site", icon: Megaphone, description: "What anonymous visitors can see, and how it's indexed.", keywords: "anonymous internet seo indexing share", permission: "workspace.public_site_manage" },
      { href: "/admin/links", label: "Links", icon: SquareArrowOutUpRight, description: "The launchpad of external shortcuts on the dashboard.", keywords: "quick launchpad shortcuts tools", permission: "link.manage" },
      { href: "/admin/newsletter", label: "Newsletter", icon: Mail, description: "Contributors, approvers, scheduling, and appearance.", keywords: "email campaign digest contributors approvers schedule appearance", permission: "newsletter.configure" },
      { href: "/admin/health", label: "Content health", icon: HeartPulse, description: "Broken links, stale docs, orphans, and quality reports.", keywords: "broken links orphans stale duplicates unread overdue review rot quality report", permission: "system.diagnostics_read" },
      { href: "/admin/data", label: "Import & export", icon: Package, description: "Move content in and out as Markdown.", keywords: "markdown zip migrate confluence notion download", permission: "system.export" },
    ],
  },
  {
    label: "People & access",
    sections: [
      { href: "/admin/users", label: "Users & roles", icon: Users, description: "Accounts, roles, and password resets.", keywords: "people accounts password reset viewer editor approver admin disable", permission: "user.read" },
      { href: "/admin/roles", label: "Roles & permissions", icon: ShieldCheck, description: "Custom roles, the permission matrix, and who holds what.", keywords: "rbac permission role custom grant assign scope matrix explain access control least privilege", permission: "role.read" },
      { href: "/admin/groups", label: "Groups", icon: UsersRound, description: "Hand-made and Entra-synced groups.", keywords: "membership teams entra sync access leads", permission: "group.read" },
      { href: "/admin/sso", label: "Single sign-on", icon: Fingerprint, description: "OIDC and SAML sign-in, plus SCIM provisioning.", keywords: "oidc entra azure microsoft login saml identity scim provisioning", permission: "identity.sso_read", topics: [
          { href: "/admin/sso#oidc", label: "Microsoft Entra ID (OIDC)", keywords: "entra azure oidc tenant client secret" },
          { href: "/admin/sso#saml", label: "SAML 2.0", keywords: "saml idp metadata certificate okta" },
          { href: "/admin/sso#scim", label: "SCIM provisioning", keywords: "scim provisioning token entra users groups" },
        ] },
      { href: "/admin/directory", label: "Directory", icon: BookUser, description: "People sync from Microsoft 365, attributes, and profiles.", keywords: "people microsoft 365 sync attributes profiles photos", permission: "directory.sync_manage", pages: [
          { href: "/admin/directory", label: "People", icon: Users, keywords: "people entries import csv" },
          { href: "/admin/directory/fields", label: "Fields", icon: ListChecks, keywords: "fields attributes mapping visibility" },
          { href: "/admin/directory/offices", label: "Offices", icon: Building2, keywords: "offices locations addresses" },
          { href: "/admin/directory/export", label: "Export", icon: FileDown, keywords: "export pdf csv presets who's who" },
          { href: "/admin/directory/sync", label: "Sync", icon: RefreshCw, keywords: "sync microsoft 365 entra graph schedule google" },
        ] },
    ],
  },
  {
    label: "AI",
    sections: [
      { href: "/admin/ai", label: "AI", icon: Sparkles, description: "Claude API, Ask, proofreading, and semantic search.", keywords: "anthropic claude api key model ask proofread semantic search embeddings vector voyage openai ollama", permission: "integration.ai_config_read", topics: [
          { href: "/admin/ai#provider", label: "Provider", keywords: "anthropic openai ollama provider" },
          { href: "/admin/ai#key", label: "Anthropic API key", keywords: "api key sk-ant" },
          { href: "/admin/ai#model", label: "Model", keywords: "model opus sonnet haiku" },
          { href: "/admin/ai#openai", label: "OpenAI-compatible endpoint", keywords: "openai compatible endpoint url ollama lm studio vllm" },
        ] },
    ],
  },
  {
    label: "Operations",
    sections: [
      { href: "/admin/notifications", label: "Notifications", icon: BellRing, description: "Webhooks, SMTP, channels, and email templates.", keywords: "webhooks slack teams webex smtp email templates alerts channels", permission: "integration.webhook_read", pages: [
          { href: "/admin/notifications", label: "Channels", icon: Share2, keywords: "webhooks smtp chat" },
          { href: "/admin/notifications/templates", label: "Email templates", icon: MailPlus, keywords: "email templates subject body tags" },
        ], topics: [
          { href: "/admin/notifications#webhooks", label: "Webhooks", keywords: "webhook slack teams webex channel events" },
          { href: "/admin/notifications#smtp", label: "Email (SMTP)", keywords: "smtp mail server host port from" },
          { href: "/admin/notifications#chat", label: "Ask in chat", keywords: "ask chat slack teams bot" },
        ] },
      { href: "/admin/backups", label: "Backups", icon: DatabaseBackup, description: "Schedules, destinations, and restores.", keywords: "restore s3 azure destination encrypted schedule", permission: "system.backup_read", topics: [
          { href: "/admin/backups#schedule", label: "Automatic backups", keywords: "schedule frequency keep daily weekly" },
          { href: "/admin/backups#destinations", label: "Destinations", keywords: "s3 azure blob off-site mirror" },
          { href: "/admin/backups#backups", label: "Backups and restore", keywords: "restore download backup now" },
        ] },
      { href: "/admin/audit", label: "Audit log", icon: ScrollText, description: "Who did what, when.", keywords: "security events history who did what export", permission: "audit.read" },
    ],
  },
];

export const SETTINGS_SECTIONS: SettingsSection[] = SETTINGS_GROUPS.flatMap((g) => g.sections);

export function settingsSection(href: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((s) => s.href === href);
}

/** The routed pages of a section, for its SubNav (empty when it has none). */
export function settingsPages(href: string): SettingsPageEntry[] {
  return settingsSection(href)?.pages ?? [];
}

/** One searchable row: a section, a page in it, or a card in it. */
export interface SettingsIndexEntry {
  kind: "section" | "page" | "topic";
  /** The section this row belongs to (what reachability is checked against). */
  section: SettingsSection;
  href: string;
  label: string;
  haystack: string;
}

/** Every searchable row, sections first. */
export const SETTINGS_INDEX: SettingsIndexEntry[] = SETTINGS_SECTIONS.flatMap((section) => [
  { kind: "section" as const, section, href: section.href, label: section.label, haystack: `${section.label} ${section.keywords}`.toLowerCase() },
  ...(section.pages ?? [])
    .filter((p) => p.href !== section.href)
    .map((p) => ({ kind: "page" as const, section, href: p.href, label: p.label, haystack: `${section.label} ${p.label} ${p.keywords ?? ""}`.toLowerCase() })),
  ...(section.topics ?? []).map((t) => ({ kind: "topic" as const, section, href: t.href, label: t.label, haystack: `${section.label} ${t.label} ${t.keywords ?? ""}`.toLowerCase() })),
]);

/**
 * The document title for a settings page — the section's label, with an
 * optional sub-page name in front ("Fields · Directory"). Every admin page
 * exports `metadata = settingsMetadata(href)` with the same href it hands
 * SettingsPage, so the tab, history and the header can never disagree
 * (STYLEGUIDE §Page skeleton, "Document title"). The root layout's template
 * appends the workspace name.
 */
export function settingsMetadata(href: string, sub?: string): { title: string } {
  const label = settingsSection(href)?.label ?? "Settings";
  return { title: sub ? `${sub} · ${label}` : label };
}
