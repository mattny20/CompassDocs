// GET /api/helpdesk/tickets/[number]/assignment-log   → { entries: HdAssignmentLogEntry[], queued: {since, reason} | null }
// The ticket's assignment history (automatic and by hand), oldest first, and whether it is waiting in the
// queue for someone to become available. Helpdesk 1.19.0 (agent N). Agents who can work the ticket.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { loadTicketFor } from "@/lib/helpdesk/routes";
import { getTicketState, listLog } from "@/lib/helpdesk/assignment/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const loaded = await loadTicketFor(gate, (await ctx.params).number, "work");
  if (loaded instanceof NextResponse) return loaded;
  const [entries, state] = await Promise.all([listLog(loaded.ticket.id), getTicketState(loaded.ticket.id)]);
  const queued = state?.queued_since && !loaded.ticket.assignee_id ? { since: state.queued_since, reason: state.queued_reason } : null;
  return NextResponse.json({ entries, queued });
}
