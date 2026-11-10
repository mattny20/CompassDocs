// PATCH  /api/helpdesk/admin/agents/[userId]  { role?, team_ids? } → { agent }
//   Change someone's desk role and/or teams. A role for someone not yet on
//   the desk adds them: 402 { error, code: "agent_limit", allowed, used }
//   when the licence's agent allowance is used up (audited as
//   helpdesk.agent_role.refused_limit). A change for someone already on it
//   is never refused for the allowance.
// DELETE /api/helpdesk/admin/agents/[userId] → { removed_team_ids, role_removed, still_on_desk }
//   Take them off the desk (a Team lead: out of the lead's own teams).
// Helpdesk 1.19.0 desk roles (agent J). agents.assign_roles, or
// agents.manage_team within the caller's own teams; teams.manage may change
// teams only.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import { AgentLimitError, auditAgentLimit, DeskRoleError, removeDeskAgent, setDeskAgent } from "@/lib/helpdesk/roles-agents";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ userId: string }> };

function fail(e: unknown): NextResponse {
  if (e instanceof AgentLimitError) return NextResponse.json(e.body(), { status: e.status });
  if (e instanceof DeskRoleError) return NextResponse.json({ error: e.message }, { status: e.status });
  throw e;
}

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(["agents.assign_roles", "agents.manage_team", "teams.manage"]);
  if (gate instanceof NextResponse) return gate;
  const userId = Number((await params).userId);
  const b = await readJson(req, 16 * 1024);
  if (!b) return NextResponse.json({ error: "Send the change as JSON." }, { status: 400 });
  if (b.role !== undefined && !(await hdCan(gate, "agents.assign_roles")) && !(await hdCan(gate, "agents.manage_team"))) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  try {
    const change = await setDeskAgent(gate, { user_id: userId, role: b.role, team_ids: b.team_ids });
    const roleChanged = change.before.role !== change.after?.role || change.before.source !== change.after?.source;
    await audit({
      actor: actorFrom(gate),
      action: change.created ? "helpdesk.agent_role.assigned" : "helpdesk.agent_role.changed",
      targetType: "user",
      targetId: userId,
      targetLabel: change.after?.name ?? null,
      details: {
        before: change.before,
        role: change.after?.role ?? null,
        role_changed: roleChanged,
        team_ids: change.after?.team_ids ?? [],
      },
      ip: ipFrom(req),
    });
    return NextResponse.json({ agent: change.after });
  } catch (e) {
    if (e instanceof AgentLimitError) await auditAgentLimit(gate, e, { user_id: userId, role: b.role }, ipFrom(req));
    return fail(e);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(["agents.assign_roles", "agents.manage_team"]);
  if (gate instanceof NextResponse) return gate;
  const userId = Number((await params).userId);
  try {
    const r = await removeDeskAgent(gate, userId);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.agent_role.removed",
      targetType: "user",
      targetId: userId,
      targetLabel: null,
      details: { before: r.before, removed_team_ids: r.removed_team_ids, role_removed: r.role_removed, still_on_desk: Boolean(r.still_on_desk) },
      ip: ipFrom(req),
    });
    return NextResponse.json(r);
  } catch (e) {
    return fail(e);
  }
}
