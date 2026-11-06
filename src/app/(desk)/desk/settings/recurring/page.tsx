// /desk/settings/recurring: Recurring tickets (1.19.1, agent V8). Opens for
// settings.manage (every team's schedules) or agents.manage_team (a team
// lead, their teams'): SETTINGS_CAP in desk-access. The API checks the team.

import { Suspense } from "react";
import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { RecurringSettings } from "@/components/helpdesk/desk/recurring/RecurringSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recurring tickets" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "recurring"))) return <DeskPageForbidden what="Recurring tickets" />;
  return (
    <Suspense>
      <RecurringSettings />
    </Suspense>
  );
}
