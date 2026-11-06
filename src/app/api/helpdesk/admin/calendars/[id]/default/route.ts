// POST /api/helpdesk/admin/calendars/[id]/default   make it the default calendar → { calendar, retimed }
//        (teams without a calendar and tickets without a team move to it)
// Helpdesk 1.19.0, agent L (sla.manage). Audited (helpdesk.calendar.updated, changed: ["default"]).

import { NextResponse } from "next/server";
import { setDefaultCalendar } from "@/lib/helpdesk/calendars";
import { notFound } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarGate, idOf } from "../../helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  const r = id ? await setDefaultCalendar(id) : undefined;
  if (!id || !r) return notFound();
  if (r.previous?.id !== id) {
    await auditCalendar(req, gate, "helpdesk.calendar.updated", { type: "helpdesk_calendar", id, label: r.calendar.name }, {
      changed: ["default"],
      previous_default: r.previous ? { id: r.previous.id, name: r.previous.name } : null,
      retimed: r.retimed,
    });
  }
  return NextResponse.json({ calendar: r.calendar, retimed: r.retimed });
}
