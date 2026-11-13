// GET /api/helpdesk/calendar/prefs → { prefs: HdCalendarPrefs }
// PUT /api/helpdesk/calendar/prefs  { view?, team_id?, colour?, layers? } → { prefs }
//       What the caller last chose on the Calendar page: the view, the team filter, colour by team or status and
//       the layers switched on (1.20.6, lib/helpdesk/desk-calendar; kept per person). Agents (helpdesk.agent).

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { getCalendarPrefs, saveCalendarPrefs } from "@/lib/helpdesk/desk-calendar";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ prefs: await getCalendarPrefs(gate.id) });
}

export async function PUT(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 2 * 1024);
  if (!b) return badRequest("Send the choices as JSON.");
  return NextResponse.json({ prefs: await saveCalendarPrefs(gate.id, b) });
}
