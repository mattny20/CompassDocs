// GET  /api/helpdesk/admin/recurring   the schedules the caller manages, the teams they may schedule for
//                                       (with each team calendar's zone), the request types, can_manage_all.
// POST /api/helpdesk/admin/recurring   create a schedule → { schedule }. Audited helpdesk.recurring.created.
// Helpdesk 1.19.1 (agent V8). settings.manage (every team) or agents.manage_team (a lead, their teams).

import { NextResponse } from "next/server";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import { hq } from "@/lib/helpdesk/db-core";
import {
  auditRecurring,
  canManageAllRecurring,
  canManageRecurringTeam,
  createRecurring,
  listRecurring,
  recurringTeams,
  validateRecurringInput,
} from "@/lib/helpdesk/recurring";
import { RECURRING_LIMITS, scheduleTitle } from "@/lib/helpdesk/recurring-shared";

export const dynamic = "force-dynamic";

const GATE = ["settings.manage", "agents.manage_team"] as const;

export async function GET() {
  const gate = await hdAnyCapGate([...GATE]);
  if (gate instanceof NextResponse) return gate;
  const [all, teams] = await Promise.all([canManageAllRecurring(gate), recurringTeams(gate)]);
  const [schedules, requestTypes] = await Promise.all([
    listRecurring(all ? "all" : teams.map((t) => t.id)),
    hq<{ id: number; title: string; team_id: number | null }>("SELECT id, title, team_id FROM hd_request_types ORDER BY position, title"),
  ]);
  return NextResponse.json({ schedules, teams, request_types: requestTypes, can_manage_all: all });
}

export async function POST(req: Request) {
  const gate = await hdAnyCapGate([...GATE]);
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the schedule as JSON." }, { status: 400 });
  if (typeof body.team_id === "number" && !(await canManageRecurringTeam(gate, body.team_id))) {
    return NextResponse.json({ error: "You can only schedule tickets for teams you lead." }, { status: 403 });
  }
  const v = await validateRecurringInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const count = await hq<{ n: number }>("SELECT count(*)::int AS n FROM hd_recurring WHERE team_id = $1", [v.value.team_id]);
  if ((count[0]?.n ?? 0) >= RECURRING_LIMITS.perTeam) {
    return NextResponse.json({ error: `A team can have at most ${RECURRING_LIMITS.perTeam} recurring tickets.` }, { status: 400 });
  }
  const schedule = await createRecurring(v.value, gate.id);
  await auditRecurring(req, gate, "helpdesk.recurring.created", schedule.id, scheduleTitle(schedule.subject), {
    team_id: schedule.team_id,
    pattern: schedule.pattern,
  });
  return NextResponse.json({ schedule }, { status: 201 });
}
