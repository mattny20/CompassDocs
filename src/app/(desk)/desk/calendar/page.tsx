// /desk/calendar: the desk's Calendar (1.20.6, lib/helpdesk/desk-calendar):
// the events tickets carry, by day, week or month. Agents only, as the
// queue: someone who holds only configuration or reports is sent to the part
// of the desk they can use. The view opens on what the address says
// (?view=week&date=2026-11-20&team=3), else on what the person chose last.
// The data loads from GET /api/helpdesk/calendar.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { CalendarPage } from "@/components/helpdesk/desk/calendar/CalendarPage";
import { firstSettingsHref } from "@/components/helpdesk/desk/settings/settings-nav";
import { getCalendarPrefs, viewerZone } from "@/lib/helpdesk/desk-calendar";
import { dayOf, HD_CALENDAR_VIEWS, parseDay, type HdCalendarView } from "@/lib/helpdesk/desk-calendar-shared";
import { deskAccess, deskRoleCaps } from "../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calendar" };

type Props = { searchParams: Promise<{ view?: string; date?: string; team?: string }> };

export default async function DeskCalendarPage({ searchParams }: Props) {
  const user = await requireUser();
  const access = await deskAccess(user);
  // Unlicensed or no desk permission: the layout already shows its gate instead of this page.
  if (!access.licensed || !access.any) return null;
  if (!access.agent) redirect(access.reports ? "/desk/reports" : firstSettingsHref((await deskRoleCaps(user)).caps));
  const [sp, prefs, tz] = await Promise.all([searchParams, getCalendarPrefs(user.id), viewerZone(user)]);
  const today = dayOf(Date.now(), tz);
  const view = HD_CALENDAR_VIEWS.includes(sp.view as HdCalendarView) ? (sp.view as HdCalendarView) : prefs.view;
  const team = Number(sp.team);
  return (
    <CalendarPage
      today={today}
      initial={{
        ...prefs,
        view,
        team_id: sp.team !== undefined && Number.isInteger(team) && team >= 0 ? team : prefs.team_id,
        day: parseDay(sp.date) ? (sp.date as string) : today,
      }}
    />
  );
}
