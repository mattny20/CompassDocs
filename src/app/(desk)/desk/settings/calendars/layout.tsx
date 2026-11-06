// /desk/settings/calendars/* (1.19.0, agent L): business calendars. Office
// hours per calendar, holiday sets, and a due-time tester, as three pages
// under one header (STYLEGUIDE §Settings pages: a section with several jobs
// gets pages). For the desk capability sla.manage ("SLA and business
// hours"); the (desk) layout gates the licence first.

import { CalendarClock } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { CalendarsSubnav } from "@/components/helpdesk/desk/calendars/CalendarsSubnav";
import { deskAccess, deskRoleCaps } from "../../../desk-access";

export const dynamic = "force-dynamic";

export default async function CalendarsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [access, role] = await Promise.all([deskAccess(user), deskRoleCaps(user)]);
  if (!access.licensed) return null; // the (desk) layout shows the licence gate
  if (!role.can("sla.manage")) return <DeskPageForbidden what="Calendars" />;
  return (
    <PageContainer>
      <PageHeader
        icon={<CalendarClock />}
        title="Calendars"
        subtitle="Each team's office hours and holidays. Reply targets only count while a team is open."
        className="mb-4"
      />
      <CalendarsSubnav />
      {children}
    </PageContainer>
  );
}
