// GET    /api/helpdesk/analytics/dashboards/[id] → { dashboard }
// PATCH  /api/helpdesk/analytics/dashboards/[id] { name?, description?, visibility?, team_id?, layout?, is_default? }
//        → { dashboard }; audited helpdesk.dashboard.updated
// DELETE /api/helpdesk/analytics/dashboards/[id] → { ok }; audited helpdesk.dashboard.deleted
// Helpdesk 1.19.0 reports (agent K). A dashboard the caller cannot see is a
// 404; editing a shared one needs its owner, reports.all or a Manager/Admin
// desk role; built-ins are read-only (lib/helpdesk/analytics/store).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { deleteDashboard, getDashboard, updateDashboard } from "@/lib/helpdesk/analytics/store";
import { NO_STORE, errorResponse, idParam, reportsGate } from "@/lib/helpdesk/analytics/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "That dashboard doesn't exist." }, { status: 404 });

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  const id = idParam((await ctx.params).id);
  if (!id) return notFound();
  try {
    const d = await getDashboard(id, gate);
    return d ? NextResponse.json({ dashboard: d }, { headers: NO_STORE }) : notFound();
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  const id = idParam((await ctx.params).id);
  if (!id) return notFound();
  const body = await readJson(req, 128 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  try {
    const { before, after } = await updateDashboard(id, gate, body);
    const changed = (["name", "description", "visibility", "team_id", "is_default"] as const).filter((k) => before[k] !== after[k]);
    if (JSON.stringify(before.layout) !== JSON.stringify(after.layout)) (changed as string[]).push("layout");
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.dashboard.updated",
      targetType: "helpdesk_dashboard",
      targetId: id,
      targetLabel: after.name,
      details: { changed, visibility: after.visibility, team_id: after.team_id, widgets: after.layout.widgets.length },
      ip: ipFrom(req),
    });
    return NextResponse.json({ dashboard: after });
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
    const d = await deleteDashboard(id, gate);
    await audit({ actor: actorFrom(gate), action: "helpdesk.dashboard.deleted", targetType: "helpdesk_dashboard", targetId: id, targetLabel: d.name, ip: ipFrom(req) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
