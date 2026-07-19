"use client";

// The app sidebar, collapsible to an icon-only rail. Expanded is the original
// layout; collapsed keeps every navigation icon (with tooltips) and hides the
// text labels, search, spaces names, theme toggle, and user menu to give the
// content area more room. The choice persists per browser.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Home,
  Sparkles,
  BookUser,
  Mail,
  SquareArrowOutUpRight,
  ClipboardList,
  ChartColumn,
  Trash2,
  Settings,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { GlobalSearch } from "./GlobalSearch";
import { UserMenu } from "./UserMenu";
import { Brand } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";
import type { SessionUser } from "@/lib/types";

const LS_KEY = "compass_sidebar_collapsed";

interface SpaceLite {
  id: number;
  slug: string;
  name: string;
  icon: string;
}

export function SidebarClient({
  user,
  spaces,
  companyName,
  logoUrl,
  reviewCount,
  trashCount,
  announcementCount,
  showNewsletter,
  isEditor,
  isApprover,
  isAdmin,
}: {
  user: SessionUser;
  spaces: SpaceLite[];
  companyName: string;
  logoUrl?: string;
  reviewCount: number;
  trashCount: number;
  /** Active announcements the user hasn't dismissed — badged on Dashboard. */
  announcementCount: number;
  /** Whether this user has newsletter access (contributor/approver/admin). */
  showNewsletter: boolean;
  isEditor: boolean;
  isApprover: boolean;
  isAdmin: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(LS_KEY) === "1") setCollapsed(true);
    } catch {}
  }, []);

  function toggle() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(LS_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });
  }

  return (
    <aside
      className={`print:hidden flex shrink-0 flex-col border-r border-slate-200 bg-surface transition-[width] duration-200 ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      {/* Brand + collapse toggle */}
      <div
        className={`flex h-16 items-center border-b border-slate-100 ${
          collapsed ? "justify-center" : "justify-between px-5"
        }`}
      >
        {!collapsed && (
          <Link href="/" className="flex min-w-0 items-center gap-2">
            <Brand name={companyName} logoUrl={logoUrl} />
          </Link>
        )}
        <button
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      {collapsed && (
        <div className="flex justify-center border-b border-slate-100 py-3">
          <Link href="/" title={companyName}>
            <Brand name={companyName} logoUrl={logoUrl} showName={false} />
          </Link>
        </div>
      )}

      {!collapsed && (
        <div className="px-3 py-3">
          <GlobalSearch />
        </div>
      )}

      <nav className={`text-sm ${collapsed ? "px-2 pt-3" : "px-3"} pb-2`}>
        <NavLink
          href="/"
          icon={<Home className="h-4 w-4" />}
          label="Dashboard"
          collapsed={collapsed}
          badge={announcementCount}
        />
        <NavLink href="/search" icon={<Sparkles className="h-4 w-4" />} label={`Ask ${companyName || "CompassDocs"}`} collapsed={collapsed} />
        <NavLink href="/directory" icon={<BookUser className="h-4 w-4" />} label="Directory" collapsed={collapsed} />
        <NavLink href="/links" icon={<SquareArrowOutUpRight className="h-4 w-4" />} label="Links" collapsed={collapsed} />
        {showNewsletter && (
          <NavLink href="/newsletter" icon={<Mail className="h-4 w-4" />} label="Newsletter" collapsed={collapsed} />
        )}
        {isApprover && (
          <NavLink
            href="/review"
            icon={<ClipboardList className="h-4 w-4" />}
            label="Review queue"
            collapsed={collapsed}
            badge={reviewCount}
          />
        )}
        {isApprover && (
          <NavLink
            href="/analytics"
            icon={<ChartColumn className="h-4 w-4" />}
            label="Analytics"
            collapsed={collapsed}
          />
        )}
        {isEditor && (
          <NavLink
            href="/trash"
            icon={<Trash2 className="h-4 w-4" />}
            label="Trash"
            collapsed={collapsed}
            badge={trashCount}
          />
        )}
        {isAdmin && (
          <NavLink href="/admin" icon={<Settings className="h-4 w-4" />} label="Settings" collapsed={collapsed} />
        )}
      </nav>

      {!collapsed && (
        <div className="mt-2 flex items-center justify-between px-5 pb-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Spaces</span>
          {isAdmin && (
            <Link
              href="/admin/spaces"
              title="Manage spaces"
              className="text-slate-400 transition hover:text-compass-600"
            >
              ＋
            </Link>
          )}
        </div>
      )}
      {collapsed && <div className="mt-2 border-t border-slate-100 pt-2" />}

      <nav className={`flex-1 overflow-y-auto pb-4 text-sm ${collapsed ? "px-2" : "px-3"}`}>
        {spaces.map((s) => (
          <Link
            key={s.id}
            href={`/spaces/${s.slug}`}
            title={s.name}
            className={`flex items-center rounded-md py-2 text-slate-600 hover:bg-slate-100 ${
              collapsed ? "justify-center px-0" : "justify-between px-3"
            }`}
          >
            <span className={`flex items-center gap-2 truncate ${collapsed ? "justify-center" : ""}`}>
              <span>{s.icon}</span>
              {!collapsed && <span className="truncate">{s.name}</span>}
            </span>
          </Link>
        ))}
      </nav>

      {isEditor && (
        <div className={`border-t border-slate-100 ${collapsed ? "p-2" : "p-3"}`}>
          <Link
            href="/doc/new"
            title="New document"
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg bg-compass-600 text-sm font-semibold text-white shadow-sm transition hover:bg-compass-700 ${
              collapsed ? "px-0 py-2" : "px-3 py-2"
            }`}
          >
            {collapsed ? (
              <Plus className="h-4 w-4" />
            ) : (
              <>
                <span className="text-base leading-none">＋</span> New document
              </>
            )}
          </Link>
        </div>
      )}

      {!collapsed && (
        <div className="border-t border-slate-100 px-3 py-2">
          <ThemeToggle />
        </div>
      )}

      {!collapsed && <UserMenu user={user} />}
    </aside>
  );
}

function NavLink({
  href,
  icon,
  label,
  collapsed,
  badge,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={`relative flex items-center rounded-md py-2 font-medium text-slate-600 hover:bg-slate-100 ${
        collapsed ? "justify-center px-0" : "gap-2 px-3"
      }`}
    >
      <span className="text-slate-400">{icon}</span>
      {!collapsed && <span className="flex-1">{label}</span>}
      {badge ? (
        collapsed ? (
          <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-compass-500" />
        ) : (
          <span className="rounded-full bg-compass-100 px-1.5 text-xs font-semibold text-compass-700">
            {badge}
          </span>
        )
      ) : null}
    </Link>
  );
}
