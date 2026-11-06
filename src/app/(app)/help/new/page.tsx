import { LifeBuoy } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { HelpGate } from "@/components/helpdesk/help/HelpGate";
import { RequestForm } from "@/components/helpdesk/help/RequestForm";
import { helpPageGuard } from "@/components/helpdesk/help/access";
import { teamClosedMessage } from "@/components/helpdesk/help/closed-notice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Send a request" };

// The general request (1.19.0): "Send a request" under the guide search
// lands here with what the person typed as the subject.
export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ subject?: string }> }) {
  const [{ access }, { subject }] = await Promise.all([helpPageGuard(), searchParams]);
  // No team yet: the helpdesk's own hours decide.
  const closed = access.licensed ? await teamClosedMessage(null) : null;
  return (
    <PageContainer>
      {access.licensed ? (
        <RequestForm type={null} initialSubject={(subject ?? "").slice(0, 200)} closedNotice={closed} />
      ) : (
        <>
          <PageHeader icon={<LifeBuoy />} title="Send a request" />
          <HelpGate access={access}>{null}</HelpGate>
        </>
      )}
    </PageContainer>
  );
}
