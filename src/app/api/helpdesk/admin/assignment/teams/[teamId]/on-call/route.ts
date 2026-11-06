// GET    /api/helpdesk/admin/assignment/teams/[teamId]/on-call   rotation, upcoming cover, who's on call now,
//                                                                 the next 4 weeks (?days=1–56)
// PUT    /api/helpdesk/admin/assignment/teams/[teamId]/on-call   { user_ids, length_days, handover_time, timezone, starts_on }
// DELETE /api/helpdesk/admin/assignment/teams/[teamId]/on-call   remove the rotation (cover stays)
// Helpdesk 1.19.0 (agent N). agents.manage_team in that team; people on the rotation must be team members.
// Audited as helpdesk.assignment.on_call_updated.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { auditAssignment, badRequest, teamGate } from "@/lib/helpdesk/assignment/routes";
import { deleteRotation, getRotation, listMemberRows, saveRotation } from "@/lib/helpdesk/assignment/store";
import { validateRotation } from "@/lib/helpdesk/assignment/shared";
import { onCallView } from "@/lib/helpdesk/assignment/oncall";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ teamId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const g = await teamGate((await ctx.params).teamId);
  if (g instanceof NextResponse) return g;
  const d = Number(new URL(req.url).searchParams.get("days") ?? 28);
  const days = Number.isInteger(d) && d >= 1 && d <= 56 ? d : 28;
  return NextResponse.json({ team: g.team, ...(await onCallView(g.team.id, new Date(), days)) });
}

export async function PUT(req: Request, ctx: Ctx) {
  const g = await teamGate((await ctx.params).teamId);
  if (g instanceof NextResponse) return g;
  const body = await readJson(req, 8 * 1024);
  if (!body) return badRequest("Send the rotation as JSON.");
  const checked = validateRotation(body, g.team.id);
  if (!checked.ok) return badRequest(checked.error);
  const members = new Set((await listMemberRows(g.team.id)).map((m) => m.user_id));
  if (!checked.value.user_ids.every((id) => members.has(id))) return badRequest("Everyone on the rotation must be in the team.");
  const before = await getRotation(g.team.id);
  const after = await saveRotation(checked.value, g.user.id);
  await auditAssignment(req, g.user, "helpdesk.assignment.on_call_updated", { type: "helpdesk_team", id: g.team.id, label: g.team.name }, {
    rotation: { user_ids: after.user_ids, length_days: after.length_days, handover_time: after.handover_time, timezone: after.timezone, starts_on: after.starts_on },
    previous: before ? { user_ids: before.user_ids, length_days: before.length_days } : null,
  });
  return NextResponse.json({ team: g.team, ...(await onCallView(g.team.id)) });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await teamGate((await ctx.params).teamId);
  if (g instanceof NextResponse) return g;
  if (await deleteRotation(g.team.id)) {
    await auditAssignment(req, g.user, "helpdesk.assignment.on_call_updated", { type: "helpdesk_team", id: g.team.id, label: g.team.name }, { rotation: null });
  }
  return NextResponse.json({ team: g.team, ...(await onCallView(g.team.id)) });
}
