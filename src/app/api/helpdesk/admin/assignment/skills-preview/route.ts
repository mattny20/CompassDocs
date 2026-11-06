// POST /api/helpdesk/admin/assignment/skills-preview   { skills: { language, skill_ids, fallback }, team_id?, min_role? }
//      → { agents: [{user_id, name}], text: "2 agents match today: …", unavailable: ["Marie is away"], by_language? }
// The rule editor's "N agents match today": who in the team the rule reaches (every team without one)
// has the skills and language and could take a ticket right now. Reads only.
// Helpdesk 1.19.2 (agent W2). automations.manage, like the rules.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest, idParam, matchPreview } from "@/lib/helpdesk/skills/routes";
import { validateSkillCriteria } from "@/lib/helpdesk/skills/shared";
import { HD_MIN_ROLES } from "@/lib/helpdesk/assignment/shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 8 * 1024);
  if (!body) return badRequest("Send the criteria as JSON.");
  const c = validateSkillCriteria(body.skills);
  if (!c.ok) return badRequest(c.error);
  const teamId = body.team_id === undefined || body.team_id === null || body.team_id === "" ? null : idParam(String(body.team_id));
  if (body.team_id && !teamId) return badRequest("team_id must be a team's id.");
  const minRole = (HD_MIN_ROLES as readonly unknown[]).includes(body.min_role) ? (body.min_role as string) : null;
  return NextResponse.json(await matchPreview(c.value, teamId, minRole));
}
