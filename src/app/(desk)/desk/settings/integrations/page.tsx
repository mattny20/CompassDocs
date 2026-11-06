// /desk/settings/integrations: monitoring tools, bots and automated mail
// that open tickets (agent P, lib/helpdesk/intake).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { IntegrationsList } from "@/components/helpdesk/desk/intake/IntegrationsList";
import { canOpenIntegrations } from "./access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenIntegrations(user))) return <DeskPageForbidden what="Integrations" />;
  return <IntegrationsList />;
}
