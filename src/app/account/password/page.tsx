import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const user = await requireUser();
  const forced = user.must_change_password;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-compass-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-slate-900">
            {forced ? "Set a new password" : "Change your password"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {forced
              ? "For security, please choose a new password before continuing."
              : `Signed in as ${user.username}`}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <ChangePasswordForm forced={forced} />
        </div>
        {!forced && (
          <div className="mt-4 text-center">
            <Link href="/" className="text-sm text-compass-600 hover:text-compass-700">
              ← Back to CompassDocs
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
