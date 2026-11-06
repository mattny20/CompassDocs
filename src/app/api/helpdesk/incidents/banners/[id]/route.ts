// POST /api/helpdesk/incidents/banners/[id]   { affected: true | false }
//        → { banner }. "Me too" in Get help: counts the person as affected
//        by the incident (or takes it back) without raising a ticket; they
//        then hear its updates. Only for a banner this person is shown
//        (404 otherwise). 20 a minute. Audited when it changed
//        (helpdesk.incident.affected_added / affected_removed).
// Helpdesk 1.19.2 (agent W1, lib/helpdesk/incidents setAffected).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { incidentErrorBody, setAffected } from "@/lib/helpdesk/incidents";
import { badRequest, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).id;
  const id = /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
  if (!id) return notFound();
  if (hdRateLimited(`hd-incident-metoo:${gate.id}`, 20, 60_000)) return tooMany();
  const b = await readJson(req, 4 * 1024);
  if (!b || typeof b.affected !== "boolean") return badRequest("Send { affected: true } or { affected: false }.");
  try {
    const r = await setAffected(gate, id, b.affected);
    if (r.changed) {
      if (b.affected) {
        await audit({
          actor: actorFrom(gate),
          action: "helpdesk.incident.affected_added",
          targetType: "helpdesk_incident",
          targetId: id,
          targetLabel: r.banner.title.slice(0, 200),
          details: { incident_id: id },
          ip: ipFrom(req),
        });
      } else {
        await audit({
          actor: actorFrom(gate),
          action: "helpdesk.incident.affected_removed",
          targetType: "helpdesk_incident",
          targetId: id,
          targetLabel: r.banner.title.slice(0, 200),
          details: { incident_id: id },
          ip: ipFrom(req),
        });
      }
    }
    return NextResponse.json({ banner: r.banner });
  } catch (e) {
    const err = incidentErrorBody(e);
    if (err) return NextResponse.json(err.body, { status: err.status });
    throw e;
  }
}
