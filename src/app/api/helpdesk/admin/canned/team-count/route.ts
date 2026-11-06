// GET /api/helpdesk/admin/canned/team-count?team=12   → { count }
// Helpdesk 1.19.2 (agent W4). How many canned responses are shared with a
// team, for the Delete team dialog: they are deleted with the team.
// teams.manage, as the delete itself.

import { NextResponse } from "next/server";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { cannedCountForTeam } from "@/lib/helpdesk/canned";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await hdCapGate("teams.manage");
  if (gate instanceof NextResponse) return gate;
  const team = Number(new URL(req.url).searchParams.get("team"));
  if (!Number.isInteger(team) || team <= 0) return NextResponse.json({ error: "Say which team." }, { status: 400 });
  return NextResponse.json({ count: await cannedCountForTeam(team) }, { headers: { "Cache-Control": "no-store" } });
}
