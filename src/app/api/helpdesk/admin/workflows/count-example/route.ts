// GET /api/helpdesk/admin/workflows/count-example?team=3&offset=-2&kind=wait&field=Start%20date
//   → { example: { from, to, holidays, text } | null, team_name, timezone }
// Helpdesk 1.19.1 (desk capability workflows.manage): the builder's worked
// example for a step that counts business days, in the counting team's
// calendar (no team: the default calendar). "Start date Mon Jan 4 → moves
// on Tue Dec 29 (Dec 31 and Jan 1 are holidays)." Reads only.

import { NextResponse } from "next/server";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { hoursForTeam } from "@/lib/helpdesk/calendars";
import { countExample } from "@/lib/helpdesk/business-waits-shared";
import { hqOne } from "@/lib/helpdesk/db-core";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await hdCapGate("workflows.manage");
  if (gate instanceof NextResponse) return gate;
  const url = new URL(req.url);
  const teamRaw = Number(url.searchParams.get("team") || 0);
  const teamId = Number.isInteger(teamRaw) && teamRaw > 0 ? teamRaw : null;
  const offset = Number(url.searchParams.get("offset") || 0);
  if (!Number.isInteger(offset) || Math.abs(offset) > 365) return NextResponse.json({ error: "The days before or after are a whole number up to 365." }, { status: 400 });
  const kind = url.searchParams.get("kind") === "due" ? "due" : "wait";
  const fieldLabel = (url.searchParams.get("field") || "The date").trim().slice(0, 80) || "The date";
  const team = teamId ? await hqOne<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [teamId]) : undefined;
  if (teamId && !team) return NextResponse.json({ error: "That team no longer exists." }, { status: 404 });
  const hours = await hoursForTeam(teamId);
  return NextResponse.json({
    example: countExample(offset, hours, { fieldLabel, kind }),
    team_name: team?.name ?? null,
    timezone: hours.timezone,
  });
}
