import { requirePermission } from "@/lib/auth";
import { spaceScopeFor } from "@/lib/access";
import { listChangeRequests, listSuggestions } from "@/lib/db";
import { ReviewClient } from "@/components/ReviewClient";
import { ClipboardCheck } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review queue" };

export default async function ReviewPage() {
  const user = await requirePermission("approver", "change_request.read");
  const scope = await spaceScopeFor(user);
  const [changeRequests, suggestions] = await Promise.all([
    listChangeRequests("pending", scope),
    listSuggestions("open", scope),
  ]);

  return (
    <PageContainer>
      <PageHeader
        icon={<ClipboardCheck />}
        title="Review queue"
        subtitle="Approve or reject proposed changes, and triage suggestions from the team."
      />
      <ReviewClient changeRequests={changeRequests} suggestions={suggestions} />
    </PageContainer>
  );
}
