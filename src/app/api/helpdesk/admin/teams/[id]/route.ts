// PATCH  /api/helpdesk/admin/teams/[id]   { name?, description?, icon?, email_alias?, position? } → { team }
// DELETE /api/helpdesk/admin/teams/[id]   its members go; its tickets and request types keep their history (team NULL)
// Helpdesk 1.19.0 (desk capability teams.manage). Audited (helpdesk.team.updated / .deleted).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { deleteTeam, getTeam, updateTeam, validateTeamInput } from "@/lib/helpdesk/teams";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { invalidateCalendarCache } from "@/lib/helpdesk/calendars";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("teams.manage");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  const before = Number.isInteger(id) ? await getTeam(id) : undefined;
  if (!before) return notFound();
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the changes as JSON.");
  const v = validateTeamInput(b, true);
  if (!v.ok) return badRequest(v.error);
  const team = await updateTeam(id, v.value);
  if (team === undefined) return notFound();
  if (team === null) return NextResponse.json({ error: "A team with that name already exists." }, { status: 409 });
  const changed = (Object.keys(v.value) as (keyof typeof v.value)[]).filter((k) => before[k] !== team[k]);
  if (changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.team.updated",
      targetType: "helpdesk_team",
      targetId: id,
      targetLabel: team.name,
      details: { changed, ...(changed.includes("name") ? { from: before.name } : {}) },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ team });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("teams.manage");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  const team = Number.isInteger(id) ? await deleteTeam(id) : undefined;
  if (!team) return notFound();
  invalidateCalendarCache();
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.team.deleted",
    targetType: "helpdesk_team",
    targetId: id,
    targetLabel: team.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
