import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "@/components/LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-compass-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-compass-600 text-2xl text-white shadow-md">
            🧭
          </span>
          <h1 className="mt-3 text-2xl font-bold text-slate-900">CompassDocs</h1>
          <p className="text-sm text-slate-500">Sign in to your team&apos;s knowledge base</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
