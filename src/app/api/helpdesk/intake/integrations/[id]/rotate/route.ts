// POST /api/helpdesk/intake/integrations/<id>/rotate → { integration, key }
// Helpdesk 1.19.0 (agent P): a new API key, shown once; the old one stops
// working at once. Email integrations have no key (400). Audited:
// helpdesk.integration.key_rotated (the new key's prefix, never the key).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { intakeAdminGate } from "@/lib/helpdesk/intake/details";
import { rotateIntegrationKey } from "@/lib/helpdesk/intake/integrations";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await intakeAdminGate();
  if (gate instanceof NextResponse) return gate;
  const { id } = await ctx.params;
  const r = await rotateIntegrationKey(/^\d{1,10}$/.test(id) ? Number(id) : 0);
  if (r === undefined) return notFound();
  if (r === null) return badRequest("Email integrations have no API key.");
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.integration.key_rotated",
    targetType: "helpdesk_integration",
    targetId: r.integration.id,
    targetLabel: r.integration.name,
    details: { key_prefix: r.integration.token_prefix },
    ip: ipFrom(req),
  });
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
