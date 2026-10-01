import { cookies } from "next/headers";
import { AccountPage } from "@/components/AccountPage";
import { requireUser, SESSION_COOKIE } from "@/lib/auth";
import { listUserSessions, getTotpState } from "@/lib/db";
import { SecurityPanel } from "@/components/SecurityPanel";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Security" };

export default async function SecurityPage() {
  const user = await requireUser();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const [sessions, totp] = await Promise.all([
    listUserSessions(user.id, token),
    getTotpState(user.id),
  ]);

  return (
    <AccountPage href="/account/security">
      <div className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs">
          <h3 className="mb-1 text-sm font-semibold text-slate-900">Change password</h3>
          <p className="mb-3 text-sm text-slate-500">
            Choose a strong password you don&apos;t use anywhere else.
          </p>
          <ChangePasswordForm forced={false} />
        </div>
        <SecurityPanel
          initialSessions={sessions}
          initialTotp={{
            enabled: Boolean(totp?.enabled),
            recovery_left: totp?.enabled ? totp.recovery_left : 0,
          }}
        />
      </div>
    </AccountPage>
  );
}
