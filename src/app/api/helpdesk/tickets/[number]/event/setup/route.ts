// POST /api/helpdesk/tickets/[number]/event/setup  { complete: boolean } → HdTicketEventView
//        Mark the event's setup complete (who and when), or take the mark back while the ticket is open
//        (1.20.6, lib/helpdesk/desk-calendar). Until it is complete the ticket can't be solved. An agents-only
//        timeline line records it; the event.setup_completed webhook follows a mark. 404: no event. 409: the
//        event was cancelled, or the mark is being taken back on a solved ticket.
// Agents who work the ticket (helpdesk.agent).

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor, originOf } from "@/lib/helpdesk/routes";
import { EventError, setSetupComplete, ticketEventView } from "@/lib/helpdesk/desk-calendar";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const b = await readJson(req, 1024);
  if (!b || typeof b.complete !== "boolean") return badRequest("Send { complete: true } or { complete: false }.");
  try {
    await setSetupComplete(found.ticket, b.complete, { id: gate.id, name: gate.name || gate.username }, { origin: originOf(req) });
  } catch (e) {
    if (e instanceof EventError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json(await ticketEventView(gate, found.ticket, true));
}
