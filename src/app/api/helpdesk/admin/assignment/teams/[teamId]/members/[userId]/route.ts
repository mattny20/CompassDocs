// PATCH /api/helpdesk/admin/assignment/teams/[teamId]/members/[userId]   { weight?: 1–10, paused?: 0|1 }
// Helpdesk 1.19.0 (agent N). agents.manage_team in that team; the person must be a member.
// Audited as helpdesk.assignment.member_paused (paused changed) or helpdesk.assignment.team_updated (weight).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { auditAssignment, badRequest, idParam, notFound, teamGate } from "@/lib/helpdesk/assignment/routes";
import { isMember, listMemberRows, setMember } from "@/lib/helpdesk/assignment/store";
import { validateMemberPatch } from "@/lib/helpdesk/assignment/shared";
import { teamAssignmentView } from "@/lib/helpdesk/assignment/engine";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ teamId: string; userId: string }> }) {
  const p = await ctx.params;
  const g = await teamGate(p.teamId);
  if (g instanceof NextResponse) return g;
  const userId = idParam(p.userId);
  if (!userId || !(await isMember(g.team.id, userId))) return notFound();
  const body = await readJson(req, 1024);
  if (!body) return badRequest("Send { weight } or { paused } as JSON.");
  const checked = validateMemberPatch(body);
  if (!checked.ok) return badRequest(checked.error);
  const before = (await listMemberRows(g.team.id)).find((m) => m.user_id === userId);
  await setMember(g.team.id, userId, checked.value);
  if (checked.value.paused !== undefined && before && before.paused !== checked.value.paused) {
    await auditAssignment(req, g.user, "helpdesk.assignment.member_paused", { type: "user", id: userId, label: before.name }, {
      team_id: g.team.id,
      team: g.team.name,
      paused: checked.value.paused === 1,
    });
  }
  if (checked.value.weight !== undefined && before && before.weight !== checked.value.weight) {
    await auditAssignment(req, g.user, "helpdesk.assignment.team_updated", { type: "helpdesk_team", id: g.team.id, label: g.team.name }, {
      member: { user_id: userId, name: before.name, weight: { from: before.weight, to: checked.value.weight } },
    });
  }
  return NextResponse.json({ team: g.team, ...(await teamAssignmentView(g.team.id)) });
}
