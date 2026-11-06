// GET  /api/helpdesk/admin/skills   → { skills, languages, agents, can_manage_lists, catalogue }
//      Settings → Skills and languages: the workspace's skills and languages with how many agents have
//      each, and everyone on the desk with their tags (manageable = the caller may change them).
// POST /api/helpdesk/admin/skills   { name } → 201 { skill }   add a skill (teams.manage)
// Helpdesk 1.19.2 (agent W2). Opens for agents.manage_team or teams.manage. Audited as helpdesk.skills.skill_created.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdAnyCapGate, hdCapGate } from "@/lib/helpdesk/roles";
import { auditSkills, badRequest, skillsErrorResponse, skillsOverview } from "@/lib/helpdesk/skills/routes";
import { createSkill } from "@/lib/helpdesk/skills/store";
import { validateSkillName } from "@/lib/helpdesk/skills/shared";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdAnyCapGate(["agents.manage_team", "teams.manage"]);
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await skillsOverview(gate));
}

export async function POST(req: Request) {
  const gate = await hdCapGate("teams.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 4 * 1024);
  if (!body) return badRequest("Send the skill as JSON.");
  const name = validateSkillName(body.name);
  if (!name.ok) return badRequest(name.error);
  try {
    const skill = await createSkill(name.value, gate.id);
    await auditSkills(req, gate, "helpdesk.skills.skill_created", { type: "helpdesk_skill", id: skill.id, label: skill.name }, { name: skill.name });
    return NextResponse.json({ skill }, { status: 201 });
  } catch (e) {
    const r = skillsErrorResponse(e);
    if (r) return r;
    throw e;
  }
}
