// POST /api/helpdesk/admin/assignment/teams/[teamId]/on-call/overrides   { user_id, starts_at, ends_at } (ISO)
//      one-off cover: this person is on call instead of the rotation between those times
// Helpdesk 1.19.0 (agent N). agents.manage_team in that team; a team member; at most 31 days, ending in the future.
// Audited as helpdesk.assignment.on_call_updated.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { auditAssignment, badRequest, idParam, teamGate } from "@/lib/helpdesk/assignment/routes";
import { AssignmentLimitError, addOverride, isMember } from "@/lib/helpdesk/assignment/store";
import { onCallView } from "@/lib/helpdesk/assignment/oncall";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ teamId: string }> }) {
  const g = await teamGate((await ctx.params).teamId);
  if (g instanceof NextResponse) return g;
  const body = await readJson(req, 2048);
  if (!body) return badRequest("Send { user_id, starts_at, ends_at } as JSON.");
  const userId = idParam(String(body.user_id ?? ""));
  if (!userId || !(await isMember(g.team.id, userId))) return badRequest("Choose someone in the team.");
  const s = typeof body.starts_at === "string" ? Date.parse(body.starts_at) : NaN;
  const e = typeof body.ends_at === "string" ? Date.parse(body.ends_at) : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return badRequest("The cover needs a start and a later end.");
  if (e - s > 31 * 86_400_000) return badRequest("Cover lasts at most 31 days.");
  if (e <= Date.now()) return badRequest("The cover has already ended.");
  let shift;
  try {
    shift = await addOverride(g.team.id, userId, new Date(s), new Date(e), g.user.id);
  } catch (err) {
    if (err instanceof AssignmentLimitError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
  await auditAssignment(req, g.user, "helpdesk.assignment.on_call_updated", { type: "helpdesk_team", id: g.team.id, label: g.team.name }, {
    override_added: { id: shift.id, user_id: userId, starts_at: shift.starts_at, ends_at: shift.ends_at },
  });
  return NextResponse.json({ team: g.team, override: shift, ...(await onCallView(g.team.id)) }, { status: 201 });
}
