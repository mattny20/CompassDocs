// GET /api/helpdesk/intake/integrations/<id>/deliveries → { deliveries } (newest 50)
// Helpdesk 1.19.0 (agent P): what each POST or matched email became
// (created, updated, reopened, resolved, ignored, rejected) and why.

import { NextResponse } from "next/server";
import { notFound } from "@/lib/helpdesk/routes";
import { intakeAdminGate } from "@/lib/helpdesk/intake/details";
import { getIntegration, listDeliveries } from "@/lib/helpdesk/intake/integrations";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await intakeAdminGate();
  if (gate instanceof NextResponse) return gate;
  const { id } = await ctx.params;
  const integration = await getIntegration(/^\d{1,10}$/.test(id) ? Number(id) : 0);
  if (!integration) return notFound();
  return NextResponse.json({ deliveries: await listDeliveries(integration.id) }, { headers: { "Cache-Control": "no-store" } });
}
