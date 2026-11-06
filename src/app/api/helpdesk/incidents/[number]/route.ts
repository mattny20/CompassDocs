// PATCH /api/helpdesk/incidents/[number]   { title?, match_text?, banner?, notify_on_link?, status_service_id? }
//         → { changed }. [number] is the incident's own ticket. The agent
//         works that ticket and runs incidents in its team; a Status page
//         service also needs status.incident_manage. Audited
//         (helpdesk.incident.settings_changed) when something changed.
// Helpdesk 1.19.2 (agent W1, lib/helpdesk/incidents).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { incidentErrorBody, updateIncidentSettings, validateSettings } from "@/lib/helpdesk/incidents";
import { parseTicketNumber } from "@/lib/helpdesk/tickets";
import { badRequest, notFound, originOf } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const number = parseTicketNumber((await params).number);
  if (!number) return notFound();
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the changes as JSON.");
  try {
    const patch = validateSettings(b);
    const r = await updateIncidentSettings(gate, number, patch, { origin: originOf(req) });
    if (r.changed.length) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.incident.settings_changed",
        targetType: "helpdesk_ticket",
        // The incident's own ticket: anonymising it reaches this row (lib/helpdesk/retention).
        targetId: r.ticket_id,
        targetLabel: `#${number}`,
        details: { incident: number, changed: r.changed, before: r.before, after: patch },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ changed: r.changed });
  } catch (e) {
    const err = incidentErrorBody(e);
    if (err) return NextResponse.json(err.body, { status: err.status });
    throw e;
  }
}
