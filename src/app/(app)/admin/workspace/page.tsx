import { requireSettingsSection } from "@/lib/auth";
import { getApprovalMode } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { WorkspaceSettings } from "@/components/WorkspaceSettings";
import { ApprovalWorkflow } from "@/components/ApprovalWorkflow";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  await requireSettingsSection("/admin/workspace");
  const [settings, approvalMode] = await Promise.all([getAppSettings(), getApprovalMode()]);
  return (
    <SettingsPage href="/admin/workspace">
    <div className="space-y-8">
      <WorkspaceSettings initial={settings} />
      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Approval workflow</h2>
        <ApprovalWorkflow initial={approvalMode} />
      </section>
    </div>
    </SettingsPage>
  );
}
