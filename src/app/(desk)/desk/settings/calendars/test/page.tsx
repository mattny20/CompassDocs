// /desk/settings/calendars/test: test a due time (agent L). See ../layout.
// ?team=<id> preselects a team (links from a team's settings).

import { DueTester } from "@/components/helpdesk/desk/calendars/DueTester";

export const metadata = { title: "Test a due time" };

export default async function DueTestPage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const team = Number((await searchParams).team);
  return <DueTester initialTeam={Number.isInteger(team) && team > 0 ? team : null} />;
}
