// /desk/settings/teams: Teams (desk settings). Opens for a desk role that
// holds the page's capability (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { TeamsSettings } from "@/components/helpdesk/desk/settings/TeamsSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Teams" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "teams"))) return <DeskPageForbidden what="Teams" />;
  return <TeamsSettings />;
}
