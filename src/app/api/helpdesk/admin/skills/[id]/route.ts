// PATCH  /api/helpdesk/admin/skills/[id]   { name }   rename a skill
// DELETE /api/helpdesk/admin/skills/[id]             remove it from the workspace and every agent;
//        refused (409) while an assignment rule needs it.
// Helpdesk 1.19.2 (agent W2). teams.manage. Audited as helpdesk.skills.skill_renamed / skill_deleted.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { auditSkills, badRequest, idParam, notFound, skillsErrorResponse } from "@/lib/helpdesk/skills/routes";
import { deleteSkill, renameSkill } from "@/lib/helpdesk/skills/store";
import { validateSkillName } from "@/lib/helpdesk/skills/shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("teams.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idParam((await ctx.params).id);
  if (!id) return notFound();
  const body = await readJson(req, 4 * 1024);
  if (!body) return badRequest("Send the new name as JSON.");
  const name = validateSkillName(body.name);
  if (!name.ok) return badRequest(name.error);
  try {
    const row = await renameSkill(id, name.value);
    if (!row) return notFound();
    if (row.before !== row.name) {
      await auditSkills(req, gate, "helpdesk.skills.skill_renamed", { type: "helpdesk_skill", id, label: row.name }, { from: row.before, to: row.name });
    }
    return NextResponse.json({ skill: { id: row.id, name: row.name } });
  } catch (e) {
    const r = skillsErrorResponse(e);
    if (r) return r;
    throw e;
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("teams.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idParam((await ctx.params).id);
  if (!id) return notFound();
  try {
    const gone = await deleteSkill(id);
    if (!gone) return notFound();
    await auditSkills(req, gate, "helpdesk.skills.skill_deleted", { type: "helpdesk_skill", id, label: gone.name }, { name: gone.name, agents: gone.agents });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const r = skillsErrorResponse(e);
    if (r) return r;
    throw e;
  }
}
