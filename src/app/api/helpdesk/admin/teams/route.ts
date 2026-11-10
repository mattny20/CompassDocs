// GET  /api/helpdesk/admin/teams   every team with its members → { teams }. 1.20.2 (additive, for the Teams
//        list): each team also carries open_tickets (live, not solved or closed) and mailbox_address
//        (the first help address mapped to it, lib/helpdesk/mailboxes; null when none).
// POST /api/helpdesk/admin/teams   { name, description?, icon?, email_alias?, position?, members?: [{user_id, role}] }
//        → 201 { team }   audited (helpdesk.team.created)
// Helpdesk 1.19.0 (desk capability teams.manage). Members' team roles follow
// their desk role when they have one assigned (lib/helpdesk/roles teamRoleFor).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hq } from "@/lib/helpdesk/db-core";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { createTeam, listTeamsWithMembers, setTeamMembers, validateTeamInput } from "@/lib/helpdesk/teams";
import type { TeamInput } from "@/lib/helpdesk/teams";
import { parseMembers, withDeskRoles } from "@/lib/helpdesk/teams";
import { markSetupSteps } from "@/lib/helpdesk/settings";
import { badRequest } from "@/lib/helpdesk/routes";
import { invalidateCalendarCache } from "@/lib/helpdesk/calendars";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("teams.manage");
  if (gate instanceof NextResponse) return gate;
  const [teams, open, boxes] = await Promise.all([
    listTeamsWithMembers(),
    hq<{ team_id: number; n: number }>(
      "SELECT team_id, count(*)::int AS n FROM hd_tickets WHERE team_id IS NOT NULL AND deleted_at IS NULL AND status NOT IN ('solved', 'closed') GROUP BY team_id"
    ),
    import("@/lib/helpdesk/mailboxes").then((m) => m.mailboxAddressByTeam()).catch(() => new Map<number, string>()),
  ]);
  const openBy = new Map(open.map((r) => [r.team_id, r.n]));
  return NextResponse.json({ teams: teams.map((t) => ({ ...t, open_tickets: openBy.get(t.id) ?? 0, mailbox_address: boxes.get(t.id) ?? null })) });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("teams.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return badRequest("Send the team as JSON.");
  const v = validateTeamInput(b);
  if (!v.ok) return badRequest(v.error);
  const members = b.members === undefined ? null : parseMembers(b.members);
  if (b.members !== undefined && !members) return badRequest("Members are [{ user_id, role: 'agent'|'lead' }].");
  let team;
  try {
    team = await createTeam(v.value as TeamInput);
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Could not create the team.");
  }
  if (!team) return NextResponse.json({ error: "A team with that name already exists." }, { status: 409 });
  invalidateCalendarCache();
  const m = members ? await setTeamMembers(team.id, await withDeskRoles(members)) : null;
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.team.created",
    targetType: "helpdesk_team",
    targetId: team.id,
    targetLabel: team.name,
    details: { members: m?.added ?? [] },
    ip: ipFrom(req),
  });
  await markSetupSteps(["teams"], true);
  return NextResponse.json({ team: { ...team, members: m?.members ?? [] } }, { status: 201 });
}
