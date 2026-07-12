import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { needsSetup } from "@/lib/db";
import { LoginForm } from "@/components/LoginForm";
import { Brand } from "@/components/Brand";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Fresh install with no admin yet → send to the first-run setup wizard.
  if (await needsSetup()) redirect("/setup");
  const user = await getCurrentUser();
  if (user) redirect("/");
  const settings = await getAppSettings();

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-compass-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <Brand name={settings.company_name} logoUrl={settings.logo_url || undefined} size="lg" layout="col" />
          <p className="mt-1 text-sm text-slate-500">Sign in to your team&apos;s knowledge base</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
