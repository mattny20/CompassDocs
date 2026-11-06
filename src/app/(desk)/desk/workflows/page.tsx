// /desk/workflows with none open: what a workflow is, beside the rail.

import { Workflow } from "lucide-react";
import { EmptyState } from "@/components/form";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Workflows" };

export default function WorkflowsHome() {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <PageContainer>
        <PageHeader icon={<Workflow />} title="Workflows" subtitle="The steps a request goes through: approvals, tasks for each team, waits and notices." />
        <EmptyState
          icon={<Workflow />}
          title="Pick a workflow to see its steps"
          body="A request form starts a workflow when someone sends it. Change the steps here, try them with Test run, and publish when they're right."
        />
      </PageContainer>
    </div>
  );
}
