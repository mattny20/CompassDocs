// When the directory syncs on its own, and who gets the report.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getSyncSchedule, saveSyncSchedule, SYNC_FREQUENCIES } from "@/lib/directory-schedule";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "directory.sync_manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await getSyncSchedule());
}

export async function PUT(req: Request) {
  const gate = await apiGuard("admin", "directory.sync_manage");
  if (gate instanceof NextResponse) return gate;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const pick = (v: unknown) => ((SYNC_FREQUENCIES as readonly string[]).includes(String(v)) ? (String(v) as (typeof SYNC_FREQUENCIES)[number]) : undefined);
  const schedule = await saveSyncSchedule({
    microsoft: pick(body?.microsoft),
    google: pick(body?.google),
    hour: body?.hour === undefined ? undefined : Number(body.hour),
    report_to: body?.report_to === undefined ? undefined : String(body.report_to),
    report_quiet: body?.report_quiet === undefined ? undefined : Boolean(body.report_quiet),
  });
  await audit({
    actor: actorFrom(gate),
    action: "directory.schedule_updated",
    details: { microsoft: schedule.microsoft, google: schedule.google, hour: schedule.hour, recipients: schedule.report_to.length },
    ip: ipFrom(req),
  });
  return NextResponse.json(schedule);
}
