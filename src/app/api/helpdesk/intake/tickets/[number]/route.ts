// GET /api/helpdesk/intake/tickets/<number> → HdAlertDetailsView
// Helpdesk 1.19.0 (agent P): the alert behind a ticket for the desk's
// AlertDetails panel (integration, firing/resolved, count, severity, links,
// fields). Agents who may work the ticket; anyone else gets 404.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { loadTicketFor } from "@/lib/helpdesk/routes";
import { alertDetailsFor } from "@/lib/helpdesk/intake/details";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const { number } = await ctx.params;
  const loaded = await loadTicketFor(gate, number, "work");
  if (loaded instanceof NextResponse) return loaded;
  return NextResponse.json(await alertDetailsFor(loaded.ticket.id), { headers: { "Cache-Control": "no-store" } });
}
