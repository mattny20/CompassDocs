// /desk/settings/csat: Satisfaction (desk settings). Opens for a desk role that
// holds the page's capability (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { CsatSettings } from "@/components/helpdesk/desk/settings/CsatSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Satisfaction" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "csat"))) return <DeskPageForbidden what="Satisfaction" />;
  return <CsatSettings />;
}
