// DELETE /api/helpdesk/tickets/[number]/assets/[assetId] → the ticket's HdTicketAssetsView.
// Unlinks the asset (404 when it was not linked; 409 on a merged or closed ticket). Audited
// (helpdesk.asset.unlinked); the timeline says who. Helpdesk 1.19.3 (lib/helpdesk/assets).
// Agents who work the ticket only.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { loadTicketFor, notFound } from "@/lib/helpdesk/routes";
import { AssetError, ticketAssetsView, unlinkAsset } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string; assetId: string }> };

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const p = await params;
  const found = await loadTicketFor(gate, p.number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  const assetId = Number(p.assetId);
  if (!Number.isInteger(assetId) || assetId <= 0) return notFound();
  try {
    const a = await unlinkAsset(t, assetId, { id: gate.id, name: gate.name || gate.username });
    if (!a) return notFound();
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.asset.unlinked",
      targetType: "helpdesk_ticket",
      targetId: t.id,
      targetLabel: `#${t.number} ${t.subject}`.slice(0, 200),
      details: { number: t.number, asset_id: a.id, tag: a.tag, name: a.name, source: a.provider_label },
      ip: ipFrom(req),
    });
  } catch (e) {
    if (e instanceof AssetError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json(await ticketAssetsView(t));
}
