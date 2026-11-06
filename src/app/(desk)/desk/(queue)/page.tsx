// /desk: the queue with no ticket open. A helpdesk manager whose helpdesk
// is not set up yet is taken to the setup checklist first.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getHelpdeskSettings } from "@/lib/helpdesk/settings";
import { NoTicketPane } from "@/components/helpdesk/desk/ticket/NoTicketPane";
import { canOpenSettings, deskAccess } from "../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tickets" };

export default async function DeskHome() {
  const user = await requireUser();
  const access = await deskAccess(user);
  if (access.licensed && (await canOpenSettings(user, "setup"))) {
    const settings = await getHelpdeskSettings().catch(() => null);
    if (settings && !settings.setup_complete) redirect("/desk/setup");
  }
  return <NoTicketPane />;
}
