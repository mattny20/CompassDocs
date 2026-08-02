import { redirect } from "next/navigation";
import { Settings } from "lucide-react";
import { requireUser, reachableSettingsSections } from "@/lib/auth";
import { SettingsNav } from "@/components/SettingsNav";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Enforcement lives on each page, not here (0.93): the console is no longer
  // all-or-nothing, so a role holding one settings permission gets that section
  // and nothing else. The layout only decides whether there is anything at all
  // to show, and which entries the rail may link to.
  const user = await requireUser();
  const reachable = await reachableSettingsSections(user);
  if (reachable.length === 0) redirect("/");

  return (
    <PageContainer>
      <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
        <Settings className="h-6 w-6 text-compass-600" /> Settings
      </h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">Manage your workspace, users, and system.</p>
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
        <SettingsNav reachable={reachable} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </PageContainer>
  );
}
