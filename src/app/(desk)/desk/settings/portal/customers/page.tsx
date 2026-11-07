// /desk/settings/portal/customers: Customer portal → Customers (1.19.4, C3:
// a tab of its own, was a card under the settings). The people who have
// signed in to the portal or raised a request there, to block or unblock.
// The layout checks settings.manage; so does every API this page calls.

import { PortalContacts } from "@/components/helpdesk/desk/settings/PortalSettings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customers · Customer portal" };

export default function Page() {
  return <PortalContacts />;
}
