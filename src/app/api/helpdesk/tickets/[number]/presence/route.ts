// GET    /api/helpdesk/tickets/[number]/presence   → { present: HdPresence[] }
//          the other agents with this ticket open (seen in the last 30 s)
// POST   /api/helpdesk/tickets/[number]/presence   { state: 'viewing'|'replying' }
//          the desk's heartbeat (every ~10 s while the tab is visible)
//          → { present: HdPresence[] } (the same list, so one call a beat)
// DELETE /api/helpdesk/tickets/[number]/presence   the ticket was closed → { ok }
// Helpdesk 1.19.1 collision warnings (agent V4, lib/helpdesk/presence).
// Agents who work the ticket only (the ticket GET's rule); anyone else gets
// the same 404 as a missing ticket, so requesters never see presence.
// Not audited: a heartbeat is not a change anyone acts on. 60 beats a
// minute per person.

import { NextResponse } from "next/server";
import { hdRateLimited, helpdeskGate, readJson, tooMany } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor } from "@/lib/helpdesk/routes";
import { leavePresence, othersPresent, touchPresence } from "@/lib/helpdesk/presence";
import { isPresenceState } from "@/lib/helpdesk/presence-shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

async function load(params: Ctx["params"]) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return { gate, ticket: found.ticket };
}

export async function GET(_req: Request, { params }: Ctx) {
  const ctx = await load(params);
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json({ present: await othersPresent(ctx.ticket.id, ctx.gate.id) });
}

export async function POST(req: Request, { params }: Ctx) {
  const ctx = await load(params);
  if (ctx instanceof NextResponse) return ctx;
  if (hdRateLimited(`hd-presence:${ctx.gate.id}`, 60, 60_000)) return tooMany();
  const b = await readJson(req, 1024);
  if (!b || !isPresenceState(b.state)) return badRequest("state is viewing or replying.");
  await touchPresence(ctx.ticket.id, ctx.gate.id, b.state);
  return NextResponse.json({ present: await othersPresent(ctx.ticket.id, ctx.gate.id) });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const ctx = await load(params);
  if (ctx instanceof NextResponse) return ctx;
  await leavePresence(ctx.ticket.id, ctx.gate.id);
  return NextResponse.json({ ok: true });
}
