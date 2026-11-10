// GET /api/helpdesk/tickets/[number]/assets/requester → HdRequesterDevices: the requester's own
// devices (assigned to their confirmed address in a connected asset source), for the requester
// strip on the ticket (1.20.3). The same devices the link picker's "Assigned to <requester>"
// group offers, read from the cache only: nothing is looked up in the source when a ticket
// opens. `connected: false` and no devices while no source is connected.
// Agents who work the ticket only (lib/helpdesk/assets), like every asset route on a ticket.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { loadTicketFor } from "@/lib/helpdesk/routes";
import { requesterDevices } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return NextResponse.json(await requesterDevices(found.ticket), { headers: { "Cache-Control": "private, no-store" } });
}
