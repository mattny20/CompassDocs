// GET /api/helpdesk/time/timer   → { timer: { ticket_id, ticket_number, started_at } | null }, the caller's running timer.
// Helpdesk 1.19.1 (agent V8). Agents.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { getTimer } from "@/lib/helpdesk/time";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ timer: await getTimer(gate.id) });
}
