// POST /api/helpdesk/tickets/[number]/ccs   { people: [{ user_id } | { email, name? }] }
//   An agent copies people on the ticket: workspace accounts, or outside
//   addresses while outside senders are on (Desk -> Settings -> Email).
//   They read the public conversation in Get help and get the public
//   replies, never internal notes. → 200 { added, skipped, people }
//   Audited (helpdesk.ticket.cc_added).
// Helpdesk 1.19.1: agents who work the ticket and may reply to the
// requester (sent or after review). 30 a minute per person.

import { NextResponse } from "next/server";
import { helpdeskGate, messagePostLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { addCcs, ccViews, parseCcInput, ticketPeopleView } from "@/lib/helpdesk/ccs";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { badRequest, loadTicketFor } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (messagePostLimited(gate.id)) return tooMany();
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  const teamId = t.team_id;
  if (!(await hdCan(gate, "tickets.reply_public", { teamId })) && !(await hdCan(gate, "tickets.reply_needs_review", { teamId }))) {
    return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  }
  if (t.status === "closed") return NextResponse.json({ error: "This ticket is closed." }, { status: 409 });
  const b = await readJson(req, 32 * 1024);
  const people = parseCcInput(b?.people);
  if (!people || !people.length) return badRequest("Choose who to copy.");
  const res = await addCcs(t.id, people, { userId: gate.id, name: gate.name || gate.username, role: gate.role, via: "desk" });
  return NextResponse.json({ added: ccViews(res.added, "agent"), skipped: res.skipped, people: await ticketPeopleView(t.id, gate.id) });
}
