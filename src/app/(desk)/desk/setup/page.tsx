// /desk/setup: the setup checklist (helpdesk managers).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { SetupChecklist } from "@/components/helpdesk/desk/setup/SetupChecklist";
import { canOpenSettings } from "../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up your helpdesk" };

export default async function SetupPage() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "setup"))) return <DeskPageForbidden what="Setup" />;
  return <SetupChecklist />;
}
