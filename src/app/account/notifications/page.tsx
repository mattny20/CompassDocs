import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getUserById, listSubscriptionsForUser } from "@/lib/db";
import { NotificationsPanel } from "@/components/NotificationsPanel";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await requireUser();
  const [me, subs] = await Promise.all([getUserById(user.id), listSubscriptionsForUser(user.id)]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-compass-50 px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-slate-900">Notifications</h1>
          <p className="mt-1 text-sm text-slate-500">
            Email alerts for the spaces you subscribe to.
          </p>
        </div>
        <NotificationsPanel
          initialEnabled={me?.email_notifications === 1}
          email={me?.email ?? ""}
          initialSubs={subs}
        />
        <div className="mt-4 flex items-center justify-center gap-4 text-sm">
          <Link href="/" className="text-compass-600 hover:text-compass-700">
            ← Back to CompassDocs
          </Link>
          <Link href="/account/security" className="text-slate-500 hover:text-slate-700">
            Security
          </Link>
          <Link href="/account/tokens" className="text-slate-500 hover:text-slate-700">
            API tokens
          </Link>
        </div>
      </div>
    </div>
  );
}
