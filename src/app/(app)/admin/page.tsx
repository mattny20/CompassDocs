import { requireRole } from "@/lib/auth";
import { listUsers, getApprovalMode } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { listBackups } from "@/lib/backup";
import { destinationStatus } from "@/lib/backup-destinations";
import { AdminClient } from "@/components/AdminClient";
import { ImportExport } from "@/components/ImportExport";
import { BackupsClient } from "@/components/BackupsClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireRole("admin");
  const [users, approvalMode, settings, backups] = await Promise.all([
    listUsers(),
    getApprovalMode(),
    getAppSettings(),
    listBackups(),
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

      <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Database backups</h2>
        <BackupsClient backups={backups} destinations={destinationStatus()} settings={settings} />
      </section>
    </div>
  );
}
