// POST /api/helpdesk/admin/recurring/preview   { team_id, pattern, holiday_rule, timezone? } → { items: [{ at, label, note }], timezone }
// The next three runs as the editor shows them, with the team calendar's holidays applied ("moved from
// Mon May 25, Spring bank holiday"). Writes nothing.
// Helpdesk 1.19.1 (agent V8). settings.manage, or agents.manage_team in that team.

import { NextResponse } from "next/server";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import { hoursForTeam } from "@/lib/helpdesk/calendars";
import { canManageRecurringTeam, previewRuns } from "@/lib/helpdesk/recurring";
import { isHolidayRule, validTimezone, validatePattern } from "@/lib/helpdesk/recurring-shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdAnyCapGate(["settings.manage", "agents.manage_team"]);
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const teamId = body?.team_id;
  if (typeof teamId !== "number" || !Number.isInteger(teamId) || !(await canManageRecurringTeam(gate, teamId))) {
    return NextResponse.json({ error: "Choose a team you manage." }, { status: 400 });
  }
  const p = validatePattern(body?.pattern);
  if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
  const rule = isHolidayRule(body?.holiday_rule) ? body.holiday_rule : "next_working_day";
  const tz = validTimezone(body?.timezone) ? body.timezone : (await hoursForTeam(teamId)).timezone;
  const items = await previewRuns({ team_id: teamId, pattern: p.value, holiday_rule: rule, timezone: tz });
  return NextResponse.json({ items, timezone: tz });
}
