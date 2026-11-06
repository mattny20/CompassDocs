// PUT /api/helpdesk/admin/skills/agents/[userId]   { skill_ids, languages } → { tags }
//     Replace one agent's skills and languages. teams.manage, or a lead (agents.manage_team) for the
//     people J's Agents page lets them change (rowManageable: in their teams, below their rank, not
//     themselves, not a workspace Admin). The person must be on the desk.
// Helpdesk 1.19.2 (agent W2). Audited as helpdesk.skills.agent_updated (what was added and removed).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import { getDeskAgent } from "@/lib/helpdesk/roles-agents";
import { auditSkills, badRequest, canTagAgent, idParam, notFound, skillsErrorResponse } from "@/lib/helpdesk/skills/routes";
import { setAgentTags } from "@/lib/helpdesk/skills/store";
import { HD_FORBIDDEN, hdCapsFor } from "@/lib/helpdesk/roles";
import { validateAgentTags } from "@/lib/helpdesk/skills/shared";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  const gate = await hdAnyCapGate(["agents.manage_team", "teams.manage"]);
  if (gate instanceof NextResponse) return gate;
  const userId = idParam((await ctx.params).userId);
  const agent = userId ? await getDeskAgent(userId) : undefined;
  if (!userId || !agent) return notFound();
  if (!canTagAgent(gate.id, await hdCapsFor(gate), agent)) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const body = await readJson(req, 16 * 1024);
  if (!body) return badRequest("Send the skills and languages as JSON.");
  const checked = validateAgentTags(body);
  if (!checked.ok) return badRequest(checked.error);
  try {
    const { before, after } = await setAgentTags(userId, checked.value);
    const diff = <T,>(a: T[], b: T[]) => a.filter((x) => !b.includes(x));
    const changes = {
      skills_added: diff(after.skill_ids, before.skill_ids),
      skills_removed: diff(before.skill_ids, after.skill_ids),
      languages_added: diff(after.languages, before.languages),
      languages_removed: diff(before.languages, after.languages),
    };
    if (Object.values(changes).some((l) => l.length)) {
      await auditSkills(req, gate, "helpdesk.skills.agent_updated", { type: "user", id: userId, label: agent.name }, changes);
    }
    return NextResponse.json({ tags: after });
  } catch (e) {
    const r = skillsErrorResponse(e);
    if (r) return r;
    throw e;
  }
}
