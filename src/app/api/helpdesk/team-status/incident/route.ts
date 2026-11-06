// POST /api/helpdesk/team-status/incident   { number, service_id, ask_solve }
//        → { ok }. After a major incident is declared from a Status page
//        service: watches it (hd_status_incident_watch only; W1's Status
//        page mirror is never set from here) and, with ask_solve, asks the
//        people who can run it to solve it with its linked tickets once the
//        service has recovered (never solved without a person). W1's "Run
//        major incidents" in the incident's team and status.read. Audited
//        (helpdesk.team_status.incident_watched).
// Helpdesk 1.19.2 (agent W6, lib/helpdesk/status-teams).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { badRequest, originOf } from "@/lib/helpdesk/routes";
import { StatusTeamsError, watchIncident } from "@/lib/helpdesk/status-teams";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-team-status-incident:${gate.id}`, 20, 60_000)) return tooMany();
  const b = await readJson<{ number?: unknown; service_id?: unknown; ask_solve?: unknown }>(req, 4 * 1024);
  if (!b) return badRequest("Send the incident as JSON.");
  const number = Number(b.number);
  const serviceId = Number(b.service_id);
  if (!Number.isInteger(number) || number <= 0 || !Number.isInteger(serviceId) || serviceId <= 0) return badRequest("number and service_id are required.");
  if (b.ask_solve !== undefined && typeof b.ask_solve !== "boolean") return badRequest("ask_solve must be true or false.");
  try {
    const r = await watchIncident(gate, number, serviceId, b.ask_solve === true, { origin: originOf(req) });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.team_status.incident_watched",
      targetType: "helpdesk_ticket",
      targetLabel: `#${number}`,
      details: { incident: number, service: r.service_name, ask_solve: b.ask_solve === true },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof StatusTeamsError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
