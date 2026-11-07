// The customer portal's header (Helpdesk 1.19.1): the portal's logo (or
// its initials) and name, linking to the portal's home, and, when signed
// in, the address and Sign out. Nothing from CompassDocs. On a phone the
// address truncates and Sign out keeps its place. Server-safe.
//
// With the help centre on (1.19.4, C3, mock h1) the right side reads
// "Help centre · Your requests" before the address (or Sign in when
// signed out), and the brand links to the help centre's home. The row
// wraps on a phone instead of scrolling sideways.

import Link from "next/link";
import { brandInitials } from "@/lib/helpdesk/portal-shared";
import { PortalSignOut } from "./PortalSignOut";

const NAV_LINK = "whitespace-nowrap hover:text-compass-700";

export function PortalHeader({ name, logoUrl, email, helpCentre = false }: { name: string; logoUrl: string | null; email: string | null; helpCentre?: boolean }) {
  return (
    <header className="border-b border-slate-200 bg-surface print:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:px-7">
        <Link href={helpCentre ? "/support" : email ? "/support/requests" : "/support"} className="flex min-w-0 items-center gap-2.5">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-8 w-8 shrink-0 rounded-lg object-contain" />
          ) : (
            <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-compass-50 text-xs font-semibold text-compass-700">
              {brandInitials(name)}
            </span>
          )}
          <span className="truncate text-base font-bold text-slate-900">{name}</span>
        </Link>
        {(email || helpCentre) && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-sm text-slate-500 print:hidden">
            {helpCentre && (
              <nav aria-label="Portal" className="flex items-center gap-1.5">
                <Link href="/support" className={NAV_LINK}>
                  Help centre
                </Link>
                <span aria-hidden>·</span>
                <Link href="/support/requests" className={NAV_LINK}>
                  Your requests
                </Link>
                {!email && (
                  <>
                    <span aria-hidden>·</span>
                    <Link href="/support?signin=1" className={`${NAV_LINK} font-medium text-slate-600`}>
                      Sign in
                    </Link>
                  </>
                )}
              </nav>
            )}
            {email && (
              <>
                {helpCentre && (
                  <span aria-hidden className="hidden sm:inline">
                    ·
                  </span>
                )}
                <span className="hidden min-w-0 truncate sm:inline" data-testid="portal-email">
                  {email}
                </span>
                <span aria-hidden className={helpCentre ? "" : "hidden sm:inline"}>
                  ·
                </span>
                <PortalSignOut email={email} />
              </>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
