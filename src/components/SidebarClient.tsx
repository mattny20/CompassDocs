"use client";

// The app sidebar, collapsible to an icon-only rail. Expanded is the original
// layout; collapsed keeps every navigation icon (with tooltips) and hides the
// text labels, search, spaces names, theme toggle, and user menu to give the
// content area more room. The choice persists per browser.
//
// On small screens the sidebar always starts as the rail (a full-width column
// would crush the content), and expanding it floats the full sidebar over the
// page with a backdrop instead of squeezing the layout.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Home,
  Sparkles,
  Megaphone,
  ShieldCheck,
  BookUser,
  Mail,
  SquareArrowOutUpRight,
  ClipboardList,
  ChartColumn,
  Trash2,
  Settings,
  Plus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { GlobalSearch } from "./GlobalSearch";
import { UserMenu } from "./UserMenu";
import { Brand } from "./Brand";
import { SidebarSpaceTree } from "./SidebarSpaceTree";
import { ChevronRight } from "lucide-react";
import type { SessionUser } from "@/lib/types";

const LS_KEY = "compass_sidebar_collapsed";
const LS_MORE = "compass_sidebar_more";

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
  showAnnouncements,
  showCompliance,
  isEditor,
  isApprover,
  isAdmin,
  nestedPages = false,
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
  /** Delegated sections (admins or granted via Settings → Section access). */
  showAnnouncements: boolean;
  showCompliance: boolean;
  isEditor: boolean;
  isApprover: boolean;
  isAdmin: boolean;
  /** Nested pages toggle: spaces get an expandable page tree. */
  nestedPages?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [isSmall, setIsSmall] = useState(false);
  // Less-used nav items live behind a "More" fold so the spaces list keeps
  // room on short screens. Folded by default; the choice persists per browser.
  const [moreOpen, setMoreOpen] = useState(false);
  // Space ids with their page tree expanded (nested pages only).
  const [openSpaces, setOpenSpaces] = useState<Set<number>>(new Set());

  useEffect(() => {
    try {
      setMoreOpen(localStorage.getItem(LS_MORE) === "1");
    } catch {}
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => {
      setIsSmall(mq.matches);
      if (mq.matches) {
        // Phones always start from the rail, whatever the stored preference.
        setCollapsed(true);
      } else {
        try {
          setCollapsed(localStorage.getItem(LS_KEY) === "1");
        } catch {
          setCollapsed(false);
        }
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  function toggle() {
    setCollapsed((c) => {
      // Only desktop toggles persist — a phone expand is a transient overlay.
      if (!isSmall) {
        try {
          localStorage.setItem(LS_KEY, c ? "0" : "1");
        } catch {}
      }
      return !c;
    });
  }

  function toggleMore() {
    setMoreOpen((o) => {
      try {
        localStorage.setItem(LS_MORE, o ? "0" : "1");
      } catch {}
      return !o;
    });
  }

  // Anything role-gated beyond the everyday items folds under "More".
  const hasMoreItems =
    showNewsletter || isApprover || showAnnouncements || showCompliance || isEditor || isAdmin;
  // The only badge that can hide inside the fold — surface it on the More row.
  const foldedBadge = moreOpen ? 0 : trashCount;

  const overlay = isSmall && !collapsed;
  return (
    <>
      {overlay && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 print:hidden"
          aria-hidden
          onClick={() => setCollapsed(true)}
        />
      )}
    <aside
      onClickCapture={(e) => {
        // Navigating from the overlay should also close it.
        if (overlay && (e.target as HTMLElement).closest("a")) setCollapsed(true);
      }}
      className={`print:hidden flex shrink-0 flex-col border-r border-slate-200 bg-surface transition-[width] duration-200 ${
        collapsed ? "w-16" : "w-64"
      } ${overlay ? "fixed inset-y-0 left-0 z-40 shadow-2xl" : ""}`}
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

      {/* One shared scroll region for nav + spaces, so a short window squeezes
          nothing out of reach — the spaces list no longer absorbs all of it. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
        {isApprover && (
          <NavLink
            href="/review"
            icon={<ClipboardList className="h-4 w-4" />}
            label="Review queue"
            collapsed={collapsed}
            badge={reviewCount}
          />
        )}
        {hasMoreItems && (
          <button
            onClick={toggleMore}
            aria-expanded={moreOpen}
            title={collapsed ? (moreOpen ? "Less" : "More") : undefined}
            className={`relative flex w-full items-center rounded-md py-2 font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 ${
              collapsed ? "justify-center px-0" : "gap-2 px-3"
            }`}
          >
            <span className="text-slate-400">
              <MoreHorizontal className="h-4 w-4" />
            </span>
            {!collapsed && <span className="flex-1 text-left">{moreOpen ? "Less" : "More"}</span>}
            {foldedBadge ? (
              collapsed ? (
                <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-compass-500" />
              ) : (
                <span className="rounded-full bg-compass-100 px-1.5 text-xs font-semibold text-compass-700">
                  {foldedBadge}
                </span>
              )
            ) : null}
          </button>
        )}
        {moreOpen && showNewsletter && (
          <NavLink href="/newsletter" icon={<Mail className="h-4 w-4" />} label="Newsletter" collapsed={collapsed} />
        )}
        {moreOpen && isApprover && (
          <NavLink
            href="/analytics"
            icon={<ChartColumn className="h-4 w-4" />}
            label="Analytics"
            collapsed={collapsed}
          />
        )}
        {moreOpen && showAnnouncements && (
          <NavLink
            href="/announcements"
            icon={<Megaphone className="h-4 w-4" />}
            label="Announcements"
            collapsed={collapsed}
          />
        )}
        {moreOpen && showCompliance && (
          <NavLink
            href="/compliance"
            icon={<ShieldCheck className="h-4 w-4" />}
            label="Compliance"
            collapsed={collapsed}
          />
        )}
        {moreOpen && isEditor && (
          <NavLink
            href="/trash"
            icon={<Trash2 className="h-4 w-4" />}
            label="Trash"
            collapsed={collapsed}
            badge={trashCount}
          />
        )}
        {moreOpen && isAdmin && (
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

      <nav className={`pb-4 text-sm ${collapsed ? "px-2" : "px-3"}`}>
        {spaces.map((s) => (
          <div key={s.id}>
            <span
              className={`flex items-center rounded-md text-slate-600 hover:bg-slate-100 ${
                collapsed ? "justify-center px-0" : "gap-1 pr-1"
              }`}
            >
              {!collapsed && nestedPages && (
                <button
                  onClick={() =>
                    setOpenSpaces((prev) => {
                      const next = new Set(prev);
                      if (next.has(s.id)) next.delete(s.id);
                      else next.add(s.id);
                      return next;
                    })
                  }
                  title={openSpaces.has(s.id) ? "Collapse pages" : "Show pages"}
                  aria-label={`${openSpaces.has(s.id) ? "Collapse" : "Expand"} pages in ${s.name}`}
                  className="ml-1 rounded p-0.5 text-slate-400 hover:text-slate-600"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 transition-transform ${openSpaces.has(s.id) ? "rotate-90" : ""}`}
                  />
                </button>
              )}
              <Link
                href={`/spaces/${s.slug}`}
                title={s.name}
                className={`flex min-w-0 flex-1 items-center py-2 ${
                  collapsed ? "justify-center px-0" : nestedPages ? "pr-2" : "px-3"
                }`}
              >
                <span className={`flex items-center gap-2 truncate ${collapsed ? "justify-center" : ""}`}>
                  <span>{s.icon}</span>
                  {!collapsed && <span className="truncate">{s.name}</span>}
                </span>
              </Link>
            </span>
            {!collapsed && nestedPages && openSpaces.has(s.id) && (
              <SidebarSpaceTree spaceId={s.id} />
            )}
          </div>
        ))}
      </nav>
      </div>

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

      <UserMenu user={user} collapsed={collapsed} />
    </aside>
    </>
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
