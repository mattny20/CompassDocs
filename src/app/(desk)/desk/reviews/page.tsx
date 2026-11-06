// /desk/reviews: newbies' replies held for a lead's review (agent J's
// ReviewPanel), for desk roles holding replies.review.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { ReviewPanel } from "@/components/helpdesk/desk/roles/ReviewPanel";
import { deskRoleCaps } from "../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reviews" };

export default async function ReviewsPage() {
  const user = await requireUser();
  if (!(await deskRoleCaps(user)).can("replies.review")) return <DeskPageForbidden what="Reviews" />;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <ReviewPanel />
    </div>
  );
}
