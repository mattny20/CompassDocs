import Link from "next/link";
import { cookies } from "next/headers";
import { requireUser, SESSION_COOKIE } from "@/lib/auth";
import { listUserSessions, getTotpState } from "@/lib/db";
import { SecurityPanel } from "@/components/SecurityPanel";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const user = await requireUser();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const [sessions, totp] = await Promise.all([
    listUserSessions(user.id, token),
    getTotpState(user.id),
  ]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-compass-50 px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-slate-900">Security</h1>
          <p className="mt-1 text-sm text-slate-500">
            Two-factor authentication and your signed-in devices.
          </p>
        </div>
        <SecurityPanel
          initialSessions={sessions}
          initialTotp={{
            enabled: Boolean(totp?.enabled),
            recovery_left: totp?.enabled ? totp.recovery_left : 0,
          }}
        />
        <div className="mt-4 flex items-center justify-center gap-4 text-sm">
          <Link href="/" className="text-compass-600 hover:text-compass-700">
            ← Back to CompassDocs
          </Link>
          <Link href="/account/password" className="text-slate-500 hover:text-slate-700">
            Change password
          </Link>
          <Link href="/account/tokens" className="text-slate-500 hover:text-slate-700">
            API tokens
          </Link>
        </div>
      </div>
    </div>
  );
}
