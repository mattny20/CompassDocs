// /desk/settings/teams/[id]: one team's settings (1.20.2: the Teams page is
// a list, each team has a page). Opens for a desk role that holds the Teams
// page's capability (SETTINGS_CAP in desk-access), exactly as the list does.

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { TeamDetail } from "@/components/helpdesk/desk/settings/TeamDetail";
import { canOpenSettings } from "../../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "teams"))) return <DeskPageForbidden what="Teams" />;
  const raw = (await params).id;
  if (!/^\d{1,9}$/.test(raw)) notFound();
  return <TeamDetail id={Number(raw)} />;
}
