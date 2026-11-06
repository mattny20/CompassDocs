// GET /api/helpdesk/canned?ticket=1047   the canned responses an agent may insert, for the composer's picker
// Helpdesk 1.19.2 (agent W4). Any desk role: a canned response is only
// text, so using one needs no capability beyond working the ticket. Lists
// the workspace's, the agent's teams' (and the ticket's team's, when they
// work it) and their own personal ones; ticket_team_id orders the groups.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { getTicketByNumber, parseTicketNumber } from "@/lib/helpdesk/tickets";
import { pickerCanned } from "@/lib/helpdesk/canned";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const raw = new URL(req.url).searchParams.get("ticket");
  const n = raw ? parseTicketNumber(raw) : null;
  const ticket = n ? ((await getTicketByNumber(n)) ?? null) : null;
  const { items, ticketTeamId } = await pickerCanned(gate, ticket);
  return NextResponse.json({ canned: items, ticket_team_id: ticketTeamId }, { headers: { "Cache-Control": "no-store" } });
}
