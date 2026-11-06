// /desk/settings/macros: Macros (desk settings). Opens for a desk role that
// holds the page's capability (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { MacrosSettings } from "@/components/helpdesk/desk/settings/MacrosSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Macros" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "macros"))) return <DeskPageForbidden what="Macros" />;
  return <MacrosSettings />;
}
