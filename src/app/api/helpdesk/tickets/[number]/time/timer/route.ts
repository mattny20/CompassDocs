// POST   /api/helpdesk/tickets/[number]/time/timer   start the caller's timer here. One timer per agent:
//                                                    running on another ticket, it stops there first and
//                                                    logs that time → { timer, logged: entry | null }.
// DELETE /api/helpdesk/tickets/[number]/time/timer   { note? } stop it here and log the time → { timer: null, logged }.
// Helpdesk 1.19.1 (agent V8). Agents who can work the ticket. A logged entry is audited helpdesk.time.logged.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { loadTicketFor } from "@/lib/helpdesk/routes";
import { auditTime, cleanNote, startTimer, stopTimer } from "@/lib/helpdesk/time";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const loaded = await loadTicketFor(gate, (await ctx.params).number, "work");
  if (loaded instanceof NextResponse) return loaded;
  const r = await startTimer(gate.id, loaded.ticket.id);
  if (r.logged) {
    await auditTime(req, gate, "helpdesk.time.logged", { type: "helpdesk_ticket", id: r.logged.ticket_number }, { entry: r.logged.id, minutes: r.logged.minutes, source: "timer" });
  }
  return NextResponse.json(r);
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const loaded = await loadTicketFor(gate, (await ctx.params).number, "work");
  if (loaded instanceof NextResponse) return loaded;
  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  const note = cleanNote(body?.note);
  if (note === null) return NextResponse.json({ error: "Keep the note under 300 characters." }, { status: 400 });
  const r = await stopTimer(gate.id, { ticketId: loaded.ticket.id, note });
  if (!r.logged) return NextResponse.json({ error: "Your timer isn't running on this ticket." }, { status: 409 });
  await auditTime(req, gate, "helpdesk.time.logged", { type: "helpdesk_ticket", id: loaded.ticket.number, label: loaded.ticket.subject }, { entry: r.logged.id, minutes: r.logged.minutes, source: "timer" });
  return NextResponse.json(r);
}
