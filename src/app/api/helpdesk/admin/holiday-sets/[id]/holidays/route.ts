// POST /api/helpdesk/admin/holiday-sets/[id]/holidays
//        { holidays: [{ date, name, recurring_yearly?, closed_from?, closed_to? }] } or { text: pasted lines }
//        → { added, duplicates, errors, retimed }   (bulk; same date + name is skipped)
// Helpdesk 1.19.0, agent L (sla.manage). Audited (helpdesk.holiday_set.updated, details.added).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { addHolidays, getHolidaySet } from "@/lib/helpdesk/calendars";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarErrorResponse, calendarGate, idOf } from "../../../calendars/helpers";
import { holidaysFromBody } from "../../holidays-body";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  const set = id ? await getHolidaySet(id) : undefined;
  if (!id || !set) return notFound();
  const b = await readJson(req, 256 * 1024);
  if (!b) return badRequest("Send the holidays as JSON.");
  const h = holidaysFromBody(b);
  if (!h.ok) return badRequest(h.error);
  try {
    const r = await addHolidays(id, h.holidays);
    if (!r) return notFound();
    if (r.added.length) {
      await auditCalendar(req, gate, "helpdesk.holiday_set.updated", { type: "helpdesk_holiday_set", id, label: set.name }, {
        added: r.added.slice(0, 50).map((x) => `${x.date} ${x.name}`),
        added_count: r.added.length,
        retimed: r.retimed,
      });
    }
    return NextResponse.json({ added: r.added, duplicates: r.duplicates, errors: h.errors, retimed: r.retimed });
  } catch (e) {
    return calendarErrorResponse(e);
  }
}
