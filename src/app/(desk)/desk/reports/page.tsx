// /desk/reports (1.19.0, agent K): the desk's dashboards. The data loads
// from /api/helpdesk/analytics/**; the view (dashboard, dates, filters)
// lives in the address.

import { Suspense } from "react";
import { ReportsDashboard } from "@/components/helpdesk/desk/reports/ReportsDashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports" };

export default function DeskReportsPage() {
  return (
    <Suspense>
      <ReportsDashboard />
    </Suspense>
  );
}
