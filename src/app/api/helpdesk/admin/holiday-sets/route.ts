// GET  /api/helpdesk/admin/holiday-sets   → { holiday_sets }
// POST /api/helpdesk/admin/holiday-sets   { name, description?, holidays?: [...] | text?: "2026-12-25 Christmas Day\n…" }
//        → 201 { holiday_set } audited (helpdesk.holiday_set.created)
// Helpdesk 1.19.0, agent L (sla.manage).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { createHolidaySet, listHolidaySets } from "@/lib/helpdesk/calendars";
import { validateHolidaySetInput } from "@/lib/helpdesk/calendars-shared";
import { badRequest } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarErrorResponse, calendarGate } from "../calendars/helpers";
import { holidaysFromBody } from "./holidays-body";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ holiday_sets: await listHolidaySets() });
}

export async function POST(req: Request) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 256 * 1024);
  if (!b) return badRequest("Send the holiday set as JSON.");
  const v = validateHolidaySetInput(b);
  if (!v.ok) return badRequest(v.error);
  const h = b.holidays === undefined && b.text === undefined ? { ok: true as const, holidays: [], errors: [] } : holidaysFromBody(b);
  if (!h.ok) return badRequest(h.error);
  try {
    const set = await createHolidaySet({ name: v.value.name!, description: v.value.description, holidays: h.holidays });
    await auditCalendar(req, gate, "helpdesk.holiday_set.created", { type: "helpdesk_holiday_set", id: set.id, label: set.name }, { holidays: set.holidays.length });
    return NextResponse.json({ holiday_set: set, errors: h.errors }, { status: 201 });
  } catch (e) {
    return calendarErrorResponse(e);
  }
}
