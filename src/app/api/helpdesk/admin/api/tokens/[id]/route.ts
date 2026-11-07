// DELETE /api/helpdesk/admin/api/tokens/[id]   revoke now: the next call with it is a 401.
// Desk settings → API and webhooks (1.19.4 C2). settings.manage. Audited.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { revokeApiToken } from "@/lib/helpdesk/api-tokens";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const actor = { ...actorFrom(gate), name: gate.name || gate.username };
  if (!(await revokeApiToken(id, actor, ipFrom(req)))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
