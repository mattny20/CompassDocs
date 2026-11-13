// GET /api/helpdesk/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD[&team=<id>][&layers=due,recurring] → HdCalendarData
//       The desk's Calendar page (1.20.6, lib/helpdesk/desk-calendar): the events of tickets the caller may see
//       (their teams' and their own, as the queue) between two calendar days, inclusive, in the caller's own time
//       zone; with layers, also their tickets' due times and the tickets recurring schedules will open. At most 45
//       days at a time.
// Agents (helpdesk.agent).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { calendarData, EventError, viewerZone, type HdCalendarLayer } from "@/lib/helpdesk/desk-calendar";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const sp = new URL(req.url).searchParams;
  const layers = (sp.get("layers") ?? "").split(",").filter((l): l is HdCalendarLayer => l === "due" || l === "recurring");
  const team = Number(sp.get("team") ?? 0);
  try {
    const data = await calendarData(gate, {
      from: sp.get("from") ?? "",
      to: sp.get("to") ?? "",
      tz: await viewerZone(gate),
      teamId: Number.isInteger(team) && team > 0 ? team : undefined,
      layers,
    });
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof EventError) return badRequest(e.message);
    throw e;
  }
}
