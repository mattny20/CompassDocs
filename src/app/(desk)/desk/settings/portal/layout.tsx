// /desk/settings/portal/*: Customer portal (desk settings, Helpdesk 1.19.1;
// pages since 1.19.4, C3): Settings, Help centre and Customers under one
// header (STYLEGUIDE §Settings pages: a section with several jobs gets
// pages). Opens for a desk role holding settings.manage (every API behind
// these pages checks the same); the (desk) layout gates the licence first.

import { Globe } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { hdCan } from "@/lib/helpdesk/roles";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { PortalSubnav } from "@/components/helpdesk/desk/settings/PortalSubnav";

export const dynamic = "force-dynamic";

export default async function PortalSettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (!(await hdCan(user, "settings.manage").catch(() => false))) return <DeskPageForbidden what="Customer portal" />;
  return (
    <PageContainer>
      <PageHeader
        icon={<Globe />}
        title="Customer portal"
        subtitle="Let people outside your organisation raise and follow requests, without a CompassDocs account."
        className="mb-4"
      />
      <PortalSubnav />
      {children}
    </PageContainer>
  );
}
