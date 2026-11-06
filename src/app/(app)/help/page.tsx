import { LifeBuoy } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { HelpGate } from "@/components/helpdesk/help/HelpGate";
import { HelpHome } from "@/components/helpdesk/help/HelpHome";
import { helpPageGuard } from "@/components/helpdesk/help/access";
import { IncidentBanners } from "@/components/helpdesk/help/IncidentBanners";
import { bannersFor } from "@/lib/helpdesk/incidents";

export const dynamic = "force-dynamic";
export const metadata = { title: "Get help" };

// Get help (1.19.0, Enterprise "helpdesk"): search the guides, pick a
// request type, follow your requests, decide the approvals waiting for you.
export default async function GetHelpPage() {
  const { user, access } = await helpPageGuard();
  // Open major incidents shown to this person (1.19.2, agent W1, lib/helpdesk/incidents).
  const incidents = access.licensed && access.canRequest ? await bannersFor(user).catch(() => []) : [];
  return (
    <PageContainer>
      <PageHeader
        icon={<LifeBuoy />}
        title="Get help"
        subtitle="Search our guides, or pick what you need. Requests with steps show you where they are at every stage."
      />
      <HelpGate access={access}>
        <IncidentBanners initial={incidents} />
        <HelpHome viewerName={user.name || user.username} />
      </HelpGate>
    </PageContainer>
  );
}
