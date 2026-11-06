// GET    /api/helpdesk/incidents/ticket/[number]   the ticket pane's incident card
//          { role: "incident", incident } (its own ticket), { role: "linked", link }
//          (a linked ticket), or { role: null }. Agents who work the ticket.
// DELETE /api/helpdesk/incidents/ticket/[number]   unlink this ticket from its
//          incident: the agent works it and holds incidents.link in its team.
//          Audited (helpdesk.incident.unlinked).
// Helpdesk 1.19.2 (agent W1, lib/helpdesk/incidents).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { incidentErrorBody, incidentForTicket, unlinkTicket } from "@/lib/helpdesk/incidents";
import { loadTicketFor, notFound } from "@/lib/helpdesk/routes";
import { parseTicketNumber } from "@/lib/helpdesk/tickets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return NextResponse.json(await incidentForTicket(gate, found.ticket));
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const number = parseTicketNumber((await params).number);
  if (!number) return notFound();
  try {
    const r = await unlinkTicket(gate, number);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.incident.unlinked",
      targetType: "helpdesk_ticket",
      targetId: r.ticket_id,
      targetLabel: `#${r.ticket_number}`,
      details: { incident: r.incident_number, ticket: r.ticket_number },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, incident: r.incident_number });
  } catch (e) {
    const err = incidentErrorBody(e);
    if (err) return NextResponse.json(err.body, { status: err.status });
    throw e;
  }
}
