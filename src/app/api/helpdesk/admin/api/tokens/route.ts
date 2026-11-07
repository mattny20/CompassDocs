// POST /api/helpdesk/admin/api/tokens  { name, shown_as?, role, team_ids, expires_at: "YYYY-MM-DD" | null }
//   → 201 { token: "cdh_…", view }   The token is in this answer only; it is never stored or shown again.
// Desk settings → API and webhooks (1.19.4 C2). settings.manage; the role must be one the
// caller may hand out and the teams ones they work (lib/helpdesk/api-tokens).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { ApiTokenError, createApiToken, validateTokenInput } from "@/lib/helpdesk/api-tokens";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 8 * 1024);
  if (!b) return NextResponse.json({ error: "Send the token as JSON." }, { status: 400 });
  const creator = { ...actorFrom(gate), id: gate.id, role: gate.role, name: gate.name || gate.username };
  try {
    const input = await validateTokenInput(b, creator);
    const { token, view } = await createApiToken(input, creator, ipFrom(req));
    return NextResponse.json({ token, view }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof ApiTokenError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
