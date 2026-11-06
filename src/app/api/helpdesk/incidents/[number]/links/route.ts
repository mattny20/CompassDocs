// POST /api/helpdesk/incidents/[number]/links   { numbers: [1099, 1098] }
//        → { results: [{ number, ok, error? }], linked }. Links tickets to
//        the open incident whose ticket is [number]; each ticket is checked
//        on its own (the agent works it and holds incidents.link in its
//        team; not a workflow task, merged, closed, an incident, or linked
//        elsewhere) and the rest carry on. Audited once
//        (helpdesk.incident.linked) when any were linked.
// Unlinking is DELETE /api/helpdesk/incidents/ticket/[number].
// Helpdesk 1.19.2 (agent W1, lib/helpdesk/incidents).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { incidentErrorBody, linkTickets, validateNumbers } from "@/lib/helpdesk/incidents";
import { parseTicketNumber } from "@/lib/helpdesk/tickets";
import { badRequest, notFound, originOf } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const number = parseTicketNumber((await params).number);
  if (!number) return notFound();
  if (hdRateLimited(`hd-incident-link:${gate.id}`, 30, 60_000)) return tooMany();
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the tickets as JSON.");
  try {
    const numbers = validateNumbers(b.numbers);
    const r = await linkTickets(gate, number, numbers, { origin: originOf(req) });
    void r.notices;
    if (r.linked.length) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.incident.linked",
        targetType: "helpdesk_ticket",
        targetId: r.ticket_id,
        targetLabel: `#${number}`,
        details: { incident: number, linked: r.linked, skipped: r.results.filter((x) => !x.ok) },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ results: r.results, linked: r.linked });
  } catch (e) {
    const err = incidentErrorBody(e);
    if (err) return NextResponse.json(err.body, { status: err.status });
    throw e;
  }
}
