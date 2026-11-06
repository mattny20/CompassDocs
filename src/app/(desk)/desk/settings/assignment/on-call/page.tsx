// /desk/settings/assignment/on-call: each team's on-call rota (agent N). See ../layout.

import { Suspense } from "react";
import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { OnCallSettings } from "@/components/helpdesk/desk/assignment/OnCallSettings";
import { deskRoleCaps } from "../../../../desk-access";

export const metadata = { title: "On call" };

export default async function OnCallPage() {
  const user = await requireUser();
  const role = await deskRoleCaps(user);
  if (!role.can("agents.manage_team")) return <DeskPageForbidden what="On call" />;
  return (
    <Suspense>
      <OnCallSettings />
    </Suspense>
  );
}
