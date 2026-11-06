// GET /api/helpdesk/assets/mine → { assets: { id, name, tag, category, model }[] }: the signed-in
// person's own devices (assigned to their address in Snipe-IT), for Get help's optional Device
// picker. Nobody else's, ever; empty when no source is set up or they have no address.
// Helpdesk 1.19.3 (lib/helpdesk/assets). Anyone who may raise a request (helpdesk.request).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { myAssets } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ assets: await myAssets(gate) });
}
