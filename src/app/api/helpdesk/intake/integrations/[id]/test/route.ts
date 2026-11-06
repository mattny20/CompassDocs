// POST /api/helpdesk/intake/integrations/<id>/test → { ok, outcome, ticket, results }
// Helpdesk 1.19.0 (agent P): "Send a test alert". A firing alert through the
// same pipeline a real one takes (team, priority, the hooks), tagged
// test-alert with a fresh dedup key, so it always opens a ticket. Works for
// a turned-off integration too (it tests the setup, not the tool).

import { NextResponse } from "next/server";
import { notFound } from "@/lib/helpdesk/routes";
import { originOf } from "@/lib/helpdesk/routes";
import { ipFrom } from "@/lib/audit";
import { intakeAdminGate } from "@/lib/helpdesk/intake/details";
import { getIntegration } from "@/lib/helpdesk/intake/integrations";
import { intakeLimited, processAlerts } from "@/lib/helpdesk/intake/intake";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await intakeAdminGate();
  if (gate instanceof NextResponse) return gate;
  const { id } = await ctx.params;
  const integration = await getIntegration(/^\d{1,10}$/.test(id) ? Number(id) : 0);
  if (!integration) return notFound();
  if (intakeLimited(`intake-test:${gate.id}`, 10)) return NextResponse.json({ error: "Too many test alerts. Try again in a minute." }, { status: 429 });
  const stamp = new Date().toISOString();
  const r = await processAlerts(
    integration,
    [
      {
        title: `Test alert from ${integration.name}`,
        description: `A test alert sent from Desk settings by ${gate.name || gate.username} at ${stamp}. Solve this ticket when you have seen it.`,
        description_format: "plain",
        severity: "warning",
        status: "firing",
        dedup_key: `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        source: "CompassDocs test",
        links: [],
        fields: { Test: "yes" },
      },
    ],
    { origin: originOf(req), ip: ipFrom(req), tags: ["test-alert"] }
  );
  return NextResponse.json(r.body, { status: r.status });
}
