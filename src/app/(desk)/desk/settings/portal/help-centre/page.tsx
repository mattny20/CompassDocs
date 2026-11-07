// /desk/settings/portal/help-centre: Customer portal → Help centre (1.19.4,
// C3, mock h2). Show a help centre, what's public, the categories' order,
// search engine indexing and the last 30 days. The layout checks
// settings.manage; so does /api/helpdesk/admin/portal/help-centre.

import { PortalHelpCentre } from "@/components/helpdesk/desk/settings/PortalHelpCentre";

export const dynamic = "force-dynamic";
export const metadata = { title: "Help centre · Customer portal" };

export default function Page() {
  return <PortalHelpCentre />;
}
