// GET  /api/helpdesk/admin/agents   → { agents, teams, me, counts }
//   Everyone on the desk with their role, teams and availability, plus
//   whether the caller may change each row (manageable).
// POST /api/helpdesk/admin/agents   { user_id, role, team_ids? } → 201 { agent }
//   Put someone on the desk at a role (Settings → Agents → Add agent).
// Helpdesk 1.19.0 desk roles (agent J). Needs agents.assign_roles, or
// agents.manage_team for the caller's own teams (Newbie and Agent only).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdAnyCapGate, hdCapsFor } from "@/lib/helpdesk/roles";
import { DeskRoleError, listDeskAgents, rowManageable, setDeskAgent } from "@/lib/helpdesk/roles-agents";
import { HD_ROLES } from "@/lib/helpdesk/roles-shared";
import { listTeams } from "@/lib/helpdesk/teams";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdAnyCapGate(["agents.assign_roles", "agents.manage_team", "teams.manage"]);
  if (gate instanceof NextResponse) return gate;
  const [agents, teams, me] = await Promise.all([listDeskAgents(), listTeams(), hdCapsFor(gate)]);
  const counts = Object.fromEntries(HD_ROLES.map((r) => [r, agents.filter((a) => a.role === r).length]));
  return NextResponse.json({
    agents: agents.map((a) => ({ ...a, manageable: rowManageable(gate.id, me, a) })),
    teams: teams.map((t) => ({ id: t.id, name: t.name, icon: t.icon })),
    me,
    counts,
  });
}

export async function POST(req: Request) {
  const gate = await hdAnyCapGate(["agents.assign_roles", "agents.manage_team"]);
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 16 * 1024);
  if (!b) return NextResponse.json({ error: "Send the agent as JSON." }, { status: 400 });
  if (b.role === undefined) return NextResponse.json({ error: "Choose a desk role." }, { status: 400 });
  try {
    const change = await setDeskAgent(gate, { user_id: b.user_id, role: b.role, team_ids: b.team_ids }, { requireNew: true });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.agent_role.assigned",
      targetType: "user",
      targetId: change.after?.user_id ?? Number(b.user_id),
      targetLabel: change.after?.name ?? null,
      details: { role: change.after?.role, before: change.before, team_ids: change.after?.team_ids ?? [] },
      ip: ipFrom(req),
    });
    return NextResponse.json({ agent: change.after }, { status: 201 });
  } catch (e) {
    if (e instanceof DeskRoleError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
