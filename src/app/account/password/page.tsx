import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { Brand } from "@/components/Brand";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { SignOutLink } from "@/components/SignOutLink";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set a new password", robots: { index: false, follow: false } };

// The forced first-login / admin-reset flow. Routine password changes live
// in Account → Security, so anyone who is not forced is sent there — this
// page has exactly one job.
export default async function ChangePasswordPage() {
  const user = await requireUser();
  if (!user.must_change_password) redirect("/account/security");
  const settings = await getAppSettings();

  return (
    <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-slate-100 to-compass-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Brand name={settings.company_name} logoUrl={settings.logo_url || undefined} size="lg" layout="col" />
          <h1 className="mt-4 text-xl font-bold text-slate-900">Set a new password</h1>
          <p className="mt-1 text-sm text-slate-500">
            Signed in as <span className="font-medium text-slate-700">{user.username}</span>. Choose a
            new password before continuing.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-xs">
          <ChangePasswordForm forced />
        </div>
        <p className="mt-4 text-center text-sm text-slate-500">
          Not you? <SignOutLink className="link font-medium" />
        </p>
      </div>
    </div>
  );
}
