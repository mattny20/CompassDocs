// /desk/settings/automations: Automations (desk settings). Opens for a desk role that
// holds the page's capability (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { AutomationsSettings } from "@/components/helpdesk/desk/settings/AutomationsSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automations" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "automations"))) return <DeskPageForbidden what="Automations" />;
  return <AutomationsSettings />;
}
