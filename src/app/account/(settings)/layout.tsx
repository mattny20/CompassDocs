import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getUserById } from "@/lib/db";
import { ROLE_LABEL } from "@/lib/types";
import { AccountNav } from "@/components/AccountNav";
import { UserAvatar } from "@/components/UserAvatar";

export const dynamic = "force-dynamic";

// The account settings shell: identity header, section rail on the left,
// one section at a time on the right. The forced password-reset flow lives
// outside this shell (/account/password) so it stays focused.
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (user.must_change_password) redirect("/account/password");
  const me = await getUserById(user.id);

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-100 to-compass-50 px-4 py-8">
      <div className="mx-auto w-full max-w-4xl">
        <Link
          href="/"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-compass-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to CompassDocs
        </Link>

        <div className="mb-6 flex items-center gap-4 rounded-2xl border border-slate-200 bg-surface p-5 shadow-xs">
          <UserAvatar name={user.name || user.username} avatar={user.avatar} size="md" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold text-slate-900">
              {user.name || user.username}
            </h1>
            <p className="truncate text-sm text-slate-500">
              @{user.username} · {me?.email || "no email"}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-compass-50 px-2.5 py-1 text-xs font-semibold text-compass-700 dark:bg-compass-950/40">
            {ROLE_LABEL[user.role]}
          </span>
        </div>

        <div className="md:grid md:grid-cols-[11rem_1fr] md:items-start md:gap-8">
          <div className="mb-4 md:mb-0">
            <AccountNav />
          </div>
          <main className="min-w-0">{children}</main>
        </div>
      </div>
    </div>
  );
}
