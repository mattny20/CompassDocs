// PATCH /api/helpdesk/tickets/[number]/checklists/items/[itemId]  { done: boolean }
//       → { checklists, can_edit, can_remove, templates }. Ticks or unticks an item; a change
//       leaves an internal timeline line ("Ana ticked "Image the laptop" (New starter: IT)") and
//       is audited (helpdesk.checklist.item_ticked / helpdesk.checklist.item_unticked).
// Helpdesk 1.19.2 (agent W3, lib/helpdesk/checklists). Anyone who works the ticket, newbies too.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor, notFound } from "@/lib/helpdesk/routes";
import { ChecklistError, checklistsEditable, setItemDone, ticketChecklistView } from "@/lib/helpdesk/checklists";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string; itemId: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const p = await params;
  const found = await loadTicketFor(gate, p.number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  const itemId = Number(p.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) return notFound();
  if (!checklistsEditable(t)) return NextResponse.json({ error: "This ticket can't change any more." }, { status: 409 });
  const b = await readJson(req, 1024);
  if (!b || typeof b.done !== "boolean") return badRequest("Send { done: true } or { done: false }.");
  try {
    const r = await setItemDone(t.id, itemId, b.done, { id: gate.id, name: gate.name || gate.username });
    if (r.changed) {
      await audit({
        actor: actorFrom(gate),
        action: b.done ? "helpdesk.checklist.item_ticked" : "helpdesk.checklist.item_unticked",
        targetType: "helpdesk_ticket",
        targetId: t.id,
        targetLabel: `#${t.number} ${t.subject}`.slice(0, 200),
        details: { number: t.number, item_id: itemId, title: r.item.title, checklist: r.checklist, required: r.item.required },
        ip: ipFrom(req),
      });
    }
  } catch (e) {
    if (e instanceof ChecklistError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json(await ticketChecklistView(gate, t));
}
