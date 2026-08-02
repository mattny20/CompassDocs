import { requirePermission } from "@/lib/auth";
import { PageContainer } from "@/components/PageWidth";
import { AnalyticsClient } from "@/components/AnalyticsClient";

export const dynamic = "force-dynamic";

// Knowledge-base analytics dashboard (approvers + admins). All data loads
// client-side from /api/analytics so the filters stay snappy.

export default async function AnalyticsPage() {
  await requirePermission("approver", "analytics.read");
  return (
    <PageContainer>
      <AnalyticsClient />
    </PageContainer>
  );
}
