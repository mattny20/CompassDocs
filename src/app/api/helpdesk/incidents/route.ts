// GET  /api/helpdesk/incidents?scope=nav|link   open major incidents
//        nav (default): those whose ticket the agent works (the queue's
//        "Major incidents" group); link: every open one (the link picker,
//        incidents.link).
// POST /api/helpdesk/incidents   { title, team_id, priority, numbers, match_text, banner, notify_on_link }
//        → 201 { id, number, linked }. Declares a major incident: a new
//        ticket for it, the chosen tickets linked (each checked on its own;
//        any refusal refuses all, with refusals: [{ number, reason }]).
//        incidents.manage in the team. Audited (helpdesk.incident.declared).
// Helpdesk 1.19.2 (agent W1, lib/helpdesk/incidents).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { declareIncident, incidentErrorBody, listOpenIncidents, validateDeclare } from "@/lib/helpdesk/incidents";
import { badRequest, originOf } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const scope = new URL(req.url).searchParams.get("scope") === "link" ? "link" : "nav";
  if (scope === "link" && !(await hdCan(gate, "incidents.link"))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  return NextResponse.json({ incidents: await listOpenIncidents(gate, scope) });
}

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (!(await hdCan(gate, "incidents.manage"))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  if (hdRateLimited(`hd-incident-declare:${gate.id}`, 10, 60_000)) return tooMany();
  const b = await readJson(req, 32 * 1024);
  if (!b) return badRequest("Send the incident as JSON.");
  try {
    const input = validateDeclare(b);
    const r = await declareIncident(gate, input, { origin: originOf(req) });
    void r.notices;
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.incident.declared",
      targetType: "helpdesk_ticket",
      targetId: r.ticket_id,
      targetLabel: `#${r.number} ${input.title}`.slice(0, 200),
      details: {
        incident: r.number,
        title: input.title,
        team_id: input.team_id,
        priority: input.priority,
        linked: r.linked,
        match_text: input.match_text,
        banner: input.banner,
        notify_on_link: input.notify_on_link,
      },
      ip: ipFrom(req),
    });
    return NextResponse.json({ id: r.id, number: r.number, linked: r.linked }, { status: 201 });
  } catch (e) {
    const err = incidentErrorBody(e);
    if (err) return NextResponse.json(err.body, { status: err.status });
    throw e;
  }
}
