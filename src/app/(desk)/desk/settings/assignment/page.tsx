// /desk/settings/assignment: each team's mode and people (agent N). See ./layout.

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { TeamAssignment } from "@/components/helpdesk/desk/assignment/TeamAssignment";
import { deskRoleCaps } from "../../../desk-access";

export const metadata = { title: "Assignment" };

export default async function AssignmentPage() {
  const user = await requireUser();
  const role = await deskRoleCaps(user);
  if (!role.can("agents.manage_team")) redirect("/desk/settings/assignment/rules");
  return (
    <Suspense>
      <TeamAssignment />
    </Suspense>
  );
}
