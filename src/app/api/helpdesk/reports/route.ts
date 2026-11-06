// GET /api/helpdesk/reports?from=YYYY-MM-DD&to=YYYY-MM-DD[&team=<id> | &agent=me][&format=csv]
// Helpdesk 1.19.0. Defaults to the last 30 days; dates are days in the
// helpdesk's time zone, at most 366 of them (lib/helpdesk/reports). Who
// sees what is agent J's capability matrix:
//   agent=me   reports.own    (only the caller's assigned tickets)
//   team=<id>  reports.team   in that team (or reports.all)
//   neither    reports.all
// The CSV also needs tickets.export and is audited as helpdesk.report.exported.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { HD_FORBIDDEN, hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import { getHelpdeskSettings } from "@/lib/helpdesk/settings";
import { parseReportRange, reportCsv, reportSummary } from "@/lib/helpdesk/reports";
import { exportRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await hdAnyCapGate(["reports.own", "reports.team", "reports.all"]);
  if (gate instanceof NextResponse) return gate;
  const url = new URL(req.url);
  const settings = await getHelpdeskSettings();
  const parsed = parseReportRange(url.searchParams, settings.timezone);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const range = parsed.range as typeof parsed.range & { own?: boolean };
  let allowed: boolean;
  if (range.own) {
    allowed = await hdCan(gate, "reports.own");
    range.assignee_id = gate.id;
  } else if (range.team_id) {
    allowed = await hdCan(gate, "reports.team", { teamId: range.team_id });
  } else {
    allowed = await hdCan(gate, "reports.all");
  }
  if (!allowed) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const csv = url.searchParams.get("format") === "csv";
  if (csv && !(await hdCan(gate, "tickets.export"))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  if (exportRateLimited(`hd-report:${gate.id}`)) return NextResponse.json({ error: "Too many reports. Try again in a minute." }, { status: 429 });
  const report = await reportSummary({ from: range.from, to: range.to, team_id: range.team_id, assignee_id: range.assignee_id });
  if (csv) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.report.exported",
      targetType: "helpdesk_report",
      details: { from: report.from, to: report.to, team_id: range.team_id ?? null, own: Boolean(range.own) },
      ip: ipFrom(req),
    });
    const name = `helpdesk-report-${report.from}-to-${report.to}.csv`;
    return new Response("﻿" + reportCsv(report), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ report, timezone: settings.timezone }, { headers: { "Cache-Control": "no-store" } });
}
