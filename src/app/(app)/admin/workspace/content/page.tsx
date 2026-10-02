import { requireSettingsSection } from "@/lib/auth";
import { getApprovalMode } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { WorkspaceSettings } from "@/components/WorkspaceSettings";
import { ApprovalWorkflow } from "@/components/ApprovalWorkflow";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/workspace", "Content");

export default async function WorkspaceContentPage() {
  await requireSettingsSection("/admin/workspace");
  const [settings, approvalMode] = await Promise.all([getAppSettings(), getApprovalMode()]);
  return (
    <div className="space-y-8">
      <WorkspaceSettings initial={settings} scope="content" />
      <section id="approval" className="scroll-mt-6">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Approval workflow</h2>
        <ApprovalWorkflow initial={approvalMode} />
      </section>
    </div>
  );
}
