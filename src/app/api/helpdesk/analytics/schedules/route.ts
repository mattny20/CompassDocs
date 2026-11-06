// GET  /api/helpdesk/analytics/schedules[?dashboard=<id>] → { schedules: HdReportSchedule[] }
// POST /api/helpdesk/analytics/schedules { dashboard_id, recipients: { users, teams }, frequency,
//        weekday?, hour?, format?, enabled? } → 201 { schedule }; audited helpdesk.report_schedule.created
// Helpdesk 1.19.0 reports (agent K): any report capability; scheduling to
// others needs the dashboard's editors, reports.all or a Manager/Admin desk
// role (lib/helpdesk/analytics/schedules).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { createSchedule, listSchedules } from "@/lib/helpdesk/analytics/schedules";
import { NO_STORE, errorResponse, idParam, reportsGate } from "@/lib/helpdesk/analytics/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  const raw = new URL(req.url).searchParams.get("dashboard");
  const id = raw ? idParam(raw) : undefined;
  if (raw && !id) return NextResponse.json({ error: "Unknown dashboard." }, { status: 400 });
  try {
    return NextResponse.json({ schedules: await listSchedules(gate, id ?? undefined) }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 16 * 1024);
  if (!body) return NextResponse.json({ error: "Send the schedule as JSON." }, { status: 400 });
  try {
    const s = await createSchedule(gate, body);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.report_schedule.created",
      targetType: "helpdesk_report_schedule",
      targetId: s.id,
      targetLabel: s.dashboard_name,
      details: { dashboard_id: s.dashboard_id, frequency: s.frequency, weekday: s.weekday, hour: s.hour, format: s.format, recipients: s.recipients },
      ip: ipFrom(req),
    });
    return NextResponse.json({ schedule: s }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
