// DELETE /api/helpdesk/tickets/[number]/checklists/[id] → { checklists, can_edit, can_remove, templates }
//        Takes a checklist off the ticket. Needs tickets.change_status in the ticket's team too:
//        removing one could otherwise skip the solve check. Audited (helpdesk.checklist.removed);
//        the timeline says who removed it.
// Helpdesk 1.19.2 (agent W3, lib/helpdesk/checklists).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { loadTicketFor, notFound } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { checklistsEditable, removeChecklist, ticketChecklistView } from "@/lib/helpdesk/checklists";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string; id: string }> };

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const p = await params;
  const found = await loadTicketFor(gate, p.number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  const id = Number(p.id);
  if (!Number.isInteger(id) || id <= 0) return notFound();
  if (!checklistsEditable(t)) return NextResponse.json({ error: "This ticket can't change any more." }, { status: 409 });
  if (!(await hdCan(gate, "tickets.change_status", { teamId: t.team_id }))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const r = await removeChecklist(t.id, id, { id: gate.id, name: gate.name || gate.username });
  if (!r) return notFound();
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.checklist.removed",
    targetType: "helpdesk_ticket",
    targetId: t.id,
    targetLabel: `#${t.number} ${t.subject}`.slice(0, 200),
    details: { number: t.number, checklist_id: id, name: r.name, required_open: r.open_required },
    ip: ipFrom(req),
  });
  return NextResponse.json(await ticketChecklistView(gate, t));
}
