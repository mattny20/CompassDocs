// /desk/settings/integrations/<id>: one integration (agent P): endpoint and
// key, test alert, settings, recent deliveries, turn off and delete.

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { IntegrationDetail } from "@/components/helpdesk/desk/intake/IntegrationDetail";
import { canOpenIntegrations } from "../access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integration" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await canOpenIntegrations(user))) return <DeskPageForbidden what="Integrations" />;
  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) notFound();
  return <IntegrationDetail id={Number(id)} />;
}
