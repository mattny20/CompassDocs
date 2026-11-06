// The customer portal's header (Helpdesk 1.19.1): the portal's logo (or
// its initials) and name, linking to the portal's home, and, when signed
// in, the address and Sign out. Nothing from CompassDocs. On a phone the
// address truncates and Sign out keeps its place. Server-safe.

import Link from "next/link";
import { brandInitials } from "@/lib/helpdesk/portal-shared";
import { PortalSignOut } from "./PortalSignOut";

export function PortalHeader({ name, logoUrl, email }: { name: string; logoUrl: string | null; email: string | null }) {
  return (
    <header className="border-b border-slate-200 bg-surface print:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3 sm:px-7">
        <Link href={email ? "/support/requests" : "/support"} className="flex min-w-0 items-center gap-2.5">
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
        {email && (
          <div className="ml-auto flex min-w-0 items-center gap-1.5 text-sm text-slate-500 print:hidden">
            <span className="hidden min-w-0 truncate sm:inline" data-testid="portal-email">
              {email}
            </span>
            <span aria-hidden className="hidden sm:inline">
              ·
            </span>
            <PortalSignOut email={email} />
          </div>
        )}
      </div>
    </header>
  );
}
