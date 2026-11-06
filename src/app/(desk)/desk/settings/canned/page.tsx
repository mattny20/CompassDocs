// /desk/settings/canned: Canned responses (desk settings, 1.19.2 agent W4).
// Opens for a desk role that holds one of the macro capabilities
// (SETTINGS_CAP in desk-access): an Agent manages their own, a team lead
// their teams', a Manager everyone's.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { CannedSettings } from "@/components/helpdesk/desk/settings/CannedSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Canned responses" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "canned"))) return <DeskPageForbidden what="Canned responses" />;
  return <CannedSettings />;
}
