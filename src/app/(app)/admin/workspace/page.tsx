import { getApprovalMode } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { WorkspaceSettings } from "@/components/WorkspaceSettings";
import { ApprovalWorkflow } from "@/components/ApprovalWorkflow";

export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const [settings, approvalMode] = await Promise.all([getAppSettings(), getApprovalMode()]);
  return (
    <div className="space-y-8">
      <WorkspaceSettings initial={settings} />
      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Approval workflow</h2>
        <ApprovalWorkflow initial={approvalMode} />
      </section>
    </div>
  );
}
