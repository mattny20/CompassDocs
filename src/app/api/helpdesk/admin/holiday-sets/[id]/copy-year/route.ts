// POST /api/helpdesk/admin/holiday-sets/[id]/copy-year   { from_year, to_year? (default from_year + 1) }
//        "Copy to next year": the one-off holidays of from_year again in to_year (same day and month)
//        → { added, duplicates, retimed }
// Helpdesk 1.19.0, agent L (sla.manage). Audited (helpdesk.holiday_set.updated, details.copied).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { copyHolidaysToYear, getHolidaySet } from "@/lib/helpdesk/calendars";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarErrorResponse, calendarGate, idOf } from "../../../calendars/helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  const set = id ? await getHolidaySet(id) : undefined;
  if (!id || !set) return notFound();
  const b = await readJson(req, 1024);
  const from = Number(b?.from_year);
  const to = b?.to_year === undefined ? from + 1 : Number(b.to_year);
  const ok = (y: number) => Number.isInteger(y) && y >= 1970 && y <= 2200;
  if (!ok(from) || !ok(to) || from === to) return badRequest("Give from_year (and to_year), different years.");
  try {
    const r = await copyHolidaysToYear(id, from, to);
    if (!r) return notFound();
    if (r.added.length) {
      await auditCalendar(req, gate, "helpdesk.holiday_set.updated", { type: "helpdesk_holiday_set", id, label: set.name }, {
        copied: { from_year: from, to_year: to, added: r.added.length },
        retimed: r.retimed,
      });
    }
    return NextResponse.json(r);
  } catch (e) {
    return calendarErrorResponse(e);
  }
}
