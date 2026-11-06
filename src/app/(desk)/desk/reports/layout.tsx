// /desk/reports and /desk/reports/explore (1.19.0, agent K): anyone with a
// report capability (reports.own, reports.team or reports.all, agent J's
// desk roles). The desk layout has already checked the licence and desk
// access; the API checks the same capabilities on every query.

import { ShieldOff } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { hdCan } from "@/lib/helpdesk/roles";
import { PageContainer } from "@/components/PageWidth";
import { EmptyState } from "@/components/form";

async function canReport(user: Awaited<ReturnType<typeof requireUser>>): Promise<boolean> {
  try {
    for (const cap of ["reports.own", "reports.team", "reports.all"] as const) if (await hdCan(user, cap)) return true;
  } catch {
    return false;
  }
  return false;
}

export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (!(await canReport(user))) {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto">
        <PageContainer>
          <EmptyState
            icon={<ShieldOff />}
            title="Reports aren't part of your desk role"
            body="Ask a helpdesk manager for your own stats, your team's reports or all reports."
            action={{ href: "/desk", label: "Back to tickets" }}
          />
        </PageContainer>
      </div>
    );
  }
  return children;
}
