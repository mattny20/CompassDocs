// Helpdesk 1.19.0 reports (agent K): whose business hours a ticket's times
// are measured in. Business-time measures (first reply, resolution) count
// each ticket in its team's calendar: one lookup per team per report, then
// the pure, memoised BusinessClock per distinct set of hours.
//
// The hours are agent L's per-team calendars (lib/helpdesk/calendars
// hoursForTeam: the team's calendar, else the default one), looked up once
// per team per report. This is the only place the reports read hours from;
// the dates of a report are in the workspace helpdesk's time zone.
//
// Server-only.

import "server-only";
import { getBusinessHours } from "../settings";
import { hoursForTeam } from "../calendars";
import { vipMap } from "../contact-cards";
import type { HdBusinessHours } from "../types";
import { clockCache, type BusinessClock } from "./business-time";

let testHours: HdBusinessHours | null = null;
/** Tests: measure in these hours instead of the workspace's (no settings write). Null restores. */
export function setReportHoursForTests(h: HdBusinessHours | null): void {
  testHours = h;
}

/** Hours per team id (null = no team), for the teams a report touches. */
export async function hoursForTeams(teamIds: Iterable<number | null>): Promise<Map<number | null, HdBusinessHours>> {
  const out = new Map<number | null, HdBusinessHours>();
  const ids = new Set<number | null>([...teamIds, null]);
  if (testHours) {
    for (const id of ids) out.set(id, testHours);
    return out;
  }
  for (const id of ids) out.set(id, await hoursForTeam(id));
  return out;
}

/** A clock lookup by team for one report run. */
export async function clocksForTeams(teamIds: Iterable<number | null>): Promise<(teamId: number | null) => BusinessClock> {
  const hours = await hoursForTeams(teamIds);
  const clock = clockCache();
  const fallback = hours.get(null)!;
  return (teamId) => clock(hours.get(teamId) ?? fallback);
}

/** Which of these requesters are on today's VIP list (agent O's contact cards; current, not historical). */
export async function vipsAmong(userIds: number[]): Promise<number[]> {
  if (!userIds.length) return [];
  const map = await vipMap(userIds);
  return [...map].filter(([, v]) => v.vip).map(([id]) => id);
}

/** The zone a report's dates are in: the workspace helpdesk's. */
export async function reportTimezone(): Promise<string> {
  return (testHours ?? (await getBusinessHours())).timezone;
}
