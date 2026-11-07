// /desk/settings/claude-desk: Claude in the desk (desk settings, 1.20.0, mock c3).
// Opens for a desk role that holds settings.manage (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { ClaudeDeskSettings } from "@/components/helpdesk/desk/settings/ClaudeDeskSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Claude in the desk" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "claude-desk"))) return <DeskPageForbidden what="Claude in the desk" />;
  return <ClaudeDeskSettings />;
}
