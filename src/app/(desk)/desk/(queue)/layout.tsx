// The ticket queue (/desk and /desk/tickets/[number]) shares one layout so
// the views and the list stay mounted while tickets open beside them.
// Agents only: someone who holds only configuration or reports lands on
// the part of the desk they can use.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { QueueLayout } from "@/components/helpdesk/desk/queue/QueueLayout";
import { firstSettingsHref } from "@/components/helpdesk/desk/settings/settings-nav";
import { deskAccess, deskRoleCaps } from "../../desk-access";

export default async function QueueRouteLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const access = await deskAccess(user);
  if (access.licensed && access.any && !access.agent) {
    redirect(access.reports ? "/desk/reports" : firstSettingsHref((await deskRoleCaps(user)).caps));
  }
  return <QueueLayout>{children}</QueueLayout>;
}
