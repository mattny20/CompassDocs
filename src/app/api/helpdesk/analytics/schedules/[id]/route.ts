// PATCH  /api/helpdesk/analytics/schedules/[id] { recipients?, frequency?, weekday?, hour?, format?, enabled? }
//        → { schedule }; audited helpdesk.report_schedule.updated
// DELETE /api/helpdesk/analytics/schedules/[id] → { ok }; audited helpdesk.report_schedule.deleted
// Helpdesk 1.19.0 reports (agent K).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { deleteSchedule, updateSchedule } from "@/lib/helpdesk/analytics/schedules";
import { errorResponse, idParam, reportsGate } from "@/lib/helpdesk/analytics/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "That schedule doesn't exist." }, { status: 404 });

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  const id = idParam((await ctx.params).id);
  if (!id) return notFound();
  const body = await readJson(req, 16 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  try {
    const { before, after } = await updateSchedule(id, gate, body);
    const changed = (["frequency", "weekday", "hour", "format", "enabled"] as const).filter((k) => before[k] !== after[k]);
    if (JSON.stringify(before.recipients) !== JSON.stringify(after.recipients)) (changed as string[]).push("recipients");
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.report_schedule.updated",
      targetType: "helpdesk_report_schedule",
      targetId: id,
      targetLabel: after.dashboard_name,
      details: { changed, recipients: after.recipients },
      ip: ipFrom(req),
    });
    return NextResponse.json({ schedule: after });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  const id = idParam((await ctx.params).id);
  if (!id) return notFound();
  try {
    const s = await deleteSchedule(id, gate);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.report_schedule.deleted",
      targetType: "helpdesk_report_schedule",
      targetId: id,
      targetLabel: s.dashboard_name,
      details: { dashboard_id: s.dashboard_id },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
