// /desk/recycle-bin (1.19.4, area C7; mock-up v2): deleted tickets for 30
// days, for desk roles holding tickets.delete. It sits in the queue's
// layout so the Views nav stays beside it; the layout leaves out the ticket
// list here (QueueLayout, binPage).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { RecycleBinView } from "@/components/helpdesk/desk/recycle-bin/RecycleBinView";
import { deskRoleCaps } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recycle bin" };

export default async function RecycleBinPage() {
  const user = await requireUser();
  if (!(await deskRoleCaps(user)).can("tickets.delete")) return <DeskPageForbidden what="The recycle bin" />;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <RecycleBinView />
    </div>
  );
}
