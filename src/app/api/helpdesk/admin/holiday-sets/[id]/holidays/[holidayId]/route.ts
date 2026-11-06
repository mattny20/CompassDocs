// PATCH  /api/helpdesk/admin/holiday-sets/[id]/holidays/[holidayId]   { date, name, recurring_yearly?, closed_from?, closed_to? } → { holiday, retimed }
// DELETE /api/helpdesk/admin/holiday-sets/[id]/holidays/[holidayId]   → { ok, retimed }
// Helpdesk 1.19.0, agent L (sla.manage). Audited (helpdesk.holiday_set.updated).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { deleteHoliday, getHolidaySet, updateHoliday } from "@/lib/helpdesk/calendars";
import { validateHoliday } from "@/lib/helpdesk/calendars-shared";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarErrorResponse, calendarGate, idOf } from "../../../../calendars/helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; holidayId: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const p = await params;
  const id = idOf(p.id);
  const hid = idOf(p.holidayId);
  const set = id ? await getHolidaySet(id) : undefined;
  const before = set?.holidays.find((h) => h.id === hid);
  if (!id || !hid || !set || !before) return notFound();
  const b = await readJson(req, 4 * 1024);
  if (!b) return badRequest("Send the holiday as JSON.");
  const v = validateHoliday({ ...before, ...b });
  if (!v.ok) return badRequest(v.error);
  try {
    const r = await updateHoliday(id, hid, v.value);
    if (!r) return notFound();
    await auditCalendar(req, gate, "helpdesk.holiday_set.updated", { type: "helpdesk_holiday_set", id, label: set.name }, {
      updated: { from: `${before.date} ${before.name}`, to: `${r.holiday.date} ${r.holiday.name}` },
      retimed: r.retimed,
    });
    return NextResponse.json(r);
  } catch (e) {
    return calendarErrorResponse(e);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const p = await params;
  const id = idOf(p.id);
  const hid = idOf(p.holidayId);
  const set = id ? await getHolidaySet(id) : undefined;
  if (!id || !hid || !set) return notFound();
  const r = await deleteHoliday(id, hid);
  if (!r) return notFound();
  await auditCalendar(req, gate, "helpdesk.holiday_set.updated", { type: "helpdesk_holiday_set", id, label: set.name }, {
    removed: `${r.holiday.date} ${r.holiday.name}`,
    retimed: r.retimed,
  });
  return NextResponse.json({ ok: true, retimed: r.retimed });
}
