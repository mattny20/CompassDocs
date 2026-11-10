// /desk/settings/integrations: the Integrations hub (1.20.2). Everything the
// helpdesk connects to as tiles, each opening its own page under this one;
// the alert sources that used to be this page are at /alerts. Opens for the
// capability any of its pages needs (channels.manage or settings.manage);
// the tiles shown are the ones that person's role opens.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { IntegrationsHub } from "@/components/helpdesk/desk/integrations/IntegrationsHub";
import { canOpenIntegrations } from "./access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenIntegrations(user))) return <DeskPageForbidden what="Integrations" />;
  return <IntegrationsHub />;
}
