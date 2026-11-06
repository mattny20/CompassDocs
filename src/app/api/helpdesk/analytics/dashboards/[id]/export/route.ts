// GET /api/helpdesk/analytics/dashboards/[id]/export?format=csv|pdf&<view>
//   the whole dashboard in the caller's scope, as the filter bar shows it
//   (the view travels as lib/helpdesk/analytics/url-state encodes it:
//   range or from+to, cmp, auto, the filter keys). Needs tickets.export;
//   audited helpdesk.report.exported. Helpdesk 1.19.0 reports (agent K).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { exportRateLimited } from "@/lib/rate-limit";
import { getDashboard } from "@/lib/helpdesk/analytics/store";
import { dashboardCsv, runDashboard } from "@/lib/helpdesk/analytics/export";
import { defaultState, stateFromParams } from "@/lib/helpdesk/analytics/url-state";
import { EXPORT_FORBIDDEN, NO_STORE, canExport, errorResponse, idParam, reportsGate } from "@/lib/helpdesk/analytics/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  const id = idParam((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "That dashboard doesn't exist." }, { status: 404 });
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "csv";
  if (format !== "csv" && format !== "pdf") return NextResponse.json({ error: "Choose csv or pdf." }, { status: 400 });
  if (!(await canExport(gate))) return NextResponse.json({ error: EXPORT_FORBIDDEN }, { status: 403 });
  if (exportRateLimited(`hd-analytics:${gate.id}`)) return NextResponse.json({ error: "Too many exports. Try again in a minute." }, { status: 429 });
  try {
    const d = await getDashboard(id, gate);
    if (!d) return NextResponse.json({ error: "That dashboard doesn't exist." }, { status: 404 });
    const state = stateFromParams(url.searchParams, defaultState(d.layout));
    const results = await runDashboard(d, gate, state);
    const first = results.find((r) => r.result)?.result;
    const stem = `${d.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "dashboard"}-${first?.range.from ?? ""}-to-${first?.range.to ?? ""}`;
    const record = () =>
      audit({
        actor: actorFrom(gate),
        action: "helpdesk.report.exported",
        targetType: "helpdesk_dashboard",
        targetId: d.id,
        targetLabel: d.name,
        details: { format, from: first?.range.from ?? null, to: first?.range.to ?? null, filters: state.filters, automated: state.automated },
        ip: ipFrom(req),
      });
    if (format === "csv") {
      const body = "\ufeff" + dashboardCsv(d, results, state);
      await record();
      return new Response(body, {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${stem}.csv"`, ...NO_STORE },
      });
    }
    const { dashboardPdf } = await import("@/lib/helpdesk/analytics/export-pdf");
    const pdf = await dashboardPdf(d, results, state, gate.name || gate.username);
    await record();
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${stem}.pdf"`, ...NO_STORE },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
