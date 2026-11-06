// GET /api/helpdesk/tickets/[number]/assets/options?q= → HdAssetOptions: the link picker's
// "Assigned to <requester>" group (looked up live in the source when the cache has none), then
// the assets matching q (tag, serial, name, model or person; an exact tag or serial the cache lacks
// is looked up live). Every asset with "Agents can search all assets" on, else only the agent's
// people's. Helpdesk 1.19.3 (lib/helpdesk/assets; mock-up i1). Agents who work the ticket only.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { loadTicketFor } from "@/lib/helpdesk/routes";
import { ASSET_LIMITS, assetOptions } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, ASSET_LIMITS.q);
  return NextResponse.json(await assetOptions(gate, found.ticket, q));
}
