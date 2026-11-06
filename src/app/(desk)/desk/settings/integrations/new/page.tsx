// /desk/settings/integrations/new[?kind=grafana]: the create wizard (agent P).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { NewIntegration } from "@/components/helpdesk/desk/intake/NewIntegration";
import { isIntegrationKind } from "@/lib/helpdesk/intake/shared";
import { canOpenIntegrations } from "../access";

export const dynamic = "force-dynamic";
export const metadata = { title: "New integration" };

export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const user = await requireUser();
  if (!(await canOpenIntegrations(user))) return <DeskPageForbidden what="Integrations" />;
  const { kind } = await searchParams;
  return <NewIntegration initialKind={isIntegrationKind(kind) ? kind : null} />;
}
