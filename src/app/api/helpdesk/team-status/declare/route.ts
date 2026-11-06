// GET /api/helpdesk/team-status/declare?service=ID&team=ID   → DeclarePrefill
//       W1's declare dialog, prefilled from a Status page service: the title,
//       suggested auto-link words from the service's name, and the team's
//       open tickets created since the service changed that mention them.
//       Needs W1's "Run major incidents" in the team (manageRefusal).
// Helpdesk 1.19.2 (agent W6, lib/helpdesk/status-teams).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { declarePrefill, StatusTeamsError } from "@/lib/helpdesk/status-teams";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const sp = new URL(req.url).searchParams;
  const service = Number(sp.get("service"));
  const team = Number(sp.get("team"));
  if (!Number.isInteger(service) || service <= 0 || !Number.isInteger(team) || team <= 0) return badRequest("service and team are required.");
  try {
    return NextResponse.json(await declarePrefill(gate, service, team));
  } catch (e) {
    if (e instanceof StatusTeamsError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
