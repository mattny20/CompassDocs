// GET /api/helpdesk/incidents/banners   the major incident banners Get help
//       shows this person: { banners: [{ id, title, message, team_name,
//       last_update_at, affected, me_too }] }. Requester-safe: no ticket
//       numbers, no agent names. helpdesk.request.
// Helpdesk 1.19.2 (agent W1, lib/helpdesk/incidents bannersFor).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { bannersFor } from "@/lib/helpdesk/incidents";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ banners: await bannersFor(gate) });
}
