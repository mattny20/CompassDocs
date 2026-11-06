import { Inbox } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { HelpGate } from "@/components/helpdesk/help/HelpGate";
import { RequestList } from "@/components/helpdesk/help/RequestList";
import { helpPageGuard } from "@/components/helpdesk/help/access";

export const dynamic = "force-dynamic";
export const metadata = { title: "My requests" };

export default async function MyRequestsPage() {
  const { user, access } = await helpPageGuard();
  return (
    <PageContainer>
      <Breadcrumbs className="mb-2" items={[{ href: "/help", label: "Get help" }]} />
      <PageHeader icon={<Inbox />} title="My requests" subtitle="Everything you asked for, where it is, and every reply." />
      <HelpGate access={access}>
        <RequestList viewerName={user.name || user.username} />
      </HelpGate>
    </PageContainer>
  );
}
