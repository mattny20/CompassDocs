// GET /api/helpdesk/tickets/[number]/people   the desk's CC and Following rows
//   (HdTicketPeople, lib/helpdesk/ccs-shared): the people copied on the
//   ticket with their addresses, its followers, whether the caller follows,
//   and whether outside addresses may be copied.
// Helpdesk 1.19.1 (helpdesk.agent, agents who work the ticket). 404 otherwise.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { ticketPeopleView } from "@/lib/helpdesk/ccs";
import { loadTicketFor } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return NextResponse.json(await ticketPeopleView(found.ticket.id, gate.id));
}
