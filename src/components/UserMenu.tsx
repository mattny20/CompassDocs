"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ROLE_LABEL } from "@/lib/types";
import type { SessionUser } from "@/lib/types";

export function UserMenu({ user }: { user: SessionUser }) {
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

  return (
    <div className="flex items-center gap-2 border-t border-slate-100 p-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-compass-100 text-xs font-bold text-compass-700">
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <Link href="/account/password" className="block truncate text-sm font-medium text-slate-800 hover:text-compass-700">
          {user.name || user.username}
        </Link>
        <div className="text-xs text-slate-400">{ROLE_LABEL[user.role]}</div>
      </div>
      <button
        onClick={logout}
        title="Sign out"
        className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
      >
        Sign out
      </button>
    </div>
  );
}
