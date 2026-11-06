// GET  /api/helpdesk/tickets/[number]/assets → HdTicketAssetsView (the linked assets, each with its
//      earlier tickets; whether the agent may link more; the requester's name and address).
// POST /api/helpdesk/tickets/[number]/assets   { asset_id } → the view (201). The agent must see the
//      asset (the requester's own, one of their people's, or any with "Agents can search all
//      assets"). 409 when already linked, the ticket holds ten, or it is merged or closed.
//      Audited (helpdesk.asset.linked); the timeline says who linked it.
// Helpdesk 1.19.3 (lib/helpdesk/assets; mock-up i1). Agents who work the ticket only: a requester,
// CC or portal customer gets 404 like any ticket outside their queues.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor } from "@/lib/helpdesk/routes";
import { AssetError, linkAsset, ticketAssetsView } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return NextResponse.json(await ticketAssetsView(found.ticket));
}

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  const b = await readJson(req, 1024);
  const assetId = typeof b?.asset_id === "number" && Number.isInteger(b.asset_id) && b.asset_id > 0 ? b.asset_id : null;
  if (!assetId) return badRequest("Choose an asset.");
  try {
    const a = await linkAsset(gate, t, assetId, { id: gate.id, name: gate.name || gate.username });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.asset.linked",
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
  return NextResponse.json(await ticketAssetsView(t), { status: 201 });
}
