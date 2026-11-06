"use client";

// The desk's own shell (1.19.0, /desk): a full-screen workspace meant to
// stay open in its own tab beside CompassDocs, so it has no CompassDocs
// sidebar. A top bar (the Desk mark, global search, CompassDocs ↗, the
// bell, the availability menu) over an icon rail (Tickets, Approvals,
// Workflows, Reports, Settings) and the page. Under md the rail folds into
// a menu button at the left of the top bar, so a phone gets the whole
// width for the page.

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, ExternalLink, Inbox, LifeBuoy, Menu, Settings, Stamp, Workflow } from "lucide-react";
import { Popover } from "@/components/Popover";
import { iconButtonClass } from "@/components/Button";
import { railIconClass, railRowClass } from "@/components/RailLink";
import type { HdAvailability, HdCounts } from "@/lib/helpdesk/types";
import { DeskBell } from "./DeskBell";
import { DeskSearch } from "./DeskSearch";
import { AvailabilityMenu } from "./AvailabilityMenu";
import { DeskCountsContext, useCountsPoll } from "./counts";
import { DeskMeContext } from "./me";

export interface DeskCaps {
  agent: boolean;
  /** Helpdesk admin (the helpdesk.admin permission). */
  admin: boolean;
  reports: boolean;
  /** The desk role may build workflows. */
  workflows: boolean;
  /** Where Settings leads: the first settings page the role reaches. */
  settingsHref: string;
}

interface Dest {
  href: string;
  label: string;
  icon: ReactNode;
  match: (p: string) => boolean;
  badge?: number;
  badgeLabel?: string;
}

function destinations(caps: DeskCaps, counts: HdCounts | null): Dest[] {
  const out: Dest[] = [];
  if (caps.agent)
    out.push({
      href: "/desk",
      label: "Tickets",
      icon: <Inbox className="h-5 w-5" aria-hidden />,
      match: (p) => p === "/desk" || p.startsWith("/desk/tickets"),
    });
  out.push({
    href: "/desk/approvals",
    label: "Approvals",
    icon: <Stamp className="h-5 w-5" aria-hidden />,
    match: (p) => p.startsWith("/desk/approvals"),
    badge: counts?.approvals_waiting || 0,
    badgeLabel: "approvals waiting for you",
  });
  if (caps.workflows)
    out.push({
      href: "/desk/workflows",
      label: "Workflows",
      icon: <Workflow className="h-5 w-5" aria-hidden />,
      match: (p) => p.startsWith("/desk/workflows"),
    });
  if (caps.reports)
    out.push({
      href: "/desk/reports",
      label: "Reports",
      icon: <BarChart3 className="h-5 w-5" aria-hidden />,
      match: (p) => p.startsWith("/desk/reports"),
    });
  out.push({
      href: caps.settingsHref,
      label: "Settings",
      icon: <Settings className="h-5 w-5" aria-hidden />,
      match: (p) => p.startsWith("/desk/settings") || p.startsWith("/desk/setup"),
    });
  return out;
}

export function DeskShell({
  user,
  caps,
  unread,
  availability,
  installSlot,
  role,
  roleCaps,
  children,
}: {
  user: { id: number; name: string };
  caps: DeskCaps;
  unread: number;
  availability: HdAvailability;
  /** The desk app's install prompt (agent F's InstallDesk), shown in the user menu. */
  installSlot?: ReactNode;
  role: { key: string; label: string } | null;
  roleCaps: string[];
  children: ReactNode;
}) {
  const pathname = usePathname() || "/desk";
  const { counts, refresh } = useCountsPoll(caps.agent);
  const dests = destinations(caps, counts);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);

  // The fold menu closes when the page changes under it.
  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <DeskMeContext.Provider value={{ id: user.id, name: user.name, agent: caps.agent, admin: caps.admin, reports: caps.reports, role, caps: roleCaps }}>
    <DeskCountsContext.Provider value={{ counts, refresh }}>
      <div className="flex h-dvh flex-col overflow-hidden bg-canvas print:h-auto print:overflow-visible">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-compass-600 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to content
        </a>
        <header className="flex h-13 shrink-0 items-center gap-2 border-b border-slate-200 bg-surface px-2 sm:gap-3 sm:px-4 print:hidden">
          {/* Under md the rail folds into this menu. */}
          <div className="relative md:hidden">
            <button
              ref={menuBtn}
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Desk menu"
              data-tt="Desk menu"
              data-tt-pos="bottom"
              data-tt-align="start"
              className={iconButtonClass("quiet", "md")}
            >
              <Menu aria-hidden />
            </button>
            <Popover open={menuOpen} onClose={() => setMenuOpen(false)} triggerRef={menuBtn} role="menu" label="Desk menu" width="w-60" className="mt-1">
              {dests.map((d) => (
                <Link
                  key={d.href}
                  href={d.href}
                  role="menuitem"
                  aria-current={d.match(pathname) ? "page" : undefined}
                  className={railRowClass(d.match(pathname), { dense: true })}
                >
                  <span className={railIconClass(d.match(pathname))}>{d.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{d.label}</span>
                  {d.badge ? (
                    <span className="rounded-full bg-compass-600 px-1.5 text-2xs font-semibold text-white">
                      {d.badge}
                      <span className="sr-only"> {d.badgeLabel}</span>
                    </span>
                  ) : null}
                </Link>
              ))}
              <Link href="/" target="_blank" role="menuitem" className={railRowClass(false, { dense: true })}>
                <ExternalLink className="h-5 w-5 text-slate-400" aria-hidden />
                <span className="min-w-0 flex-1 truncate">CompassDocs</span>
              </Link>
            </Popover>
          </div>
          <Link href={caps.agent ? "/desk" : "/desk/approvals"} className="flex shrink-0 items-center gap-2 text-base font-bold text-slate-900">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-compass-600 text-white">
              <LifeBuoy className="h-4.5 w-4.5" aria-hidden />
            </span>
            <span className="hidden sm:inline">Desk</span>
          </Link>
          <div className="flex min-w-0 flex-1 sm:ml-3">
            <DeskSearch />
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <a
              href="/"
              target="_blank"
              rel="noopener"
              className="hidden items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-800 lg:inline-flex"
            >
              CompassDocs
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <DeskBell initialUnread={unread} />
            <AvailabilityMenu name={user.name} role={role?.key ?? null} initial={availability} extra={installSlot} />
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Desk" className="hidden w-sidebar-rail shrink-0 flex-col items-center gap-1.5 border-r border-slate-200 bg-surface py-3 md:flex print:hidden">
            {dests.map((d) => {
              const on = d.match(pathname);
              return (
                <Link
                  key={d.href}
                  href={d.href}
                  data-tt={d.label}
                  data-tt-pos="right"
                  aria-label={d.badge ? `${d.label}, ${d.badge} ${d.badgeLabel}` : d.label}
                  aria-current={on ? "page" : undefined}
                  className={`relative grid h-10.5 w-10.5 place-items-center rounded-lg transition ${
                    on ? "bg-compass-50 text-compass-700" : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  }`}
                >
                  {d.icon}
                  {d.badge ? (
                    <span
                      className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-compass-600 px-1 text-3xs font-semibold leading-none text-white"
                      aria-hidden
                    >
                      {d.badge > 99 ? "99+" : d.badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
          <main id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 outline-none">
            {children}
          </main>
        </div>
      </div>
    </DeskCountsContext.Provider>
    </DeskMeContext.Provider>
  );
}
