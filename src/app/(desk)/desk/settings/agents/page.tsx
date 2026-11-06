// /desk/settings/agents: Agents (desk settings, agent J). Who is on the
// desk and at which role. Opens for a desk role holding agents.assign_roles
// (Managers, Admins) or agents.manage_team (Team leads, their own teams).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { AgentsSettings } from "@/components/helpdesk/desk/roles/AgentsSettings";
import { deskRoleCaps } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

export default async function Page() {
  const user = await requireUser();
  const r = await deskRoleCaps(user);
  if (!r.can("agents.assign_roles") && !r.can("agents.manage_team")) return <DeskPageForbidden what="Agents" />;
  return <AgentsSettings />;
}
