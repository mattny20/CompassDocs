// POST /api/helpdesk/analytics/query  { measure, groupBy?, filters?, range, compare?, limit?, automated?, format? }
//   → { result: HdQueryResult }, or with format "csv" the rows as a CSV download
//   (tickets.export; audited helpdesk.report.exported).
// Helpdesk 1.19.0 reports (agent K). Any report capability; the numbers are
// the caller's scope (lib/helpdesk/analytics/engine).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { exportRateLimited } from "@/lib/rate-limit";
import { runQuery } from "@/lib/helpdesk/analytics/engine";
import { resultCsvLines } from "@/lib/helpdesk/analytics/export";
import { HD_MEASURES, parseQuery } from "@/lib/helpdesk/analytics/shared";
import { EXPORT_FORBIDDEN, NO_STORE, canExport, errorResponse, queryLimited, reportsGate } from "@/lib/helpdesk/analytics/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 32 * 1024);
  if (!body) return NextResponse.json({ error: "Send the query as JSON." }, { status: 400 });
  const parsed = parseQuery(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const csv = body.format === "csv";
  if (csv) {
    if (!(await canExport(gate))) return NextResponse.json({ error: EXPORT_FORBIDDEN }, { status: 403 });
    if (exportRateLimited(`hd-analytics:${gate.id}`)) return NextResponse.json({ error: "Too many exports. Try again in a minute." }, { status: 429 });
  } else if (queryLimited(gate.id)) {
    return NextResponse.json({ error: "Too many reports at once. Try again in a minute." }, { status: 429 });
  }
  try {
    const result = await runQuery(parsed.value, gate);
    if (!csv) return NextResponse.json({ result }, { headers: NO_STORE });
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 80) : HD_MEASURES[result.measure].label;
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.report.exported",
      targetType: "helpdesk_report",
      targetLabel: title,
      details: { format: "csv", measure: result.measure, group_by: result.groupBy, from: result.range.from, to: result.range.to, filters: parsed.value.filters },
      ip: ipFrom(req),
    });
    const name = `${title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "report"}-${result.range.from}-to-${result.range.to}.csv`;
    return new Response("\ufeff" + resultCsvLines(title, result).join("\r\n") + "\r\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, ...NO_STORE },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
