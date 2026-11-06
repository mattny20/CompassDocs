// /desk/settings/sla: Reply targets (desk settings). Opens for a desk role that
// holds the page's capability (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { SlaSettings } from "@/components/helpdesk/desk/settings/SlaSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reply targets" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "sla"))) return <DeskPageForbidden what="Reply targets" />;
  return <SlaSettings />;
}
