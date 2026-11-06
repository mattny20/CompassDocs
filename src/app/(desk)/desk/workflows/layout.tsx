// /desk/workflows: the workflow builder (helpdesk managers). The rail of
// workflows stays mounted while one is open beside it.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { WorkflowsLayout } from "@/components/helpdesk/desk/workflows/WorkflowsLayout";
import { canOpenSettings } from "../../desk-access";

export default async function WorkflowsRouteLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "workflows"))) return <DeskPageForbidden what="Workflows" />;
  return <WorkflowsLayout>{children}</WorkflowsLayout>;
}
