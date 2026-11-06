// GET /api/helpdesk/contacts?ticket=<number> → HdTicketContacts
//
// Helpdesk 1.19.0 contact cards. An agent who works the ticket gets the
// cards of the people on it (requester first, then contacts, approvers and
// people named in the form); the requester gets the card of the agent
// helping them ("Who's helping you"). Anyone else, or a ticket that does
// not exist, answers 404. Every card goes through the directory's
// visibility rules for the caller (lib/helpdesk/contact-cards).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { ticketContactCards } from "@/lib/helpdesk/contact-cards";
import { loadTicketFor, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const raw = new URL(req.url).searchParams.get("ticket") ?? "";
  const loaded = await loadTicketFor(gate, raw, "see");
  if (loaded instanceof NextResponse) return loaded;
  const out = await ticketContactCards(gate, loaded.ticket);
  if (!out) return notFound();
  return NextResponse.json(out, { headers: { "Cache-Control": "private, no-store" } });
}
