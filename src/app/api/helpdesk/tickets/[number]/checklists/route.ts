// GET  /api/helpdesk/tickets/[number]/checklists → { checklists, can_edit, can_remove, templates }
// POST /api/helpdesk/tickets/[number]/checklists   { template_id } → the same, with the template's
//      copy added (by hand). 409 when it is already on the ticket or the ticket holds the most it
//      may. Audited (helpdesk.checklist.added); the timeline says who added it.
// Helpdesk 1.19.2 (agent W3, lib/helpdesk/checklists). Agents who work the ticket only: a
// requester, CC or portal customer gets 404 like any ticket outside their queues.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor } from "@/lib/helpdesk/routes";
import { addChecklistToTicket, ChecklistError, checklistsEditable, ticketChecklistView } from "@/lib/helpdesk/checklists";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return NextResponse.json(await ticketChecklistView(gate, found.ticket));
}

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  if (!checklistsEditable(t)) return NextResponse.json({ error: t.merged_into ? "This ticket was merged. Add the checklist to the ticket it joined." : "This ticket is closed." }, { status: 409 });
  const b = await readJson(req, 1024);
  const templateId = typeof b?.template_id === "number" && Number.isInteger(b.template_id) && b.template_id > 0 ? b.template_id : null;
  if (!templateId) return badRequest("Choose a checklist.");
  try {
    const r = await addChecklistToTicket(t.id, templateId, { id: gate.id, name: gate.name || gate.username });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.checklist.added",
      targetType: "helpdesk_ticket",
      targetId: t.id,
      targetLabel: `#${t.number} ${t.subject}`.slice(0, 200),
      details: { number: t.number, checklist_id: r.checklist_id, template_id: templateId, name: r.name },
      ip: ipFrom(req),
    });
  } catch (e) {
    if (e instanceof ChecklistError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json(await ticketChecklistView(gate, t), { status: 201 });
}
