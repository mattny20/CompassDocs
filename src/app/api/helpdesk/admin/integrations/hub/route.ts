// GET /api/helpdesk/admin/integrations/hub → { tiles: { [key]: { status, note } } }
// Helpdesk 1.20.2 (lib/helpdesk/integrations-hub): the Integrations hub's statuses. Only the
// tiles the caller may open are in the answer (each page's own capability: settings.manage;
// alert sources also channels.manage), so nobody learns the state of a page they can't reach.

import { NextResponse } from "next/server";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import { integrationsHub } from "@/lib/helpdesk/integrations-hub";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdAnyCapGate(["settings.manage", "channels.manage"]);
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ tiles: await integrationsHub(gate) });
}
