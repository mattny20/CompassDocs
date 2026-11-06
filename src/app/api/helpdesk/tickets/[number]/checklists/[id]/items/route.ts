// POST /api/helpdesk/tickets/[number]/checklists/[id]/items  { title } → { checklists, can_edit, can_remove, templates }
//      A one-off item (never required) on this ticket's checklist. Audited
//      (helpdesk.checklist.item_added); the timeline says who added it.
// Helpdesk 1.19.2 (agent W3, lib/helpdesk/checklists).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { loadTicketFor, notFound } from "@/lib/helpdesk/routes";
import { addItem, ChecklistError, checklistsEditable, ticketChecklistView } from "@/lib/helpdesk/checklists";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string; id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const p = await params;
  const found = await loadTicketFor(gate, p.number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  const id = Number(p.id);
  if (!Number.isInteger(id) || id <= 0) return notFound();
  if (!checklistsEditable(t)) return NextResponse.json({ error: "This ticket can't change any more." }, { status: 409 });
  const b = await readJson(req, 4 * 1024);
  try {
    const r = await addItem(t.id, id, b?.title, { id: gate.id, name: gate.name || gate.username });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.checklist.item_added",
      targetType: "helpdesk_ticket",
      targetId: t.id,
      targetLabel: `#${t.number} ${t.subject}`.slice(0, 200),
      details: { number: t.number, checklist_id: id, checklist: r.checklist, item_id: r.item.id, title: r.item.title },
      ip: ipFrom(req),
    });
  } catch (e) {
    if (e instanceof ChecklistError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json(await ticketChecklistView(gate, t), { status: 201 });
}
