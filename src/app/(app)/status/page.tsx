import { requireUser } from "@/lib/auth";
import { listStatusServices, listStatusIncidents } from "@/lib/db";
import { refreshDueStatuses, STATUS_CATALOG } from "@/lib/status";
import { roleAtLeast } from "@/lib/types";
import { StatusBoard } from "@/components/StatusBoard";

export const dynamic = "force-dynamic";

export default async function StatusPage() {
  const user = await requireUser();
  // Freshen anything stale in the background — the minutely scheduler is the
  // primary poller; this just makes a directly-loaded page current.
  void refreshDueStatuses().catch(() => {});
  const [services, incidents] = await Promise.all([
    listStatusServices(),
    listStatusIncidents(),
  ]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-bold text-slate-900">Service status</h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">
        The tools this organization relies on — vendor status pages, checked automatically,
        plus incidents declared for internal systems.
      </p>
      <StatusBoard
        services={services}
        incidents={incidents}
        catalog={STATUS_CATALOG}
        isAdmin={user.role === "admin"}
        isApprover={roleAtLeast(user.role, "approver")}
      />
    </div>
  );
}
