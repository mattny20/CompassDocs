// /desk/settings/email-templates (1.19.0, agent H): the helpdesk's emails,
// composed from the same header, body, signature and footer libraries as
// Settings → Notifications → Email templates, filtered to the helpdesk
// events and their per-team variants. The /desk/settings layout (agent D)
// draws the rail and owns the scroll container.

import { MailPlus } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/form";
import { TemplatesSubNav } from "@/components/email-templates/TemplatesSubNav";
import { deskTemplatesAccess } from "./access";

export const dynamic = "force-dynamic";

const BASE = "/desk/settings/email-templates";

export default async function DeskEmailTemplatesLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const access = await deskTemplatesAccess(user);
  if (!access.licensed) return null; // the desk layout shows the licence gate
  return (
    <PageContainer>
      <PageHeader
        icon={<MailPlus />}
        title="Email templates"
        subtitle="Choose the header, body, signature and footer of each helpdesk email, for all teams or one team."
      />
      {access.open ? (
        <>
          <TemplatesSubNav base={BASE} />
          {children}
        </>
      ) : (
        <EmptyState
          icon={<MailPlus />}
          title="Email templates are for helpdesk admins"
          body="Ask a helpdesk admin to change what the helpdesk's emails say."
          action={{ href: "/desk", label: "Open the desk" }}
        />
      )}
    </PageContainer>
  );
}
