// GET /api/helpdesk/admin/assignment/teams/[teamId]   settings, members (weight, paused, open count,
//                                                     availability, why skipped) and the "Who's next" preview
// PUT /api/helpdesk/admin/assignment/teams/[teamId]   { mode?, eligible?, include_roles?, max_open_per_agent?,
//                                                     respect_shift?, sticky_requester?, reassign_when_away?,
//                                                     unanswered_minutes? } → the view
// Helpdesk 1.19.0 (agent N). agents.manage_team in that team. Audited as helpdesk.assignment.team_updated.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { auditAssignment, badRequest, teamGate } from "@/lib/helpdesk/assignment/routes";
import { getTeamAssignment, saveTeamAssignment } from "@/lib/helpdesk/assignment/store";
import { validateTeamAssignment } from "@/lib/helpdesk/assignment/shared";
import { teamAssignmentView } from "@/lib/helpdesk/assignment/engine";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ teamId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const g = await teamGate((await ctx.params).teamId);
  if (g instanceof NextResponse) return g;
  return NextResponse.json({ team: g.team, ...(await teamAssignmentView(g.team.id)) });
}

export async function PUT(req: Request, ctx: Ctx) {
  const g = await teamGate((await ctx.params).teamId);
  if (g instanceof NextResponse) return g;
  const body = await readJson(req, 8 * 1024);
  if (!body) return badRequest("Send the settings as JSON.");
  const before = await getTeamAssignment(g.team.id);
  const checked = validateTeamAssignment(body, before);
  if (!checked.ok) return badRequest(checked.error);
  const after = await saveTeamAssignment(checked.value, g.user.id);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ["mode", "eligible", "include_roles", "max_open_per_agent", "respect_shift", "sticky_requester", "reassign_when_away", "unanswered_minutes"] as const) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed[k] = { from: before[k], to: after[k] };
  }
  if (Object.keys(changed).length) {
    await auditAssignment(req, g.user, "helpdesk.assignment.team_updated", { type: "helpdesk_team", id: g.team.id, label: g.team.name }, { changed });
  }
  return NextResponse.json({ team: g.team, ...(await teamAssignmentView(g.team.id)) });
}
