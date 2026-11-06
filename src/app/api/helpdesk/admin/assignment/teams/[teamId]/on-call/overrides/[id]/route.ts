// DELETE /api/helpdesk/admin/assignment/teams/[teamId]/on-call/overrides/[id]   remove one cover shift
// Helpdesk 1.19.0 (agent N). agents.manage_team in that team. Audited as helpdesk.assignment.on_call_updated.

import { NextResponse } from "next/server";
import { auditAssignment, idParam, notFound, teamGate } from "@/lib/helpdesk/assignment/routes";
import { deleteOverride } from "@/lib/helpdesk/assignment/store";
import { onCallView } from "@/lib/helpdesk/assignment/oncall";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, ctx: { params: Promise<{ teamId: string; id: string }> }) {
  const p = await ctx.params;
  const g = await teamGate(p.teamId);
  if (g instanceof NextResponse) return g;
  const id = idParam(p.id);
  const gone = id ? await deleteOverride(g.team.id, id) : undefined;
  if (!gone) return notFound();
  await auditAssignment(req, g.user, "helpdesk.assignment.on_call_updated", { type: "helpdesk_team", id: g.team.id, label: g.team.name }, {
    override_removed: { id: gone.id, user_id: gone.user_id, starts_at: gone.starts_at, ends_at: gone.ends_at },
  });
  return NextResponse.json({ team: g.team, ...(await onCallView(g.team.id)) });
}
