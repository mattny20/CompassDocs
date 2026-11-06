// /desk/settings/portal: Customer portal (desk settings, Helpdesk 1.19.1,
// agent V6). Who outside the organisation may raise requests at /support,
// what they can ask for, the brand and the protection. Opens for a desk
// role holding settings.manage (the API checks the same).

import { requireUser } from "@/lib/auth";
import { hdCan } from "@/lib/helpdesk/roles";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { PortalSettings } from "@/components/helpdesk/desk/settings/PortalSettings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customer portal" };

export default async function Page() {
  const user = await requireUser();
  if (!(await hdCan(user, "settings.manage").catch(() => false))) return <DeskPageForbidden what="Customer portal" />;
  return <PortalSettings />;
}
