import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ArrowLeft, BellRing, KeyRound, ShieldCheck, Cable } from "lucide-react";
import { requireUser, SESSION_COOKIE } from "@/lib/auth";
import {
  getUserById,
  listSubscriptionsForUser,
  listApiTokens,
  listOAuthGrants,
  listUserSessions,
  getTotpState,
} from "@/lib/db";
import { ROLE_LABEL } from "@/lib/types";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { SecurityPanel } from "@/components/SecurityPanel";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { ApiTokens } from "@/components/ApiTokens";

export const dynamic = "force-dynamic";

// One page for everything personal: notifications, security (2FA + sessions),
// password, and API tokens. The old /account/* URLs redirect here.
export default async function AccountPage() {
  const user = await requireUser();
  // The forced-reset flow stays on its focused page.
  if (user.must_change_password) redirect("/account/password");

  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const [me, subs, tokens, connections, sessions, totp] = await Promise.all([
    getUserById(user.id),
    listSubscriptionsForUser(user.id),
    listApiTokens(user.id),
    listOAuthGrants(user.id),
    listUserSessions(user.id, token),
    getTotpState(user.id),
  ]);

  const initials = (user.name || user.username)
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const NAV = [
    { href: "#notifications", label: "Notifications", icon: <BellRing className="h-3.5 w-3.5" /> },
    { href: "#security", label: "Security & MFA", icon: <ShieldCheck className="h-3.5 w-3.5" /> },
    { href: "#password", label: "Password", icon: <KeyRound className="h-3.5 w-3.5" /> },
    { href: "#api", label: "API tokens", icon: <Cable className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-compass-50 px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <Link
          href="/"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-compass-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to CompassDocs
        </Link>

        {/* Who you are */}
        <div className="mb-6 flex items-center gap-4 rounded-2xl border border-slate-200 bg-surface p-5 shadow-sm">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-compass-100 text-lg font-bold text-compass-700">
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold text-slate-900">
              {user.name || user.username}
            </h1>
            <p className="truncate text-sm text-slate-500">
              @{user.username} · {me?.email || "no email"} · {ROLE_LABEL[user.role]}
            </p>
          </div>
        </div>

        {/* Section shortcuts */}
        <nav className="mb-6 flex flex-wrap gap-2">
          {NAV.map((n) => (
            <a
              key={n.href}
              href={n.href}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-surface px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm hover:border-compass-300 hover:text-compass-700"
            >
              {n.icon}
              {n.label}
            </a>
          ))}
        </nav>

        <div className="space-y-8">
          <section id="notifications" className="scroll-mt-6">
            <h2 className="mb-1 font-semibold text-slate-900">Notifications</h2>
            <p className="mb-3 text-sm text-slate-500">
              Email alerts for the spaces you subscribe to.
            </p>
            <NotificationsPanel
              initialEnabled={me?.email_notifications === 1}
              email={me?.email ?? ""}
              initialSubs={subs}
            />
          </section>

          <section id="security" className="scroll-mt-6">
            <h2 className="mb-1 font-semibold text-slate-900">Security &amp; MFA</h2>
            <p className="mb-3 text-sm text-slate-500">
              Two-factor authentication and your signed-in devices.
            </p>
            <SecurityPanel
              initialSessions={sessions}
              initialTotp={{
                enabled: Boolean(totp?.enabled),
                recovery_left: totp?.enabled ? totp.recovery_left : 0,
              }}
            />
          </section>

          <section id="password" className="scroll-mt-6">
            <h2 className="mb-1 font-semibold text-slate-900">Password</h2>
            <p className="mb-3 text-sm text-slate-500">
              Choose a strong password you don&apos;t use anywhere else.
            </p>
            <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
              <ChangePasswordForm forced={false} />
            </div>
          </section>

          <section id="api" className="scroll-mt-6">
            <h2 className="mb-1 font-semibold text-slate-900">API tokens</h2>
            <p className="mb-3 text-sm text-slate-500">
              Personal tokens for the Claude connector and other integrations. They act as you,
              with your role ({ROLE_LABEL[user.role]}).
            </p>
            <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
              <ApiTokens initial={tokens} initialConnections={connections} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
