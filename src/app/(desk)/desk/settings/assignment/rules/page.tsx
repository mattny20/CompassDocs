// /desk/settings/assignment/rules: the ordered assignment rules and the test box (agent N). See ../layout.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { AssignmentRules } from "@/components/helpdesk/desk/assignment/AssignmentRules";
import { deskRoleCaps } from "../../../../desk-access";

export const metadata = { title: "Assignment rules" };

export default async function AssignmentRulesPage() {
  const user = await requireUser();
  const role = await deskRoleCaps(user);
  if (!role.can("automations.manage")) return <DeskPageForbidden what="Assignment rules" />;
  return <AssignmentRules />;
}
