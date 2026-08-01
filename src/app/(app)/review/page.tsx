import { requireRole } from "@/lib/auth";
import { spaceScopeFor } from "@/lib/access";
import { listChangeRequests, listSuggestions } from "@/lib/db";
import { ReviewClient } from "@/components/ReviewClient";
import { ClipboardCheck } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const user = await requireRole("approver");
  const scope = await spaceScopeFor(user);
  const [changeRequests, suggestions] = await Promise.all([
    listChangeRequests("pending", scope),
    listSuggestions("open", scope),
  ]);

  return (
    <PageContainer>
      <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
        <ClipboardCheck className="h-6 w-6 text-compass-600" /> Review queue
      </h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">
        Approve or reject proposed changes, and triage suggestions from the team.
      </p>
      <ReviewClient changeRequests={changeRequests} suggestions={suggestions} />
    </PageContainer>
  );
}
