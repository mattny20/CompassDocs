import { requireUser } from "@/lib/auth";
import { userHolds } from "@/lib/access";
import { listStatusServices, listStatusIncidents } from "@/lib/db";
import { refreshDueStatuses, STATUS_CATALOG } from "@/lib/status";
import { Activity } from "lucide-react";
import { StatusBoard } from "@/components/StatusBoard";
import { PageContainer } from "@/components/PageWidth";

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
    <PageContainer>
      <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
        <Activity className="h-6 w-6 text-compass-600" /> Service status
      </h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">
        The tools this organization relies on — vendor status pages, checked automatically,
        plus incidents declared for internal systems.
      </p>
      <StatusBoard
        services={services}
        incidents={incidents}
        catalog={STATUS_CATALOG}
        isAdmin={user.role === "admin"}
        canManageIncidents={await userHolds(user, "status.incident_manage", { legacyMin: "approver" })}
      />
    </PageContainer>
  );
}
