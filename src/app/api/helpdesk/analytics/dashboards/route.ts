// GET  /api/helpdesk/analytics/dashboards → { dashboards: HdDashboard[] } (built-ins first)
// POST /api/helpdesk/analytics/dashboards { name, description?, visibility?, team_id?, layout?, is_default? }
//   → 201 { dashboard }; audited helpdesk.dashboard.created
// Helpdesk 1.19.0 reports (agent K): any report capability.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { createDashboard, listDashboards } from "@/lib/helpdesk/analytics/store";
import { NO_STORE, errorResponse, reportsGate } from "@/lib/helpdesk/analytics/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  try {
    return NextResponse.json({ dashboards: await listDashboards(gate) }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 128 * 1024);
  if (!body) return NextResponse.json({ error: "Send the dashboard as JSON." }, { status: 400 });
  try {
    const d = await createDashboard(gate, body);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.dashboard.created",
      targetType: "helpdesk_dashboard",
      targetId: d.id,
      targetLabel: d.name,
      details: { visibility: d.visibility, team_id: d.team_id, widgets: d.layout.widgets.length },
      ip: ipFrom(req),
    });
    return NextResponse.json({ dashboard: d }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
