// POST   /api/helpdesk/tickets/[number]/follow   follow the ticket: its new
//        replies, notes and status changes reach you (desk_followed_update,
//        your desk notification settings apply).
// DELETE /api/helpdesk/tickets/[number]/follow   unfollow; replying again
//        does not follow it back.
//   → 200 { people }. Audited (helpdesk.ticket.follower_added / _removed).
// Helpdesk 1.19.1 (helpdesk.agent, agents who work the ticket).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { followTicket, ticketPeopleView, unfollowTicket } from "@/lib/helpdesk/ccs";
import { loadTicketFor } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

async function act(params: Promise<{ number: string }>, follow: boolean) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const actor = { userId: gate.id, name: gate.name || gate.username, role: gate.role, via: "desk" };
  if (follow) await followTicket(found.ticket.id, gate.id, actor);
  else await unfollowTicket(found.ticket.id, gate.id, actor);
  return NextResponse.json({ people: await ticketPeopleView(found.ticket.id, gate.id) });
}

export async function POST(_req: Request, { params }: { params: Promise<{ number: string }> }) {
  return act(params, true);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ number: string }> }) {
  return act(params, false);
}
