import { requireRole } from "@/lib/auth";
import { listChangeRequests, listSuggestions } from "@/lib/db";
import { ReviewClient } from "@/components/ReviewClient";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  await requireRole("approver");
  const [changeRequests, suggestions] = await Promise.all([
    listChangeRequests("pending"),
    listSuggestions("open"),
  ]);

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <h1 className="text-2xl font-bold text-slate-900">Review queue</h1>
      <p className="mb-6 mt-1 text-slate-500">
        Approve or reject proposed changes, and triage suggestions from the team.
      </p>
      <ReviewClient changeRequests={changeRequests} suggestions={suggestions} />
    </div>
  );
}
