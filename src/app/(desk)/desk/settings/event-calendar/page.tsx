// /desk/settings/event-calendar: Event calendar (desk settings, 1.20.6,
// lib/helpdesk/desk-calendar). Reminders about the events on tickets, the
// events whose setup was never marked, and the calendar feed links. Opens for
// a desk role holding settings.manage (SETTINGS_CAP in desk-access).
// (Not /desk/settings/calendars: those are the business-hours calendars.)

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { CalendarSettings } from "@/components/helpdesk/desk/calendar/CalendarSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Event calendar" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "event-calendar"))) return <DeskPageForbidden what="Event calendar" />;
  return <CalendarSettings />;
}
