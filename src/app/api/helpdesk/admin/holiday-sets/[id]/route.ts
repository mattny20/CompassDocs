// GET    /api/helpdesk/admin/holiday-sets/[id]   → { holiday_set } (with its holidays)
// PATCH  /api/helpdesk/admin/holiday-sets/[id]   { name?, description? } → { holiday_set }
// DELETE /api/helpdesk/admin/holiday-sets/[id]   calendars observing it are re-timed
// Helpdesk 1.19.0, agent L (sla.manage). Audited (helpdesk.holiday_set.updated / .deleted).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { deleteHolidaySet, getHolidaySet, updateHolidaySet } from "@/lib/helpdesk/calendars";
import { validateHolidaySetInput } from "@/lib/helpdesk/calendars-shared";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarErrorResponse, calendarGate, idOf } from "../../calendars/helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  const set = id ? await getHolidaySet(id) : undefined;
  if (!set) return notFound();
  return NextResponse.json({ holiday_set: set });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  const before = id ? await getHolidaySet(id) : undefined;
  if (!id || !before) return notFound();
  const b = await readJson(req, 8 * 1024);
  if (!b) return badRequest("Send the changes as JSON.");
  const v = validateHolidaySetInput(b, true);
  if (!v.ok) return badRequest(v.error);
  try {
    const set = await updateHolidaySet(id, v.value);
    if (!set) return notFound();
    const changed = (["name", "description"] as const).filter((k) => before[k] !== set[k]);
    if (changed.length) {
      await auditCalendar(req, gate, "helpdesk.holiday_set.updated", { type: "helpdesk_holiday_set", id, label: set.name }, {
        changed,
        ...(changed.includes("name") ? { from: before.name } : {}),
      });
    }
    return NextResponse.json({ holiday_set: set });
  } catch (e) {
    return calendarErrorResponse(e);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  const r = id ? await deleteHolidaySet(id) : undefined;
  if (!id || !r) return notFound();
  await auditCalendar(req, gate, "helpdesk.holiday_set.deleted", { type: "helpdesk_holiday_set", id, label: r.set.name }, {
    holidays: r.set.holiday_count,
    calendar_ids: r.set.calendar_ids,
    retimed: r.retimed,
  });
  return NextResponse.json({ ok: true, retimed: r.retimed });
}
