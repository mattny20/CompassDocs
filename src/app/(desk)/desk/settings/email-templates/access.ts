// Who may open the desk's Email templates (1.19.0): a desk admin
// (helpdesk.admin, or the desk role capability templates.manage once agent
// J's roles land, through deskRoleCaps), or a workspace template manager.
// Desk admins compose the helpdesk emails; parts stay with template
// managers (lib/email-parts-access asks the same). Server-only.

import "server-only";
import type { SessionUser } from "@/lib/types";
import { templatesAccess } from "@/components/email-templates/access";
import { deskAccess, deskRoleCaps } from "../../../desk-access";

export async function deskTemplatesAccess(user: SessionUser) {
  const [desk, role, core] = await Promise.all([deskAccess(user), deskRoleCaps(user), templatesAccess(user)]);
  const compose = core.manage || (desk.licensed && (desk.admin || role.can("templates.manage")));
  return { licensed: desk.licensed, compose, open: compose || core.read, editParts: core.manage };
}
