// GET /api/helpdesk/admin/teams/[id]/members   → { members }
// PUT /api/helpdesk/admin/teams/[id]/members   { members: [{ user_id, role: 'agent'|'lead' }] }
//       replaces the team's members → { members, added, removed }
//       audited (helpdesk.team.members_changed). Membership decides which
//       queues an agent works; the helpdesk.agent permission is granted
//       separately (the "Helpdesk agent" role).
// Helpdesk 1.19.0 (desk capability agents.manage_team, in this team). A
// member with an assigned desk role keeps the team role it implies
// (lib/helpdesk/roles teamRoleFor), whatever the body says. Without
// teams.manage (a Team lead) the change is held to the Agents page's rules
// (roles-agents planTeamMembers): only Newbies and Agents come and go, and
// nobody's lead flag changes.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { DeskRoleError, planTeamMembers } from "@/lib/helpdesk/roles-agents";
import { getTeam, listTeamMembers, parseMembers, setTeamMembers } from "@/lib/helpdesk/teams";
import { badRequest, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const id = Number((await params).id);
  const gate = await hdCapGate("agents.manage_team", { teamId: Number.isInteger(id) ? id : null });
  if (gate instanceof NextResponse) return gate;
  if (!Number.isInteger(id) || !(await getTeam(id))) return notFound();
  return NextResponse.json({ members: await listTeamMembers(id) });
}

export async function PUT(req: Request, { params }: Ctx) {
  const id = Number((await params).id);
  const gate = await hdCapGate("agents.manage_team", { teamId: Number.isInteger(id) ? id : null });
  if (gate instanceof NextResponse) return gate;
  const team = Number.isInteger(id) ? await getTeam(id) : undefined;
  if (!team) return notFound();
  const b = await readJson(req, 64 * 1024);
  const members = b ? parseMembers(b.members) : null;
  if (!members) return badRequest("Members are [{ user_id, role: 'agent'|'lead' }].");
  let planned;
  try {
    planned = await planTeamMembers(gate, id, members);
  } catch (e) {
    if (e instanceof DeskRoleError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  let r;
  try {
    r = await setTeamMembers(id, planned.members, { expectBefore: planned.expectBefore });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Could not save the members.");
  }
  if (r.added.length || r.removed.length || members.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.team.members_changed",
      targetType: "helpdesk_team",
      targetId: id,
      targetLabel: team.name,
      details: { added: r.added, removed: r.removed, leads: planned.members.filter((m) => m.role === "lead").map((m) => m.user_id) },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json(r);
}
