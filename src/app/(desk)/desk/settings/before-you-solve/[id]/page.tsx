// /desk/settings/before-you-solve/[id]: one requirement set (1.20.5,
// lib/helpdesk/solve-requirements): its name and switch, what it applies to,
// the ticket fields it requires and its closing fields. Opens for a desk role
// holding settings.manage, exactly as the list does.

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { SolveRequirementSetDetail } from "@/components/helpdesk/desk/solve/SolveRequirementSetDetail";
import { canOpenSettings } from "../../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Requirement set" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "before-you-solve"))) return <DeskPageForbidden what="Before you solve" />;
  const raw = (await params).id;
  if (!/^\d{1,9}$/.test(raw)) notFound();
  return <SolveRequirementSetDetail id={Number(raw)} />;
}
