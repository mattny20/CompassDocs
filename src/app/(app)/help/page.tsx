import { LifeBuoy } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { HelpGate } from "@/components/helpdesk/help/HelpGate";
import { HelpHome } from "@/components/helpdesk/help/HelpHome";
import { helpPageGuard } from "@/components/helpdesk/help/access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Get help" };

// Get help (1.19.0, Enterprise "helpdesk"): search the guides, pick a
// request type, follow your requests, decide the approvals waiting for you.
export default async function GetHelpPage() {
  const { user, access } = await helpPageGuard();
  return (
    <PageContainer>
      <PageHeader
        icon={<LifeBuoy />}
        title="Get help"
        subtitle="Search our guides, or pick what you need. Requests with steps show you where they are at every stage."
      />
      <HelpGate access={access}>
        <HelpHome viewerName={user.name || user.username} />
      </HelpGate>
    </PageContainer>
  );
}
