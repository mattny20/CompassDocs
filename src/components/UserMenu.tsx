"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogOut, UserCog } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { UserAvatar } from "./UserAvatar";
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

  const avatar = (
    <Link
      href="/account"
      data-tt={`${user.name || user.username} — manage account`} aria-label={`${user.name || user.username} — manage account`}
      className="shrink-0 rounded-full transition hover:ring-2 hover:ring-compass-300"
    >
      <UserAvatar name={user.name || user.username} avatar={user.avatar} size="sm" />
    </Link>
  );

  const iconBtn =
    "rounded-md p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700";

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-slate-100 py-3">
        {avatar}
        <ThemeToggle accountPref={user.theme} />
        <Link href="/account" data-tt="Manage account" aria-label="Manage account" className={iconBtn}>
          <UserCog className="h-4 w-4" />
        </Link>
        <button onClick={logout} data-tt="Sign out" aria-label="Sign out" className={iconBtn}>
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
        <div className="truncate text-xs text-slate-500">{ROLE_LABEL[user.role]}</div>
      </div>
      <div className="flex shrink-0 items-center">
        <ThemeToggle accountPref={user.theme} />
        <Link href="/account" data-tt="Manage account" aria-label="Manage account" className={iconBtn}>
          <UserCog className="h-4 w-4" />
        </Link>
        <button onClick={logout} data-tt="Sign out" aria-label="Sign out" className={iconBtn}>
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
