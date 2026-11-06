// GET /api/helpdesk/push/devices: the browsers and phones the agent turned
// push on for (no endpoints or keys; a fingerprint lets the page find
// itself). Helpdesk 1.19.0.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { listPushDevices } from "@/lib/helpdesk/push";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ devices: await listPushDevices(gate.id) });
}
