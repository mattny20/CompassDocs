// GET /api/helpdesk/team-status/teams/[id]   → { team, services: TeamStatusSettingsRow[] }
//       every Status page service with the team's choice (followed, pop-up level).
// PUT /api/helpdesk/team-status/teams/[id]   { services: [{ service_id, popup_level }] }
//       → { services, changed }. Replaces the team's followed services.
//       popup_level: "degraded" (outage and degraded), "outage" or "off".
//       teams.manage, or agents.manage_team in this team (its lead).
//       Audited (helpdesk.team_status.services_changed).
// Helpdesk 1.19.2 (agent W6, lib/helpdesk/status-teams).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { hqOne } from "@/lib/helpdesk/db-core";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import {
  canManageTeamStatus,
  saveTeamStatusServices,
  StatusTeamsError,
  teamStatusSettings,
  validateTeamServices,
} from "@/lib/helpdesk/status-teams";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function teamOf(raw: string): Promise<{ id: number; name: string } | null> {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return (await hqOne<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE id = $1", [id])) ?? null;
}

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const team = await teamOf((await params).id);
  if (!team) return notFound();
  if (!(await canManageTeamStatus(gate, team.id))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  return NextResponse.json({ team, services: await teamStatusSettings(team.id) });
}

export async function PUT(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const team = await teamOf((await params).id);
  if (!team) return notFound();
  if (!(await canManageTeamStatus(gate, team.id))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  if (hdRateLimited(`hd-team-status-save:${gate.id}`, 30, 60_000)) return tooMany();
  const b = await readJson(req, 32 * 1024);
  if (!b) return badRequest("Send the services as JSON.");
  let items;
  try {
    items = validateTeamServices(b);
  } catch (e) {
    return badRequest((e as Error).message);
  }
  try {
    const changed = await saveTeamStatusServices(gate, team.id, items);
    if (changed.added.length || changed.removed.length || changed.changed.length) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.team_status.services_changed",
        targetType: "helpdesk_team",
        targetId: team.id,
        targetLabel: team.name,
        details: { team: team.name, added: changed.added, removed: changed.removed, changed: changed.changed },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ services: await teamStatusSettings(team.id), changed });
  } catch (e) {
    if (e instanceof StatusTeamsError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
