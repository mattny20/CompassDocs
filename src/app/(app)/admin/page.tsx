import { requireRole } from "@/lib/auth";
import { listUsers, getApprovalMode } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { AdminClient } from "@/components/AdminClient";
import { ImportExport } from "@/components/ImportExport";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireRole("admin");
  const [users, approvalMode, settings] = await Promise.all([
    listUsers(),
    getApprovalMode(),
    getAppSettings(),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <h1 className="text-2xl font-bold text-slate-900">Admin</h1>
      <p className="mb-6 mt-1 text-slate-500">Manage users, roles, and workspace settings.</p>
      <AdminClient
        users={users}
        currentUserId={admin.id}
        approvalMode={approvalMode}
        settings={settings}
      />

      <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Import &amp; export</h2>
        <ImportExport />
      </section>
    </div>
  );
}
