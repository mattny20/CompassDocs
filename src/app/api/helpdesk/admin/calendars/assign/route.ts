// PATCH /api/helpdesk/admin/calendars/assign   { team_id, calendar_id | null } → { team_id, calendar_id, retimed }
//         put a team on a calendar (null = the default); its open, running tickets are re-timed
// Helpdesk 1.19.0, agent L (sla.manage). Audited (helpdesk.team.calendar_changed).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { assignTeamCalendar, listCalendars } from "@/lib/helpdesk/calendars";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarErrorResponse, calendarGate, idOf } from "../helpers";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 4 * 1024);
  if (!b) return badRequest("Send { team_id, calendar_id } as JSON.");
  const teamId = idOf(String(b.team_id));
  if (!teamId) return badRequest("Which team? Send team_id.");
  if (b.calendar_id !== null && !idOf(String(b.calendar_id))) return badRequest("Send calendar_id, or null for the default calendar.");
  const calendarId = b.calendar_id === null ? null : Number(b.calendar_id);
  try {
    const r = await assignTeamCalendar(teamId, calendarId);
    if (!r) return notFound();
    if (r.from !== r.to) {
      const names = new Map((await listCalendars()).map((c) => [c.id, c.name]));
      const label = (id: number | null) => (id === null ? "Default calendar" : names.get(id) ?? `Calendar ${id}`);
      await auditCalendar(req, gate, "helpdesk.team.calendar_changed", { type: "helpdesk_team", id: teamId, label: r.team.name }, {
        from: { id: r.from, name: label(r.from) },
        to: { id: r.to, name: label(r.to) },
        retimed: r.retimed,
      });
    }
    return NextResponse.json({ team_id: teamId, calendar_id: r.to, retimed: r.retimed });
  } catch (e) {
    return calendarErrorResponse(e);
  }
}
