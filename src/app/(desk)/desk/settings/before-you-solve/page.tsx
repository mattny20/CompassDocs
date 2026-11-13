// /desk/settings/before-you-solve: Before you solve (desk settings, 1.20.5,
// lib/helpdesk/solve-requirements). The requirement sets: what agents fill in
// before a ticket can be solved. A list; each set has a page of its own.
// Opens for a desk role holding settings.manage (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { SolveRequirementsSettings } from "@/components/helpdesk/desk/solve/SolveRequirementsSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Before you solve" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "before-you-solve"))) return <DeskPageForbidden what="Before you solve" />;
  return <SolveRequirementsSettings />;
}
