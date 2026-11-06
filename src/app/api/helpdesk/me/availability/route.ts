// GET   /api/helpdesk/me/availability   → { status }
// PATCH /api/helpdesk/me/availability   { status: 'available'|'away'|'offline' } → { status }
// Helpdesk 1.19.0 (helpdesk.agent). The desk's top-bar availability.

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { getAvailability, isAvailability, setAvailability } from "@/lib/helpdesk/teams";
import { badRequest } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ status: await getAvailability(gate.id) });
}

export async function PATCH(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 1024);
  if (!b || !isAvailability(b.status)) return badRequest("Availability is available, away or offline.");
  return NextResponse.json({ status: await setAvailability(gate.id, b.status) });
}
