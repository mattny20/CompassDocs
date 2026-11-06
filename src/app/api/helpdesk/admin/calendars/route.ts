// GET  /api/helpdesk/admin/calendars   → { calendars, holiday_sets, teams, default_id }
//        each calendar with its open-hours summary ("Mon–Fri 09:00–17:30")
// POST /api/helpdesk/admin/calendars   { name, timezone, schedule, holiday_set_ids? } → 201 { calendar }
//        audited (helpdesk.calendar.created)
// Helpdesk 1.19.0, agent L (desk capability sla.manage).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { createCalendar, listCalendarTeams, listCalendars, listHolidaySets } from "@/lib/helpdesk/calendars";
import { summarizeSchedule, validateCalendarInput } from "@/lib/helpdesk/calendars-shared";
import type { HdCalendarInput } from "@/lib/helpdesk/calendars-shared";
import { badRequest } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarErrorResponse, calendarGate } from "./helpers";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const [calendars, holiday_sets, teams] = await Promise.all([listCalendars(), listHolidaySets(), listCalendarTeams()]);
  return NextResponse.json({
    calendars: calendars.map((c) => ({ ...c, summary: summarizeSchedule(c.schedule) })),
    holiday_sets,
    teams,
    default_id: calendars.find((c) => c.is_default)?.id ?? null,
  });
}

export async function POST(req: Request) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 32 * 1024);
  if (!b) return badRequest("Send the calendar as JSON.");
  const v = validateCalendarInput(b);
  if (!v.ok) return badRequest(v.error);
  try {
    const calendar = await createCalendar(v.value as HdCalendarInput);
    await auditCalendar(req, gate, "helpdesk.calendar.created", { type: "helpdesk_calendar", id: calendar.id, label: calendar.name }, {
      timezone: calendar.timezone,
      hours: summarizeSchedule(calendar.schedule),
      holiday_set_ids: calendar.holiday_set_ids,
    });
    return NextResponse.json({ calendar: { ...calendar, summary: summarizeSchedule(calendar.schedule) } }, { status: 201 });
  } catch (e) {
    return calendarErrorResponse(e);
  }
}
