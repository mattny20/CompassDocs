// DELETE /api/helpdesk/requests/[number]/ccs/[id]   the requester takes
//   someone off their request; someone copied on it may remove only
//   themselves ("Leave"). → 200 { people } (null once the caller left).
//   Audited (helpdesk.ticket.cc_removed).
// Helpdesk 1.19.1 (helpdesk.request). 404 for anything else.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { listCcs, removeCc, requestPeopleView } from "@/lib/helpdesk/ccs";
import { loadTicketFor, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ number: string; id: string }> }) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const p = await params;
  const id = Number(p.id);
  if (!Number.isSafeInteger(id) || id <= 0) return notFound();
  const found = await loadTicketFor(gate, p.number, "see");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  const isRequester = t.requester_id === gate.id;
  const row = (await listCcs(t.id)).find((c) => c.id === id);
  if (!row || (!isRequester && row.userId !== gate.id)) return notFound();
  await removeCc(t.id, id, { userId: gate.id, name: gate.name || gate.username, role: gate.role, via: "portal" });
  return NextResponse.json({ people: isRequester ? await requestPeopleView(t, gate.id, found.relation) : null });
}
