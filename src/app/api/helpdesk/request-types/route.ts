// GET /api/helpdesk/request-types   the request types the caller may use (Get help's cards)
// Helpdesk 1.19.0 (helpdesk.request). Restricted types (visibility 'groups')
// appear only to members of their groups; switched-off types never.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { listRequestTypesForUser } from "@/lib/helpdesk/request-types";
import { listTeams } from "@/lib/helpdesk/teams";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const [types, teams] = await Promise.all([listRequestTypesForUser(gate), listTeams()]);
  return NextResponse.json({
    // The form travels with the type, so a card opens its form without a second request.
    request_types: types.map(({ group_ids: _g, ...t }) => t),
    teams: teams.map((t) => ({ id: t.id, name: t.name, description: t.description, icon: t.icon })),
  });
}
