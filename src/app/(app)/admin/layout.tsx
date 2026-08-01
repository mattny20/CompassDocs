import { Settings } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { SettingsNav } from "@/components/SettingsNav";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRole("admin");

  return (
    <PageContainer>
      <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
        <Settings className="h-6 w-6 text-compass-600" /> Settings
      </h1>
      <p className="mb-6 mt-1 text-slate-500">Manage your workspace, users, and system.</p>
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
        <SettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </PageContainer>
  );
}
