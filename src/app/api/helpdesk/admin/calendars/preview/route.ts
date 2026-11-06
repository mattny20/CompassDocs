// POST /api/helpdesk/admin/calendars/preview
//        { calendar_id? | team_id?, start (ISO), minutes? | priority?, target?: "first_reply"|"resolve" }
//        → HdDuePreview { due, no_open_hours, summary, lines, timezone, calendar, target? }
//      "Test a due time": a team (its calendar and effective targets) or a
//      calendar, a start, and either minutes or a priority (the team's own
//      target when it has one, else the workspace's). Reads only.
// Helpdesk 1.19.0, agent L (sla.manage).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hoursForCalendar, hoursForTeam, slaPolicyForTeam } from "@/lib/helpdesk/calendars";
import { CALENDAR_LIMITS, explainDue, isPriorityKey } from "@/lib/helpdesk/calendars-shared";
import type { HdDuePreview } from "@/lib/helpdesk/calendars-shared";
import { hqOne } from "@/lib/helpdesk/db-core";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { calendarGate, idOf } from "../helpers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 4 * 1024);
  if (!b) return badRequest("Send the test as JSON.");
  const start = typeof b.start === "string" ? Date.parse(b.start) : NaN;
  if (!Number.isFinite(start)) return badRequest("Give a start time.");
  const teamId = b.team_id === undefined || b.team_id === null ? null : idOf(String(b.team_id));
  if (b.team_id != null && !teamId) return badRequest("Unknown team.");
  if (teamId && !(await hqOne("SELECT 1 FROM hd_teams WHERE id = $1", [teamId]))) return notFound();
  const calendarId = b.calendar_id == null ? null : idOf(String(b.calendar_id));
  if (b.calendar_id != null && !calendarId) return badRequest("Unknown calendar.");
  const hours = calendarId ? await hoursForCalendar(calendarId) : await hoursForTeam(teamId);
  if (!hours) return notFound();

  let minutes: number;
  let business = true;
  let target: HdDuePreview["target"];
  if (b.priority !== undefined && b.priority !== null && b.priority !== "") {
    if (!isPriorityKey(b.priority)) return badRequest("Unknown priority.");
    const policy = await slaPolicyForTeam(b.priority, teamId);
    if (!policy) return badRequest("There is no reply target for that priority yet.");
    const what = b.target === "resolve" ? "resolve" : "first_reply";
    minutes = what === "resolve" ? policy.resolve_minutes : policy.first_reply_minutes;
    business = policy.business_hours === 1;
    target = { priority: b.priority, minutes, business_hours: policy.business_hours, source: policy.source, what };
  } else {
    minutes = Number(b.minutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > CALENDAR_LIMITS.previewMinutes) return badRequest("Minutes are between 0 and a year.");
  }
  const e = explainDue(start, minutes, hours, business);
  const out: HdDuePreview = { ...e, calendar: hours.calendar ?? null, ...(target ? { target } : {}) };
  return NextResponse.json(out);
}
