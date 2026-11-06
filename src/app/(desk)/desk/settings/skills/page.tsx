// /desk/settings/skills: Skills and languages (desk settings, 1.19.2, agent W2).
// The workspace's skills and languages and each agent's tags, which assignment
// rules route on. Opens for agents.manage_team (a lead tags their teams'
// people) or teams.manage (also edits the lists): SETTINGS_CAP in desk-access.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { SkillsSettings } from "@/components/helpdesk/desk/skills/SkillsSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Skills and languages" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "skills"))) return <DeskPageForbidden what="Skills and languages" />;
  return <SkillsSettings />;
}
