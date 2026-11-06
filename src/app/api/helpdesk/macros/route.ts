// GET /api/helpdesk/macros   the macros an agent may use (everyone's, their teams', their own), for the composer
// Helpdesk 1.19.0 (macros.use, agent J's capability).

import { NextResponse } from "next/server";
import { agentTeamIds } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { MACRO_PLACEHOLDERS, listMacros } from "@/lib/helpdesk/macros";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("macros.use");
  if (gate instanceof NextResponse) return gate;
  const teams = await agentTeamIds(gate);
  const macros = (await listMacros(teams, gate.id)).map((m) => ({
    id: m.id,
    title: m.title,
    body: m.body,
    actions: m.actions,
    team_id: m.team_id,
    team_name: m.team_name,
    scope: m.scope,
  }));
  return NextResponse.json({ macros, placeholders: MACRO_PLACEHOLDERS }, { headers: { "Cache-Control": "no-store" } });
}
