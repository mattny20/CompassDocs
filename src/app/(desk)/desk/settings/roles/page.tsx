// /desk/settings/roles: Roles (desk settings, agent J). The capability
// matrix of the five desk roles. Opens for roles.manage (Admins by default).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { RolesMatrix } from "@/components/helpdesk/desk/roles/RolesMatrix";
import { deskRoleCaps } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Roles" };

export default async function Page() {
  const user = await requireUser();
  const r = await deskRoleCaps(user);
  if (!r.can("roles.manage")) return <DeskPageForbidden what="Roles" />;
  return <RolesMatrix />;
}
