import { Stamp } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { HelpGate } from "@/components/helpdesk/help/HelpGate";
import { ApprovalsClient } from "@/components/helpdesk/help/ApprovalsClient";
import { helpPageGuard } from "@/components/helpdesk/help/access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approvals" };

// The requests waiting for this person's decision (1.19.0): as a manager
// from the directory, a member of an approving team, or someone a workflow
// names. The API lists only theirs.
export default async function ApprovalsPage() {
  const { access } = await helpPageGuard();
  return (
    <PageContainer>
      <Breadcrumbs className="mb-2" items={[{ href: "/help", label: "Get help" }]} />
      <PageHeader
        icon={<Stamp />}
        title="Approvals"
        subtitle="Requests from your team that need your decision. Approving moves them straight to the next step."
      />
      <HelpGate access={access}>
        <ApprovalsClient />
      </HelpGate>
    </PageContainer>
  );
}
