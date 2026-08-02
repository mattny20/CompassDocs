"use client";

// The app sidebar, collapsible to an icon-only rail. Expanded is the original
// layout; collapsed keeps every navigation icon (with tooltips) and hides the
// text labels, search, spaces names, theme toggle, and user menu to give the
// content area more room. The choice persists per browser.
//
// On small screens the sidebar always starts as the rail (a full-width column
// would crush the content), and expanding it floats the full sidebar over the
// page with a backdrop instead of squeezing the layout.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
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
  GraduationCap,
} from "lucide-react";
import { PaletteTrigger } from "./palette/PaletteTrigger";
import { NotificationsBell } from "./NotificationsBell";
import { UserMenu } from "./UserMenu";
import { Brand } from "./Brand";
import { SidebarSpaceTree } from "./SidebarSpaceTree";
import { ChevronRight } from "lucide-react";
import { useModalOverlay } from "./overlay/useModalOverlay";
import type { SessionUser } from "@/lib/types";

const LS_KEY = "compass_sidebar_collapsed";
const LS_MORE = "compass_sidebar_more";

/**
 * Is `href` the page we're on? Exact for the dashboard (every path starts with
 * "/"), otherwise the section root plus anything below it — matched on a
 * trailing slash so /spaces/eng doesn't light up for /spaces/eng-ops.
 */
function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

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
  announcementCount,
  unreadNotifications = 0,
  statusProblemCount = 0,
  showNewsletter,
  showAnnouncements,
  showCompliance,
  showTraining = false,
  trainingCount = 0,
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
  /**
   * Still accepted (the shell computes it) but deliberately NOT badged: the
   * accent pill means "work waiting for you", and a recycle-bin count is
   * state, not a queue.
   */
  trashCount: number;
  /** Active announcements the user hasn't dismissed — badged on Dashboard. */
  announcementCount: number;
  /** Unread inbox notifications — the bell's initial badge. */
  unreadNotifications?: number;
  statusProblemCount?: number;
  /** Whether this user has newsletter access (contributor/approver/admin). */
  showNewsletter: boolean;
  /** Delegated sections (admins or granted via Settings → Section access). */
  showAnnouncements: boolean;
  showCompliance: boolean;
  /** Training entitlement present: everyone gets the tab (badge = open assignments). */
  showTraining?: boolean;
  trainingCount?: number;
  isEditor: boolean;
  isApprover: boolean;
  isAdmin: boolean;
  /** Nested pages toggle: spaces get an expandable page tree. */
  nestedPages?: boolean;
}) {
  const pathname = usePathname();
  const asideRef = useRef<HTMLElement>(null);
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

  const moreLabel = moreOpen ? "Less" : "More";
  const moreToggle = (
    <button
      onClick={toggleMore}
      aria-expanded={moreOpen}
      data-tt={collapsed ? moreLabel : undefined}
      aria-label={collapsed ? moreLabel : undefined}
      className={`relative flex w-full items-center rounded-md py-2 font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 ${
        collapsed ? "justify-center px-0" : "gap-2 px-3"
      }`}
    >
      <span className="text-slate-400">
        <MoreHorizontal className="h-4 w-4" />
      </span>
      {!collapsed && <span className="flex-1 text-left">{moreLabel}</span>}
    </button>
  );

  // On a phone the expanded sidebar floats over the page — that's a modal, so
  // it owes the page everything useModalOverlay hands out (inert + aria-hidden
  // background, scroll lock, focus return, a layer on the overlay stack).
  // panelRef is the <aside> itself: an inert target that *contains* the panel
  // is skipped, so the drawer doesn't make itself inert while #main does.
  const overlay = isSmall && !collapsed;
  useModalOverlay(overlay, () => setCollapsed(true), { panelRef: asideRef });

  // Escape closes the drawer. Each overlay in this app still binds its own
  // Escape (nothing dispatches from the stack yet), so this listener stands
  // down whenever another dialog is on screen: the drawer is the shell itself,
  // so anything opened over it (the palette) owns Escape first. Bound on the
  // CAPTURE phase deliberately — the layer above closes on the bubble phase and
  // React flushes that unmount synchronously, so a bubble-phase check would
  // find the DOM already empty and swallow the same keypress.
  useEffect(() => {
    if (!overlay) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const above = Array.from(document.querySelectorAll('[role="dialog"]')).some(
        (el) => el !== asideRef.current
      );
      if (above) return;
      e.preventDefault();
      setCollapsed(true);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [overlay]);

  return (
    <>
      {overlay && (
        // .cmd-scrim, not a slate tint: the slate ramp inverts in dark mode, so
        // bg-slate-900/40 paints a near-white wash over the page there.
        <div
          className="cmd-scrim fixed inset-0 z-30 print:hidden"
          aria-hidden
          onClick={() => setCollapsed(true)}
        />
      )}
    <aside
      ref={asideRef}
      data-app-sidebar
      role={overlay ? "dialog" : undefined}
      aria-modal={overlay ? true : undefined}
      aria-label={overlay ? "Main navigation" : undefined}
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
        <div className={`flex items-center ${collapsed ? "flex-col gap-1" : "gap-0.5"}`}>
          {!collapsed && <NotificationsBell initialUnread={unreadNotifications} />}
          <button
            onClick={toggle}
            data-tt={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            // A finger-sized target on phones; desktop geometry unchanged.
            className="rounded-md p-3.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 sm:p-1.5"
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {collapsed && (
        <div className="flex flex-col items-center gap-2 border-b border-slate-100 py-3">
          <Link href="/" data-tt={companyName} aria-label={companyName}>
            <Brand name={companyName} logoUrl={logoUrl} showName={false} />
          </Link>
          <NotificationsBell initialUnread={unreadNotifications} />
        </div>
      )}

      <div className={collapsed ? "px-2 py-3" : "px-3 py-3"}>
        <PaletteTrigger collapsed={collapsed} />
      </div>

      {/* One shared scroll region for nav + spaces, so a short window squeezes
          nothing out of reach — the spaces list no longer absorbs all of it. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* shrink-0: the nav keeps its height and the Spaces list below it owns
          the scroll, instead of nav items being squeezed below the fold. */}
      <nav className={`shrink-0 text-sm ${collapsed ? "px-2 pt-3" : "px-3"} pb-2`}>
        <NavLink
          href="/"
          icon={<Home className="h-4 w-4" />}
          label="Dashboard"
          collapsed={collapsed}
          active={isActivePath(pathname, "/")}
          badge={announcementCount}
        />
        <NavLink
          href="/search"
          icon={<Sparkles className="h-4 w-4" />}
          label={`Ask ${companyName || "CompassDocs"}`}
          collapsed={collapsed}
          active={isActivePath(pathname, "/search")}
        />
        <NavLink
          href="/directory"
          icon={<BookUser className="h-4 w-4" />}
          label="Directory"
          collapsed={collapsed}
          active={isActivePath(pathname, "/directory")}
        />
        <NavLink
          href="/links"
          icon={<SquareArrowOutUpRight className="h-4 w-4" />}
          label="Links"
          collapsed={collapsed}
          active={isActivePath(pathname, "/links")}
        />
        <NavLink
          href="/status"
          icon={<Activity className="h-4 w-4" />}
          label="Status"
          collapsed={collapsed}
          active={isActivePath(pathname, "/status")}
          badge={statusProblemCount}
        />
        {showTraining && (
          <NavLink
            href="/training"
            icon={<GraduationCap className="h-4 w-4" />}
            label="Training"
            collapsed={collapsed}
            active={isActivePath(pathname, "/training")}
            badge={trainingCount}
          />
        )}
        {isApprover && (
          <NavLink
            href="/review"
            icon={<ClipboardList className="h-4 w-4" />}
            label="Review queue"
            collapsed={collapsed}
            active={isActivePath(pathname, "/review")}
            badge={reviewCount}
          />
        )}
        {/* The toggle sits where "More" was when folded, but drops below the
            expanded items when open — so "Less" ends the list it controls. */}
        {hasMoreItems && !moreOpen && moreToggle}
        {moreOpen && showNewsletter && (
          <NavLink
            href="/newsletter"
            icon={<Mail className="h-4 w-4" />}
            label="Newsletter"
            collapsed={collapsed}
            active={isActivePath(pathname, "/newsletter")}
          />
        )}
        {moreOpen && isApprover && (
          <NavLink
            href="/analytics"
            icon={<ChartColumn className="h-4 w-4" />}
            label="Analytics"
            collapsed={collapsed}
            active={isActivePath(pathname, "/analytics")}
          />
        )}
        {moreOpen && showAnnouncements && (
          <NavLink
            href="/announcements"
            icon={<Megaphone className="h-4 w-4" />}
            label="Announcements"
            collapsed={collapsed}
            active={isActivePath(pathname, "/announcements")}
          />
        )}
        {moreOpen && showCompliance && (
          <NavLink
            href="/compliance"
            icon={<ShieldCheck className="h-4 w-4" />}
            label="Compliance"
            collapsed={collapsed}
            active={isActivePath(pathname, "/compliance")}
          />
        )}
        {moreOpen && isEditor && (
          <NavLink
            href="/trash"
            icon={<Trash2 className="h-4 w-4" />}
            label="Trash"
            collapsed={collapsed}
            active={isActivePath(pathname, "/trash")}
          />
        )}
        {moreOpen && isAdmin && (
          <NavLink
            href="/admin"
            icon={<Settings className="h-4 w-4" />}
            label="Settings"
            collapsed={collapsed}
            active={isActivePath(pathname, "/admin")}
          />
        )}
        {hasMoreItems && moreOpen && moreToggle}
      </nav>

      {!collapsed && (
        <div className="mt-2 flex items-center justify-between px-5 pb-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Spaces</span>
          {isAdmin && (
            <Link
              href="/admin/spaces"
              data-tt="Manage spaces" aria-label="Manage spaces"
              className="text-slate-400 transition hover:text-compass-600"
            >
              ＋
            </Link>
          )}
        </div>
      )}
      {collapsed && <div className="mt-2 border-t border-slate-100 pt-2" />}

      <nav className={`pb-4 text-sm ${collapsed ? "px-2" : "px-3"}`}>
        {spaces.map((s) => {
          const active = isActivePath(pathname, `/spaces/${s.slug}`);
          return (
          <div key={s.id}>
            <span
              className={`flex items-center rounded-md ${
                active ? "bg-compass-50 text-compass-700" : "text-slate-600 hover:bg-slate-100"
              } ${collapsed ? "justify-center px-0" : "gap-1 pr-1"}`}
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
                  data-tt={openSpaces.has(s.id) ? "Collapse pages" : "Show pages"}
                  aria-label={`${openSpaces.has(s.id) ? "Collapse" : "Expand"} pages in ${s.name}`}
                  className="ml-1 rounded-sm p-0.5 text-slate-400 hover:text-slate-600"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 transition-transform ${openSpaces.has(s.id) ? "rotate-90" : ""}`}
                  />
                </button>
              )}
              <Link
                href={`/spaces/${s.slug}`}
                data-tt={s.name}
                // Collapsed, the only visible content is the space's emoji —
                // which a screen reader announces by its Unicode name.
                aria-label={collapsed ? s.name : undefined}
                aria-current={active ? "page" : undefined}
                className={`flex min-w-0 flex-1 items-center py-2 ${
                  collapsed ? "justify-center px-0" : nestedPages ? "pr-2" : "px-3"
                }`}
              >
                <span className={`flex items-center gap-2 truncate ${collapsed ? "justify-center" : ""}`}>
                  <span aria-hidden>{s.icon}</span>
                  {!collapsed && <span className="truncate">{s.name}</span>}
                </span>
              </Link>
            </span>
            {!collapsed && nestedPages && openSpaces.has(s.id) && (
              <SidebarSpaceTree spaceId={s.id} />
            )}
          </div>
          );
        })}
      </nav>
      </div>

      {isEditor && (
        <div className={`border-t border-slate-100 ${collapsed ? "p-2" : "p-3"}`}>
          <Link
            href="/doc/new"
            data-tt="New document" aria-label="New document"
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg bg-compass-600 text-sm font-semibold text-white shadow-xs transition hover:bg-compass-700 ${
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
  active = false,
  badge,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  /** This row is the page we're on. */
  active?: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      data-tt={collapsed ? label : undefined}
      // Collapsed there is no visible text, so the tooltip's label has to be
      // mirrored as the accessible name. Expanded, the text is the name and an
      // aria-label would override it.
      aria-label={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center rounded-md py-2 font-medium ${
        active ? "bg-compass-50 text-compass-700" : "text-slate-600 hover:bg-slate-100"
      } ${collapsed ? "justify-center px-0" : "gap-2 px-3"}`}
    >
      <span className={active ? "" : "text-slate-400"}>{icon}</span>
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
