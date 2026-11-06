// POST /api/helpdesk/incidents/[number]/updates   { body, solve? }
//        → { update: { id, sent_count } | null, skipped: [{ number, ok: false, error }],
//          solve: { results, incident } | null }. A linked ticket the poster
//          doesn't work, or can't reply on in its team, is skipped with the reason.
//        Posts an update to everyone affected (a public message on every
//        open linked ticket; hd_incident_update to their requesters, CCs and
//        the people who said Me too, each once; the Get help banner; the
//        Status page service when mirrored) and, with solve, solves the
//        linked tickets and the incident's own, each through the normal
//        solve path (a ticket that can't be solved stays open, with the
//        reason in results). The agent works the incident's ticket, holds
//        incidents.manage in its team and replies without review. An empty
//        body with solve only solves. Audited (helpdesk.incident.update_posted,
//        helpdesk.incident.solved).
// Helpdesk 1.19.2 (agent W1, lib/helpdesk/incidents).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { cleanUpdate, incidentErrorBody, postUpdate } from "@/lib/helpdesk/incidents";
import { parseTicketNumber } from "@/lib/helpdesk/tickets";
import { badRequest, notFound, originOf } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const number = parseTicketNumber((await params).number);
  if (!number) return notFound();
  if (hdRateLimited(`hd-incident-update:${gate.id}`, 10, 60_000)) return tooMany();
  const b = await readJson(req, 64 * 1024);
  if (!b) return badRequest("Send the update as JSON.");
  if (b.solve !== undefined && typeof b.solve !== "boolean") return badRequest("solve must be true or false.");
  try {
    const solve = b.solve === true;
    const body = cleanUpdate(b.body, { allowEmpty: solve });
    const r = await postUpdate(gate, number, { body, solve }, { origin: originOf(req) });
    void r.notices;
    if (r.update) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.incident.update_posted",
        targetType: "helpdesk_ticket",
        targetId: r.ticket_id,
        targetLabel: `#${number}`,
        // The text stays in hd_incident_updates (anonymised with the ticket), not in the audit log.
        details: { incident: number, update_id: r.update.id, sent_count: r.update.sent_count, length: body.length, skipped: r.skipped },
        ip: ipFrom(req),
      });
    }
    if (r.solve) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.incident.solved",
        targetType: "helpdesk_ticket",
        targetId: r.ticket_id,
        targetLabel: `#${number}`,
        details: {
          incident: number,
          incident_solved: r.solve.incident.ok,
          solved: r.solve.results.filter((x) => x.ok).map((x) => x.number),
          left_open: r.solve.results.filter((x) => !x.ok),
        },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ update: r.update, skipped: r.skipped, solve: r.solve });
  } catch (e) {
    const err = incidentErrorBody(e);
    if (err) return NextResponse.json(err.body, { status: err.status });
    throw e;
  }
}
