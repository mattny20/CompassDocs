// /desk/settings/claude: Claude connector (desk settings, 1.19.1). Opens for
// a desk role that holds settings.manage (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { ClaudeConnectorSettings } from "@/components/helpdesk/desk/settings/ClaudeConnectorSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Claude connector" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "claude"))) return <DeskPageForbidden what="Claude connector" />;
  return <ClaudeConnectorSettings />;
}
