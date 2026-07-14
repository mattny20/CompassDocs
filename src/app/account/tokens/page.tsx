import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listApiTokens } from "@/lib/db";
import { ApiTokens } from "@/components/ApiTokens";

export const dynamic = "force-dynamic";

export default async function ApiTokensPage() {
  const user = await requireUser();
  const tokens = await listApiTokens(user.id);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-compass-50 px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-slate-900">API tokens</h1>
          <p className="mt-1 text-sm text-slate-500">
            Personal tokens for the Claude connector and other integrations. They act as you, with
            your role ({user.role}).
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
          <ApiTokens initial={tokens} />
        </div>
        <div className="mt-4 flex items-center justify-center gap-4 text-sm">
          <Link href="/" className="text-compass-600 hover:text-compass-700">
            ← Back to CompassDocs
          </Link>
          <Link href="/account/password" className="text-slate-500 hover:text-slate-700">
            Change password
          </Link>
        </div>
      </div>
    </div>
  );
}
