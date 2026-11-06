// GET    /api/helpdesk/admin/calendars/[id]   → { calendar }
// PATCH  /api/helpdesk/admin/calendars/[id]   { name?, timezone?, schedule?, holiday_set_ids? } → { calendar, retimed }
//          re-times the open, running tickets of the teams on it (retimed = how many moved)
// DELETE /api/helpdesk/admin/calendars/[id]   never the default; its teams fall back to the default
// Helpdesk 1.19.0, agent L (sla.manage). Audited (helpdesk.calendar.updated / .deleted).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { deleteCalendar, getCalendar, updateCalendar } from "@/lib/helpdesk/calendars";
import { summarizeSchedule, validateCalendarInput } from "@/lib/helpdesk/calendars-shared";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarErrorResponse, calendarGate, idOf } from "../helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  const calendar = id ? await getCalendar(id) : undefined;
  if (!calendar) return notFound();
  return NextResponse.json({ calendar: { ...calendar, summary: summarizeSchedule(calendar.schedule) } });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  const before = id ? await getCalendar(id) : undefined;
  if (!id || !before) return notFound();
  const b = await readJson(req, 32 * 1024);
  if (!b) return badRequest("Send the changes as JSON.");
  const v = validateCalendarInput(b, true);
  if (!v.ok) return badRequest(v.error);
  try {
    const r = await updateCalendar(id, v.value);
    if (!r) return notFound();
    const after = r.calendar;
    const changed: string[] = [];
    if (after.name !== before.name) changed.push("name");
    if (after.timezone !== before.timezone) changed.push("timezone");
    if (JSON.stringify(after.schedule) !== JSON.stringify(before.schedule)) changed.push("schedule");
    if (JSON.stringify([...after.holiday_set_ids].sort()) !== JSON.stringify([...before.holiday_set_ids].sort())) changed.push("holiday_sets");
    if (changed.length) {
      await auditCalendar(req, gate, "helpdesk.calendar.updated", { type: "helpdesk_calendar", id, label: after.name }, {
        changed,
        ...(changed.includes("name") ? { from: before.name } : {}),
        ...(changed.includes("timezone") ? { timezone: { from: before.timezone, to: after.timezone } } : {}),
        ...(changed.includes("schedule") ? { hours: { from: summarizeSchedule(before.schedule), to: summarizeSchedule(after.schedule) } } : {}),
        ...(changed.includes("holiday_sets") ? { holiday_set_ids: { from: before.holiday_set_ids, to: after.holiday_set_ids } } : {}),
        retimed: r.retimed,
      });
    }
    return NextResponse.json({ calendar: { ...after, summary: summarizeSchedule(after.schedule) }, retimed: r.retimed });
  } catch (e) {
    return calendarErrorResponse(e);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  try {
    const r = await deleteCalendar(id);
    if (!r) return notFound();
    await auditCalendar(req, gate, "helpdesk.calendar.deleted", { type: "helpdesk_calendar", id, label: r.calendar.name }, {
      teams_moved_to_default: r.calendar.team_ids,
      retimed: r.retimed,
    });
    return NextResponse.json({ ok: true, retimed: r.retimed });
  } catch (e) {
    return calendarErrorResponse(e);
  }
}
