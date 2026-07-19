"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogOut, UserCog } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { ROLE_LABEL } from "@/lib/types";
import type { SessionUser } from "@/lib/types";

// Sidebar footer: identity plus three compact icon actions (theme, manage
// account, sign out) in a single row — tooltips carry the labels. In the
// collapsed sidebar the same controls stack vertically.

export function UserMenu({ user, collapsed = false }: { user: SessionUser; collapsed?: boolean }) {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const initials = (user.name || user.username)
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const avatar = (
    <Link
      href="/account"
      title={`${user.name || user.username} — manage account`}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-compass-100 text-xs font-bold text-compass-700 transition hover:ring-2 hover:ring-compass-300"
    >
      {initials}
    </Link>
  );

  const iconBtn =
    "rounded-md p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700";

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-slate-100 py-3">
        {avatar}
        <ThemeToggle />
        <Link href="/account" title="Manage account" className={iconBtn}>
          <UserCog className="h-4 w-4" />
        </Link>
        <button onClick={logout} title="Sign out" aria-label="Sign out" className={iconBtn}>
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-t border-slate-100 p-3">
      {avatar}
      <div className="min-w-0 flex-1">
        <Link
          href="/account"
          className="block truncate text-sm font-medium text-slate-800 hover:text-compass-700"
        >
          {user.name || user.username}
        </Link>
        <div className="truncate text-xs text-slate-400">{ROLE_LABEL[user.role]}</div>
      </div>
      <div className="flex shrink-0 items-center">
        <ThemeToggle />
        <Link href="/account" title="Manage account" className={iconBtn}>
          <UserCog className="h-4 w-4" />
        </Link>
        <button onClick={logout} title="Sign out" aria-label="Sign out" className={iconBtn}>
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
