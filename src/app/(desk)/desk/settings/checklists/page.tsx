// /desk/settings/checklists: Checklists (desk settings, 1.19.2, agent W3; mock-up c2).
// The checklist library: reusable lists of steps, what adds each one
// automatically (request types, workflow tasks) and the item editor. Opens
// for a desk role holding settings.manage, request_types.manage or
// workflows.manage (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { ChecklistSettings } from "@/components/helpdesk/desk/checklists/ChecklistSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Checklists" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "checklists"))) return <DeskPageForbidden what="Checklists" />;
  return <ChecklistSettings />;
}
