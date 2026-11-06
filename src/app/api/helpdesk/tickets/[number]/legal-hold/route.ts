// GET /api/helpdesk/tickets/[number]/legal-hold → { legal_hold, by_name, at }
// PUT /api/helpdesk/tickets/[number]/legal-hold   { on: boolean } → the same. Audited
//     (helpdesk.ticket.legal_hold_set / helpdesk.ticket.legal_hold_cleared).
// Helpdesk 1.19.1 (lib/helpdesk/retention): a ticket on legal hold is never closed,
// anonymised or deleted by retention or account removal. Agents who work the ticket
// read it; desk capability settings.manage sets it.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { loadTicketFor } from "@/lib/helpdesk/routes";
import { getLegalHold, setLegalHold } from "@/lib/helpdesk/retention";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const hold = await getLegalHold(found.ticket.id);
  return NextResponse.json({ ...hold, can_change: await hdCan(gate, "settings.manage") });
}

export async function PUT(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  if (!(await hdCan(gate, "settings.manage"))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const body = await readJson(req, 1024);
  if (!body || typeof body.on !== "boolean") return NextResponse.json({ error: "Send { on: true } or { on: false }." }, { status: 400 });
  const changed = await setLegalHold(found.ticket.id, body.on, gate.id);
  if (changed) {
    await audit({
      actor: actorFrom(gate),
      action: body.on ? "helpdesk.ticket.legal_hold_set" : "helpdesk.ticket.legal_hold_cleared",
      targetType: "helpdesk_ticket",
      targetId: found.ticket.id,
      targetLabel: `#${found.ticket.number}`,
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ ...(await getLegalHold(found.ticket.id)), can_change: true });
}
