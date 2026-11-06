// POST /api/helpdesk/analytics/dashboards/[id]/duplicate { name? } → 201 { dashboard }
// A private copy for the caller (how a built-in is customised). Audited
// helpdesk.dashboard.created with duplicated_from. Helpdesk 1.19.0 reports (agent K).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { duplicateDashboard } from "@/lib/helpdesk/analytics/store";
import { errorResponse, idParam, reportsGate } from "@/lib/helpdesk/analytics/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  const id = idParam((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "That dashboard doesn't exist." }, { status: 404 });
  const body = (await readJson(req, 4 * 1024)) ?? {};
  try {
    const d = await duplicateDashboard(id, gate, body.name);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.dashboard.created",
      targetType: "helpdesk_dashboard",
      targetId: d.id,
      targetLabel: d.name,
      details: { duplicated_from: id, widgets: d.layout.widgets.length },
      ip: ipFrom(req),
    });
    return NextResponse.json({ dashboard: d }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
