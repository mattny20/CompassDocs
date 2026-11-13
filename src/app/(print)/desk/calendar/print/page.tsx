// The calendar on paper (1.20.6): /desk/calendar/print?view=day|week|month&date=YYYY-MM-DD[&team=][&layers=][&colour=].
// The Calendar page's Print opens it with ?print=1, so the browser's print dialog comes up once it has loaded;
// "Save as PDF" is the browser's own.
//
// Like the printed ticket it lives in the (print) route group, outside the desk shell: the paper starts at its
// corner and no desk chrome reaches it. It is still a desk page, so it does what the desk layout does first
// (sign-in, the forced password change, the licence) and shows only what the Calendar page would show this
// person: the events of tickets they may see (lib/helpdesk/desk-calendar calendarData).

import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireUser, currentPagePath } from "@/lib/auth";
import { safeReturnPath } from "@/lib/return-to";
import { getAppSettings } from "@/lib/settings-store";
import { formatDateTime, settingsForUser } from "@/lib/format";
import { helpdeskLicensed, isAgent } from "@/lib/helpdesk/access";
import { calendarData } from "@/lib/helpdesk/desk-calendar";
import { dayOf, HD_CALENDAR_VIEWS, parseDay, viewRange, viewTitle, zoneLabel, type HdCalendarLayer, type HdCalendarView } from "@/lib/helpdesk/desk-calendar-shared";
import { calendarItems, teamSlots } from "@/components/helpdesk/desk/calendar/calendar-model";
import { CalendarPrint, type CalendarPrintModel } from "@/components/helpdesk/desk/calendar/CalendarPrint";
import { PrintCalendarToolbar } from "@/components/helpdesk/desk/calendar/PrintCalendarToolbar";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ view?: string; date?: string; team?: string; layers?: string; colour?: string; print?: string }> };

export const metadata: Metadata = { title: "Print the calendar · Desk", robots: { index: false, follow: false } };

export default async function CalendarPrintPage({ searchParams }: Props) {
  const user = await requireUser("desk"); // a desk page outside the desk's layout, so it asks for the Duo desk rule itself
  if (user.must_change_password) {
    const back = safeReturnPath(await currentPagePath());
    redirect(back === "/" ? "/account/password" : `/account/password?next=${encodeURIComponent(back)}`);
  }
  if (!(await helpdeskLicensed()) || !(await isAgent(user))) notFound();
  const sp = await searchParams;
  const settings = settingsForUser(await getAppSettings(), user);
  const tz = settings.timezone;
  const view: HdCalendarView = HD_CALENDAR_VIEWS.includes(sp.view as HdCalendarView) ? (sp.view as HdCalendarView) : "week";
  const day = parseDay(sp.date) ? (sp.date as string) : dayOf(Date.now(), tz);
  const range = viewRange(view, day);
  const team = Number(sp.team);
  const layers = (sp.layers ?? "").split(",").filter((l): l is HdCalendarLayer => l === "due" || l === "recurring");
  const data = await calendarData(user, { from: range.from, to: range.to, tz, teamId: Number.isInteger(team) && team > 0 ? team : undefined, layers });
  const teamName = data.teams.find((t) => t.id === team)?.name;
  const model: CalendarPrintModel = {
    view,
    day,
    days: range.days,
    items: calendarItems(data),
    tz: data.timezone,
    h12: settings.time_format === "12h",
    colour: sp.colour === "status" ? "status" : "team",
    slots: teamSlots(data.teams),
    workspace: settings.company_name || "CompassDocs",
    scope: teamName ?? "All my teams",
    footer: `Printed by ${user.name || user.username} on ${formatDateTime(new Date().toISOString(), settings)}. Times are in ${zoneLabel(data.timezone)}.`,
    paper: settings.date_format === "us" ? "letter" : "a4",
    truncated: data.truncated,
  };
  const q = new URLSearchParams({ view, date: day });
  if (teamName) q.set("team", String(team));
  const what = view === "day" ? "A day sheet with a tick box for each event." : view === "week" ? `The week of ${viewTitle("week", day)}, one column a day.` : `${viewTitle("month", day)}, one cell a day.`;
  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-canvas outline-none print:bg-transparent">
      <CalendarPrint m={model} toolbar={<PrintCalendarToolbar back={`/desk/calendar?${q}`} what={what} landscape={view !== "day"} autoPrint={sp.print === "1"} />} />
    </main>
  );
}
