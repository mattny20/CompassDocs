// /desk/settings/integrations/api (until 1.20.2: /desk/settings/api): API tokens and outgoing webhooks (desk settings, 1.19.4 C2,
// mock-up g1). Opens for a desk role that holds settings.manage (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { ApiWebhooksSettings } from "@/components/helpdesk/desk/settings/ApiWebhooksSettings";
import { canOpenSettings } from "../../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "API and webhooks" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "api"))) return <DeskPageForbidden what="API and webhooks" />;
  return <ApiWebhooksSettings />;
}
