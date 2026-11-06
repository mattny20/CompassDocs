// /desk/settings/assignment/* (1.19.0, agent N): how tickets find an owner.
// Teams (each team's mode, eligibility, capacity and people), Rules (the
// ordered rules that run first, for automations.manage) and On call (the
// rota), as pages under one header (STYLEGUIDE §Settings pages: a section
// with several jobs gets pages). Team pages are for agents.manage_team (a
// team's lead for their teams; teams.manage for every team); the (desk)
// layout gates the licence first.

import { Shuffle } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { AssignmentSubnav } from "@/components/helpdesk/desk/assignment/AssignmentSubnav";
import { deskAccess, deskRoleCaps } from "../../../desk-access";

export const dynamic = "force-dynamic";

export default async function AssignmentLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [access, role] = await Promise.all([deskAccess(user), deskRoleCaps(user)]);
  if (!access.licensed) return null; // the (desk) layout shows the licence gate
  const teams = role.can("agents.manage_team");
  const rules = role.can("automations.manage");
  if (!teams && !rules) return <DeskPageForbidden what="Assignment" />;
  return (
    <PageContainer>
      <PageHeader
        icon={<Shuffle />}
        title="Assignment"
        subtitle="How new tickets find an owner: by hand, in turn, or to whoever is least busy. Rules run first."
        className="mb-4"
      />
      <AssignmentSubnav teams={teams} rules={rules} />
      {children}
    </PageContainer>
  );
}
