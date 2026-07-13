import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/db";
import { eePresent } from "@/lib/ee";
import { proxyManaged } from "@/lib/caddy";
import { SetupForm } from "@/components/SetupForm";
import { Brand } from "@/components/Brand";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  // Once an admin exists, setup is done — send people to sign in.
  if (!(await needsSetup())) redirect("/login");

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-compass-50 px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <Brand name="CompassDocs" size="lg" layout="col" />
          <h1 className="mt-3 text-2xl font-bold text-slate-900">Welcome — let&rsquo;s set up</h1>
          <p className="text-sm text-slate-500">
            Create your admin account to finish installing CompassDocs.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
          <SetupForm enterprise={eePresent()} proxyManaged={proxyManaged()} />
        </div>
        <p className="mt-4 text-center text-xs text-slate-400">
          You can add teammates and adjust settings later from the Admin console.
        </p>
      </div>
    </div>
  );
}
