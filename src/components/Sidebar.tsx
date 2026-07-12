import Link from "next/link";
import { listSpaces } from "@/lib/db";
import { GlobalSearch } from "./GlobalSearch";
import { UserMenu } from "./UserMenu";
import { roleAtLeast } from "@/lib/types";
import type { SessionUser } from "@/lib/types";

export async function Sidebar({ user, reviewCount }: { user: SessionUser; reviewCount: number }) {
  const spaces = await listSpaces();
  const isEditor = roleAtLeast(user.role, "editor");
  const isApprover = roleAtLeast(user.role, "approver");
  const isAdmin = user.role === "admin";

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-16 items-center gap-2 border-b border-slate-100 px-5">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-compass-600 text-lg text-white shadow-sm">
            🧭
          </span>
          <span className="text-lg font-bold tracking-tight text-slate-900">CompassDocs</span>
        </Link>
      </div>

      <div className="px-3 py-3">
        <GlobalSearch />
      </div>

      <nav className="px-3 pb-2 text-sm">
        <NavLink href="/" icon="🏠">
          Dashboard
        </NavLink>
        <NavLink href="/search" icon="✨">
          Ask CompassDocs
        </NavLink>
        {isApprover && (
          <NavLink href="/review" icon="📋" badge={reviewCount}>
            Review queue
          </NavLink>
        )}
        {isAdmin && (
          <NavLink href="/admin" icon="⚙️">
            Admin
          </NavLink>
        )}
      </nav>

      <div className="mt-2 px-5 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Spaces
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-4 text-sm">
        {spaces.map((s) => (
          <Link
            key={s.id}
            href={`/spaces/${s.slug}`}
            className="flex items-center justify-between rounded-md px-3 py-2 text-slate-600 hover:bg-slate-100"
          >
            <span className="flex items-center gap-2 truncate">
              <span>{s.icon}</span>
              <span className="truncate">{s.name}</span>
            </span>
          </Link>
        ))}
      </nav>

      {isEditor && (
        <div className="border-t border-slate-100 p-3">
          <Link
            href="/doc/new"
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-compass-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-compass-700"
          >
            <span className="text-base leading-none">＋</span> New document
          </Link>
        </div>
      )}

      <UserMenu user={user} />
    </aside>
  );
}

function NavLink({
  href,
  icon,
  badge,
  children,
}: {
  href: string;
  icon: string;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-md px-3 py-2 font-medium text-slate-600 hover:bg-slate-100"
    >
      <span>{icon}</span>
      <span className="flex-1">{children}</span>
      {badge ? (
        <span className="rounded-full bg-compass-100 px-1.5 text-xs font-semibold text-compass-700">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
