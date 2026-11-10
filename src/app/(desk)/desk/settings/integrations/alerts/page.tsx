// /desk/settings/integrations/alerts: monitoring tools, bots and automated
// mail that open tickets (agent P, lib/helpdesk/intake). Until 1.20.2 this
// list was /desk/settings/integrations itself; each source keeps its
// address, /desk/settings/integrations/<id>.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { IntegrationsList } from "@/components/helpdesk/desk/intake/IntegrationsList";
import { canOpenIntegrations } from "../access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Alert sources" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenIntegrations(user))) return <DeskPageForbidden what="Integrations" />;
  return <IntegrationsList />;
}
