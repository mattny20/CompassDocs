// /desk/settings/retention: Retention and privacy (desk settings, 1.19.1).
// How long tickets are kept and what happens to a removed account's
// tickets. Opens for a desk role that holds the page's capability
// (SETTINGS_CAP in desk-access: settings.manage).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { RetentionSettings } from "@/components/helpdesk/desk/settings/RetentionSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Retention and privacy" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "retention"))) return <DeskPageForbidden what="Retention and privacy" />;
  return <RetentionSettings />;
}
