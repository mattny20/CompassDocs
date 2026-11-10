// GET  /api/helpdesk/admin/agents
//        → { agents, teams, me, counts, allowed, licensed, enforced, used, over, buy_url }
//   Everyone on the desk with their role, teams and availability, plus
//   whether the caller may change each row (manageable). The licence's
//   agent allowance: allowed is the one in force (null = nothing enforced:
//   no limit on the key, or in grace), licensed the key's own number (null
//   = unlimited; the meter shows this), enforced whether adds past it are
//   refused, used how many count (everyone listed), over how far past the
//   key's number the desk is (0 when within it, in grace too); buy_url is
//   where more agents are bought.
// POST /api/helpdesk/admin/agents   { user_id, role, team_ids? } → 201 { agent }
//   Put someone on the desk at a role (Settings → Agents → Add agent).
//   402 { error, code: "agent_limit", allowed, used } when the allowance is
//   used up (audited as helpdesk.agent_role.refused_limit).
// Helpdesk 1.19.0 desk roles (agent J). Needs agents.assign_roles, or
// agents.manage_team for the caller's own teams (Newbie and Agent only).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { BUY_AGENTS_URL } from "@/lib/license";
import { readJson } from "@/lib/helpdesk/access";
import { hdAnyCapGate, hdCapsFor } from "@/lib/helpdesk/roles";
import {
  AgentLimitError,
  agentUsage,
  auditAgentLimit,
  DeskRoleError,
  listDeskAgents,
  rowManageable,
  setDeskAgent,
} from "@/lib/helpdesk/roles-agents";
import { HD_ROLES } from "@/lib/helpdesk/roles-shared";
import { listTeams } from "@/lib/helpdesk/teams";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdAnyCapGate(["agents.assign_roles", "agents.manage_team", "teams.manage"]);
  if (gate instanceof NextResponse) return gate;
  const [agents, teams, me] = await Promise.all([listDeskAgents(), listTeams(), hdCapsFor(gate)]);
  const counts = Object.fromEntries(HD_ROLES.map((r) => [r, agents.filter((a) => a.role === r).length]));
  const usage = await agentUsage(agents.length);
  return NextResponse.json({
    agents: agents.map((a) => ({ ...a, manageable: rowManageable(gate.id, me, a) })),
    teams: teams.map((t) => ({ id: t.id, name: t.name, icon: t.icon })),
    me,
    counts,
    ...usage,
    buy_url: BUY_AGENTS_URL,
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
    if (e instanceof AgentLimitError) {
      await auditAgentLimit(gate, e, { user_id: Number(b.user_id), role: b.role }, ipFrom(req));
      return NextResponse.json(e.body(), { status: e.status });
    }
    if (e instanceof DeskRoleError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
