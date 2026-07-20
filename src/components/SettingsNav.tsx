"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Monitor,
  Palette,
  FolderKanban,
  Megaphone,
  Sparkles,
  KeyRound,
  Globe,
  Users,
  UsersRound,
  Fingerprint,
  BookUser,
  SquareArrowOutUpRight,
  ScrollText,
  KeySquare,
  BellRing,
  Mail,
  DatabaseBackup,
  Package,
  Search,
  LayoutTemplate,
} from "lucide-react";

const ICON = "h-4 w-4";

// keywords: what people actually search for, beyond the section label —
// matched case-insensitively together with the label.
const SECTIONS = [
  { href: "/admin", label: "System", icon: <Monitor className={ICON} />, keywords: "version update health status docker" },
  { href: "/admin/workspace", label: "Workspace", icon: <Palette className={ICON} />, keywords: "name logo accent color brand theme icon company date format" },
  { href: "/admin/spaces", label: "Spaces", icon: <FolderKanban className={ICON} />, keywords: "visibility private public categories edit rights permissions subscriptions" },
  { href: "/admin/templates", label: "Templates", icon: <LayoutTemplate className={ICON} />, keywords: "document template sop runbook policy postmortem meeting notes decision record placeholder default blank" },
  { href: "/admin/public-site", label: "Public site", icon: <Megaphone className={ICON} />, keywords: "anonymous internet seo indexing share" },
  { href: "/admin/links", label: "Links", icon: <SquareArrowOutUpRight className={ICON} />, keywords: "quick launchpad shortcuts tools" },
  { href: "/admin/newsletter", label: "Newsletter", icon: <Mail className={ICON} />, keywords: "email campaign digest contributors approvers schedule appearance" },
  { href: "/admin/ai", label: "AI", icon: <Sparkles className={ICON} />, keywords: "anthropic claude api key model ask proofread semantic search embeddings vector voyage openai ollama" },
  { href: "/admin/license", label: "License", icon: <KeyRound className={ICON} />, keywords: "enterprise entitlements sso scim policy audit export" },
  { href: "/admin/domain", label: "Domain & HTTPS", icon: <Globe className={ICON} />, keywords: "tls ssl certificate caddy hostname url" },
  { href: "/admin/users", label: "Users & roles", icon: <Users className={ICON} />, keywords: "people accounts password reset viewer editor approver admin disable" },
  { href: "/admin/groups", label: "Groups", icon: <UsersRound className={ICON} />, keywords: "membership teams entra sync access" },
  { href: "/admin/access", label: "Section access", icon: <KeySquare className={ICON} />, keywords: "delegate delegation announcements compliance grant permissions sidebar" },
  { href: "/admin/sso", label: "Single sign-on", icon: <Fingerprint className={ICON} />, keywords: "oidc entra azure microsoft login saml identity" },
  { href: "/admin/directory", label: "Directory", icon: <BookUser className={ICON} />, keywords: "people microsoft 365 sync attributes profiles photos" },
  { href: "/admin/notifications", label: "Notifications", icon: <BellRing className={ICON} />, keywords: "webhooks slack teams webex smtp email templates alerts channels" },
  { href: "/admin/audit", label: "Audit log", icon: <ScrollText className={ICON} />, keywords: "security events history who did what" },
  { href: "/admin/backups", label: "Backups", icon: <DatabaseBackup className={ICON} />, keywords: "restore s3 azure destination encrypted schedule" },
  { href: "/admin/data", label: "Import & export", icon: <Package className={ICON} />, keywords: "markdown zip migrate confluence notion download" },
];

export function SettingsNav() {
  const path = usePathname();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? SECTIONS.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(needle))
    : SECTIONS;

  return (
    <div className="flex shrink-0 flex-col gap-1 sm:w-52">
      <label className="relative mb-1 hidden sm:block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="w-full rounded-lg border border-slate-200 bg-surface py-1.5 pl-8 pr-2 text-sm outline-none placeholder:text-slate-400 focus:border-compass-400"
        />
      </label>
      <nav className="flex gap-1 overflow-x-auto sm:flex-col">
        {visible.map((s) => {
          const active = path === s.href;
          return (
            <Link
              key={s.href}
              href={s.href}
              className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
                active
                  ? "bg-compass-50 text-compass-700"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <span aria-hidden>{s.icon}</span>
              {s.label}
            </Link>
          );
        })}
        {visible.length === 0 && (
          <p className="px-3 py-2 text-sm text-slate-400">No settings match.</p>
        )}
      </nav>
    </div>
  );
}
