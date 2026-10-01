"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogOut } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { UserAvatar } from "./UserAvatar";
import { ROLE_LABEL } from "@/lib/types";
import type { SessionUser } from "@/lib/types";

// Sidebar footer: one identity link (avatar + name + role → Manage account)
// plus the theme toggle and sign out. It used to offer three tab stops to the
// same /account page (avatar, name, a cog icon) in a 232px row, which also
// pushed long names into the icons.

export function UserMenu({ user, collapsed = false }: { user: SessionUser; collapsed?: boolean }) {
  const router = useRouter();
  const display = user.name || user.username;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const iconBtn = "rounded-md p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700";

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-slate-100 py-3">
        <Link
          href="/account"
          data-tt="Manage account"
          aria-label={`${display} — manage account`}
          className="shrink-0 rounded-full transition hover:ring-2 hover:ring-compass-300"
        >
          <UserAvatar name={display} avatar={user.avatar} size="sm" />
        </Link>
        <ThemeToggle accountPref={user.theme} />
        <button onClick={logout} data-tt="Sign out" aria-label="Sign out" className={iconBtn}>
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-t border-slate-100 p-3">
      <Link
        href="/account"
        data-tt="Manage account"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md transition hover:text-compass-700"
      >
        <UserAvatar name={display} avatar={user.avatar} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-800">{display}</span>
          <span className="block truncate text-xs text-slate-500">{ROLE_LABEL[user.role]}</span>
        </span>
      </Link>
      <div className="flex shrink-0 items-center">
        <ThemeToggle accountPref={user.theme} />
        <button onClick={logout} data-tt="Sign out" aria-label="Sign out" className={iconBtn}>
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
