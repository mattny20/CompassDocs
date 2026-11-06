// GET  /api/helpdesk/tickets/[number]/time   → HdTicketTime: the entries (newest first, each with can_edit),
//                                              the total, the caller's running timer, the team's ask-on-solve.
// POST /api/helpdesk/tickets/[number]/time   { minutes, note? } log time by hand → { entry }. helpdesk.time.logged.
// Helpdesk 1.19.1 (agent V8). Agents who can work the ticket; requesters never reach time.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { loadTicketFor } from "@/lib/helpdesk/routes";
import { auditTime, cleanMinutes, cleanNote, logTime, ticketTime } from "@/lib/helpdesk/time";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const loaded = await loadTicketFor(gate, (await ctx.params).number, "work");
  if (loaded instanceof NextResponse) return loaded;
  return NextResponse.json(await ticketTime(gate, loaded.ticket));
}

export async function POST(req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const loaded = await loadTicketFor(gate, (await ctx.params).number, "work");
  if (loaded instanceof NextResponse) return loaded;
  const body = (await req.json().catch(() => null)) as { minutes?: unknown; note?: unknown } | null;
  const minutes = cleanMinutes(body?.minutes);
  if (minutes === null) return NextResponse.json({ error: "Log between 1 minute and 24 hours." }, { status: 400 });
  const note = cleanNote(body?.note);
  if (note === null) return NextResponse.json({ error: "Keep the note under 300 characters." }, { status: 400 });
  const entry = await logTime(gate.id, loaded.ticket.id, minutes, note);
  await auditTime(req, gate, "helpdesk.time.logged", { type: "helpdesk_ticket", id: loaded.ticket.number, label: loaded.ticket.subject }, { entry: entry.id, minutes, source: "manual" });
  return NextResponse.json({ entry }, { status: 201 });
}
