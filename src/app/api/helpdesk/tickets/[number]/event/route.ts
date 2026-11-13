// GET    /api/helpdesk/tickets/[number]/event → HdTicketEventView { event, conflicts, can_edit, default_setup_minutes }
//          The ticket's event (1.20.6, lib/helpdesk/desk-calendar), the other events that overlap it at the same place,
//          and whether the caller may change it.
// PUT    /api/helpdesk/tickets/[number]/event  { starts_at, ends_at, place?, setup_minutes? }
//                                           or { all_day: true, start_date, end_date?, timezone?, place?, setup_minutes? }
//          Add the event, or change it (left-out fields keep their value). Times are instants with their zone
//          ("2026-11-20T14:00:00Z"); whole days are dates, counted in `timezone` (default: the ticket's team calendar's).
//          → HdTicketEventView. An agents-only timeline line records it. 409 on a closed or merged ticket.
// DELETE /api/helpdesk/tickets/[number]/event → { ok: true, removed }
// Agents who work the ticket (helpdesk.agent; 404 for a ticket outside the caller's queues).

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor, originOf } from "@/lib/helpdesk/routes";
import { EventError, removeTicketEvent, setTicketEvent, ticketEventView } from "@/lib/helpdesk/desk-calendar";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return NextResponse.json(await ticketEventView(gate, found.ticket, true));
}

export async function PUT(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const b = await readJson(req, 8 * 1024);
  if (!b) return badRequest("Send the event as JSON.");
  try {
    await setTicketEvent(found.ticket, b, { id: gate.id, name: gate.name || gate.username }, { origin: originOf(req) });
  } catch (e) {
    if (e instanceof EventError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json(await ticketEventView(gate, found.ticket, true));
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  try {
    const removed = await removeTicketEvent(found.ticket, { id: gate.id, name: gate.name || gate.username }, { origin: originOf(req) });
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    if (e instanceof EventError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
