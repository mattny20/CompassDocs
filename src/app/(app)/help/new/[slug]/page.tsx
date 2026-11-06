import { FileQuestion, LifeBuoy } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyState } from "@/components/form";
import { HelpGate } from "@/components/helpdesk/help/HelpGate";
import { RequestForm } from "@/components/helpdesk/help/RequestForm";
import { helpPageGuard } from "@/components/helpdesk/help/access";
import { loadRequestForm } from "@/components/helpdesk/help/form-data";
import { teamClosedMessage } from "@/components/helpdesk/help/closed-notice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Request form" };

// One request type's form (1.19.0): its questions beside "What happens
// next", both resolved here for this person (form-data.ts). A type they may
// not use reads exactly like one that does not exist.
export default async function RequestTypeFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ user, access }, { slug }] = await Promise.all([helpPageGuard(), params]);
  const form = access.licensed ? await loadRequestForm(user, slug) : null;
  if (form) {
    // The answering team's office hours: a calm line when it is closed now.
    const closed = await teamClosedMessage(form.type.team_id);
    return (
      <PageContainer>
        <RequestForm type={form.type} nextSteps={form.nextSteps} defaults={form.defaults} closedNotice={closed} />
      </PageContainer>
    );
  }
  return (
    <PageContainer>
      <Breadcrumbs className="mb-2" items={[{ href: "/help", label: "Get help" }]} />
      <PageHeader icon={<LifeBuoy />} title="Request form" />
      <HelpGate access={access}>
        <EmptyState
          icon={<FileQuestion />}
          title="This form isn't available"
          body="It may have been retired, or it is for another team. Pick from the request types in Get help, or send a general request."
          action={{ href: "/help", label: "Back to Get help" }}
        />
      </HelpGate>
    </PageContainer>
  );
}
