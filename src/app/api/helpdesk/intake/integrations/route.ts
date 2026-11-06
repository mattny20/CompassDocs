// GET  /api/helpdesk/intake/integrations → { integrations, teams }
// POST /api/helpdesk/intake/integrations { kind, name, default_team_id?, default_priority?,
//        severity_map?, dedup_window_minutes?, auto_resolve?, reopen_on_repeat?,
//        rate_limit_per_minute?, sender_addresses? (email), subject_dedup_pattern? (email),
//        allow_unverified_mail? (email) }
//        → { integration, key } (the key once: only its hash is kept; null for email)
// Helpdesk 1.19.0 (agent P). Desk capability channels.manage (or
// settings.manage). Audited: helpdesk.integration.created (never the key).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hq } from "@/lib/helpdesk/db-core";
import { badRequest } from "@/lib/helpdesk/routes";
import { intakeAdminGate } from "@/lib/helpdesk/intake/details";
import { createIntegration, IntegrationInputError, listIntegrations, validateIntegrationInput } from "@/lib/helpdesk/intake/integrations";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await intakeAdminGate();
  if (gate instanceof NextResponse) return gate;
  const [integrations, teams] = await Promise.all([
    listIntegrations(),
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, id"),
  ]);
  return NextResponse.json({ integrations, teams }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const gate = await intakeAdminGate();
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 32 * 1024);
  if (!body) return badRequest("Send a JSON object.");
  try {
    const input = validateIntegrationInput(body, { create: true });
    const { integration, key } = await createIntegration(input, gate.id);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.integration.created",
      targetType: "helpdesk_integration",
      targetId: integration.id,
      targetLabel: integration.name,
      details: { kind: integration.kind, team_id: integration.default_team_id, key_prefix: integration.token_prefix || null },
      ip: ipFrom(req),
    });
    return NextResponse.json({ integration, key }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof IntegrationInputError) return badRequest(e.message);
    throw e;
  }
}
