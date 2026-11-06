// GET /api/helpdesk/contacts/[userId]?ticket=<number>[&email=<address>] → { card: HdContactCard }
//
// One person's contact card on a ticket (the desk's hover card). userId 0
// with &email= reads someone with no account (a requester who wrote in by
// email). The caller must reach the person through the ticket
// (cardAudience): an agent working it, for anyone on it; the requester,
// for the agent assigned to or replying on their request. Anything else,
// including a ticket the caller cannot see, answers 404.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { cardAudience, contactCardFor } from "@/lib/helpdesk/contact-cards";
import { badRequest, loadTicketFor, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const { userId } = await params;
  if (!/^\d{1,10}$/.test(userId)) return badRequest("Unknown person.");
  const id = Number(userId);
  const sp = new URL(req.url).searchParams;
  const email = (sp.get("email") ?? "").trim().slice(0, 254);
  if (!id && !email) return badRequest("Name a person or an email address.");
  const loaded = await loadTicketFor(gate, sp.get("ticket") ?? "", "see");
  if (loaded instanceof NextResponse) return loaded;
  const reach = await cardAudience(gate, loaded.ticket, id || null, email);
  if (!reach) return notFound();
  const card = await contactCardFor(gate, id || null, {
    ticket: loaded.ticket,
    audience: reach.audience,
    fallback: { name: reach.person.name, email: reach.person.email },
    relation: reach.person.relation,
    relation_label: reach.person.relation_label,
  });
  return NextResponse.json({ card }, { headers: { "Cache-Control": "private, no-store" } });
}
