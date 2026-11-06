// GET  /api/helpdesk/requests/[number]/ccs   the people copied on a request
//      (HdRequestPeople), for its requester or someone copied on it. Outside
//      addresses show; workspace accounts show by name only.
// POST /api/helpdesk/requests/[number]/ccs   { people: [{ user_id } | { email, name? }] }
//      The requester copies people on their own request ("Add people"):
//      directory accounts, or outside addresses while outside senders are
//      on. → 200 { added, skipped, people }. Audited (helpdesk.ticket.cc_added).
// Helpdesk 1.19.1 (helpdesk.request). 404 for anyone else. 30 a minute.

import { NextResponse } from "next/server";
import { helpdeskGate, messagePostLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { addCcs, ccViews, parseCcInput, requestPeopleView } from "@/lib/helpdesk/ccs";
import { badRequest, loadTicketFor, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "see");
  if (found instanceof NextResponse) return found;
  const view = await requestPeopleView(found.ticket, gate.id, found.relation);
  if (!view) return notFound();
  return NextResponse.json(view);
}

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  if (messagePostLimited(gate.id)) return tooMany();
  const found = await loadTicketFor(gate, (await params).number, "see");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  if (t.requester_id !== gate.id) return notFound();
  if (t.status === "closed") return NextResponse.json({ error: "This request is closed." }, { status: 409 });
  const b = await readJson(req, 32 * 1024);
  const people = parseCcInput(b?.people);
  if (!people || !people.length) return badRequest("Choose who to add.");
  const res = await addCcs(t.id, people, { userId: gate.id, name: gate.name || gate.username, role: gate.role, via: "portal" });
  return NextResponse.json({ added: ccViews(res.added, "requester"), skipped: res.skipped, people: await requestPeopleView(t, gate.id, found.relation) });
}
