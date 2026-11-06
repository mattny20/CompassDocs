// GET /api/helpdesk/agents?team=<id>   who a ticket can be assigned to: the
//   team's members (every team member without ?team), with availability.
//   → { agents: [{ user_id, name, email, team_ids, role_in_team, availability }] }
// Helpdesk 1.19.0 (helpdesk.agent).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { assignableAgents } from "@/lib/helpdesk/teams";
import { badRequest } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const raw = new URL(req.url).searchParams.get("team");
  const team = raw ? Number(raw) : null;
  if (raw && (!Number.isInteger(team) || (team as number) <= 0)) return badRequest("Unknown team.");
  return NextResponse.json({ agents: await assignableAgents(team) });
}
