import { requireRole } from "@/lib/auth";
import { SettingsNav } from "@/components/SettingsNav";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRole("admin");

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
      <p className="mb-6 mt-1 text-slate-500">Manage your workspace, users, and system.</p>
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
        <SettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
