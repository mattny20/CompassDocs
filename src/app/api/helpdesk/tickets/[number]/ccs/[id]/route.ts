// DELETE /api/helpdesk/tickets/[number]/ccs/[id]   an agent takes someone off
//   the ticket's CC list. → 200 { people }. Audited (helpdesk.ticket.cc_removed).
// Helpdesk 1.19.1: agents who work the ticket and may reply to the requester.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { removeCc, ticketPeopleView } from "@/lib/helpdesk/ccs";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { loadTicketFor, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ number: string; id: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const p = await params;
  const id = Number(p.id);
  if (!Number.isSafeInteger(id) || id <= 0) return notFound();
  const found = await loadTicketFor(gate, p.number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  const teamId = t.team_id;
  if (!(await hdCan(gate, "tickets.reply_public", { teamId })) && !(await hdCan(gate, "tickets.reply_needs_review", { teamId }))) {
    return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  }
  const removed = await removeCc(t.id, id, { userId: gate.id, name: gate.name || gate.username, role: gate.role, via: "desk" });
  if (!removed) return notFound();
  return NextResponse.json({ people: await ticketPeopleView(t.id, gate.id) });
}
